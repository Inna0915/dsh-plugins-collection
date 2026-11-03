import { randomUUID } from "node:crypto";
import { ConfluenceClient, ConfluenceError } from "../core/confluence.js";
import type { PageInfo, PageNode } from "../types.js";
import {
  dataFile,
  hash,
  jsonRead,
  jsonWrite,
  message,
  validId,
  withLock,
} from "./store.js";
import { invalidateReadCache } from "./reading.js";

/** 单次删除的页面上限（含根页）；更大的树请分支删除或在 Confluence 界面操作。 */
export const MAX_DELETE_PAGES = 100;
const PLAN_TTL = 30 * 60_000;
const RECENT = 7 * 24 * 60 * 60_000;

export interface DeleteNode {
  id: string;
  title: string;
  parentId: string;
  depth: number;
  version: number;
  children: number;
  updated?: string;
  modifier?: string;
  modifierKey?: string;
  canDelete?: boolean;
}
interface Brief {
  id: string;
  title: string;
  url: string;
}
interface DeletePlan {
  token: string;
  profile: string;
  host: string;
  createdAt: string;
  expiresAt: string;
  root: Brief & { spaceKey: string };
  parent?: Brief;
  /** true 时只删除子页面，pages 不含根页。 */
  keepRoot: boolean;
  pages: DeleteNode[];
  fingerprint: string;
}
/** 交给授权方的删除摘要（id/title 为根页），用于弹窗文字、终端确认和核对用户消息。 */
export interface DeleteTarget {
  id: string;
  title: string;
  url: string;
  spaceKey: string;
  /** 将删除的页面数。 */
  count: number;
  keepRoot: boolean;
}
export interface DeleteAuthorization {
  method: "explicit" | "approved" | "host" | "terminal";
  detail?: string;
}
/** 授权失败时抛出异常；此时尚未写入删除记录，也没有删除任何页面。 */
export type DeleteAuthorizer = (
  target: DeleteTarget,
) => Promise<DeleteAuthorization>;
export interface DeleteInput {
  page: string;
  token: string;
  title: string;
  count: number;
  requestId: string;
}

type DeleteState = "pending" | "deleting" | "trashed" | "failed" | "unknown";
type DeletePage = DeleteNode & { state: DeleteState; error?: string };
interface DeleteRecord {
  kind: "delete";
  requestId: string;
  profile: string;
  host: string;
  token: string;
  createdAt: string;
  authorization: DeleteAuthorization["method"];
  root: Brief & { spaceKey: string };
  parent?: Brief;
  keepRoot: boolean;
  status: "pending" | "complete" | "failed" | "unknown";
  pages: DeletePage[];
  result?: unknown;
  error?: string;
}
type RestoreState =
  | "pending"
  | "restoring"
  | "restored"
  | "skipped"
  | "failed"
  | "unknown";
interface RestorePage {
  id: string;
  title: string;
  parentId: string;
  depth: number;
  state: RestoreState;
  note?: string;
  error?: string;
}
interface RestoreRecord {
  kind: "restore";
  requestId: string;
  profile: string;
  host: string;
  deleteRequestId: string;
  status: "pending" | "complete" | "failed" | "unknown";
  pages: RestorePage[];
  result?: unknown;
  error?: string;
}

const brief = (node: PageNode): Brief => ({
  id: node.id,
  title: node.title,
  url: node.url,
});
function writable(client: ConfluenceClient) {
  if (!client.profile.allowWrites) {
    throw new Error("此连接尚未启用写入，请在连接设置启用");
  }
}
const rejected = (error: unknown) =>
  error instanceof ConfluenceError && error.status >= 400 && error.status < 500;

/**
 * 深度优先（先序）列出要删除的页面：根页及全部子孙；keepRoot 时不含根页。超过上限立即停止。
 */
async function subtree(
  client: ConfluenceClient,
  reference: string,
  keepRoot: boolean,
) {
  const root = await client.node(reference);
  const pages: DeleteNode[] = [];
  const seen = new Set<string>();
  const limit = MAX_DELETE_PAGES + (keepRoot ? 1 : 0);
  const visit = async (node: PageInfo, parentId: string, depth: number) => {
    if (seen.has(node.id)) {
      throw new Error("页面树出现重复节点，已停止");
    }
    seen.add(node.id);
    if (pages.length >= limit) {
      throw new Error(
        `子树超过 ${MAX_DELETE_PAGES} 页，请先分支删除，或在 Confluence 界面操作`,
      );
    }
    const entry: DeleteNode = {
      id: node.id,
      title: node.title,
      parentId,
      depth,
      version: node.version,
      children: 0,
      updated: node.updated,
      modifier: node.modifier,
      modifierKey: node.modifierKey,
      canDelete: node.canDelete,
    };
    pages.push(entry);
    const children = await client.childPages(node.id);
    entry.children = children.length;
    for (const child of children) {
      await visit(child, node.id, depth + 1);
    }
  };
  await visit(root, root.ancestorIds.at(-1) || "", 0);
  if (keepRoot && pages.length === 1) {
    throw new Error("该页面没有子页面，无需删除");
  }
  return { root, pages: keepRoot ? pages.slice(1) : pages };
}

/**
 * 拒绝删除空间首页、连接配置的浏览根页和发布位置，以及当前账号没有删除权限的页面。
 * 权限在删除前整体检查：任何一页不能删就一页都不删，避免自下而上删到一半停住。
 */
async function guard(
  client: ConfluenceClient,
  root: PageNode,
  pages: DeleteNode[],
) {
  const ids = new Set(pages.map((page) => page.id));
  const hits = [
    ...client.profile.rootPageIds.map((id) => [id, "浏览根页"]),
    ...Object.entries(client.profile.targets).map(([name, id]) => [
      id,
      `发布位置“${name}”`,
    ]),
  ].filter(([id]) => ids.has(id));
  if (hits.length) {
    throw new Error(
      `删除范围包含连接配置的${hits.map(([id, label]) => `${label}（${id}）`).join("、")}，拒绝删除；确需删除请先修改连接设置`,
    );
  }
  const home = await client.homepageId(root.spaceKey);
  if (home && ids.has(home)) {
    throw new Error("子树包含空间首页，拒绝删除");
  }
  const denied = pages.filter((page) => page.canDelete === false);
  if (denied.length) {
    const names = denied
      .slice(0, 10)
      .map((page) => `《${page.title}》（${page.id}）`)
      .join("、");
    throw new Error(
      `当前账号对其中 ${denied.length}/${pages.length} 页没有删除权限：${names}${denied.length > 10 ? " 等" : ""}。未删除任何页面；请由页面作者或有删除权限的人员处理，或缩小删除范围`,
    );
  }
}
// 页面增减、移动或任何修改（版本变化）都会改变指纹。
const fingerprint = (pages: DeleteNode[]) =>
  hash(
    JSON.stringify(
      pages
        .map((page) => `${page.id}:${page.parentId}:${page.version}`)
        .sort(),
    ),
  );

/**
 * 删除预览只读：列出根页连同全部子页面（keepRoot 时只列子页面），标出他人近 7 天修改过的页面，
 * 并保存 30 分钟有效的令牌。令牌绑定这组页面及其版本，提交时页面有任何变化都会拒绝。
 */
export async function previewDelete(
  client: ConfluenceClient,
  reference: string,
  keepRoot = false,
) {
  const { root, pages } = await subtree(client, reference, keepRoot);
  await guard(client, root, pages);
  const me = await client.currentUser();
  const parentId = root.ancestorIds.at(-1);
  const parent = parentId ? brief(await client.node(parentId)) : undefined;
  const cutoff = Date.now() - RECENT;
  const byOthers = (page: DeleteNode) =>
    Date.parse(page.updated || "") >= cutoff &&
    !!page.modifierKey &&
    page.modifierKey !== me.username &&
    page.modifierKey !== me.userKey;
  const now = Date.now();
  const plan: DeletePlan = {
    token: randomUUID(),
    profile: client.profile.id,
    host: client.profile.host,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PLAN_TTL).toISOString(),
    root: { ...brief(root), spaceKey: root.spaceKey },
    parent,
    keepRoot,
    pages,
    fingerprint: fingerprint(pages),
  };
  await jsonWrite(dataFile("delete-plans", plan.token), plan);
  const recent = pages.filter(byOthers);
  return {
    status: "preview",
    token: plan.token,
    expiresAt: plan.expiresAt,
    root: plan.root,
    parent,
    keepRoot,
    count: pages.length,
    maxDepth: Math.max(...pages.map((page) => page.depth)),
    recentByOthers: recent.map((page) => ({
      id: page.id,
      title: page.title,
      modifier: page.modifier,
      updated: page.updated,
    })),
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      depth: page.depth,
      version: page.version,
      updated: page.updated,
      modifier: page.modifier,
    })),
    message: `预览未删除。请向用户说明${keepRoot ? `将删除《${root.title}》下的子页面（保留该页面本身）` : `将删除《${root.title}》连同子页面`}、共 ${pages.length} 页${recent.length ? `、其中 ${recent.length} 页近期由他人修改` : ""}；确认后调用 confluence_flow_delete，携带 page、token、title（根页标题）、count 与稳定 requestId。页面只移到回收站，从最深层逐页删除。`,
  };
}

async function loadPlan(client: ConfluenceClient, token: string) {
  let plan: DeletePlan;
  try {
    plan = await jsonRead<DeletePlan>(dataFile("delete-plans", token));
  } catch {
    throw new Error("删除令牌无效或已清理，请重新 delete-preview");
  }
  if (plan.profile !== client.profile.id || plan.host !== client.profile.host) {
    throw new Error("删除令牌不属于当前连接，请重新 delete-preview");
  }
  if (Date.parse(plan.expiresAt) < Date.now()) {
    throw new Error("删除令牌已超过 30 分钟，请重新 delete-preview");
  }
  return plan;
}
function deleteStatus(pages: DeletePage[]): DeleteRecord["status"] {
  if (pages.every((page) => page.state === "trashed")) {
    return "complete";
  }
  if (pages.some((page) => ["deleting", "unknown"].includes(page.state))) {
    return "unknown";
  }
  return pages.some((page) => page.state === "failed") ? "failed" : "pending";
}

/**
 * 按预览令牌删除子树：先核对 title/count，再交给授权方（弹窗、用户消息或终端确认），
 * 授权后重新列出子树，与预览不一致即拒绝。删除自最深层逐页进行，每页发送前记 deleting：
 * 服务器明确拒绝记 failed、回执不明记 unknown，均立即停止且不自动重发；记录保存在 operations。
 */
export async function applyDelete(
  client: ConfluenceClient,
  input: DeleteInput,
  authorize: DeleteAuthorizer,
  signal?: AbortSignal,
) {
  writable(client);
  const operationId = `${client.profile.id}-${validId(input.requestId)}`;
  const file = dataFile("operations", operationId);
  validId(input.token);
  return withLock(`submit-${hash(operationId).slice(0, 32)}`, async () => {
    const rootId = await client.resolve(input.page);
    const previous = await jsonRead<DeleteRecord | null>(file, null);
    if (previous) {
      if (
        previous.kind !== "delete" ||
        previous.profile !== client.profile.id ||
        previous.root.id !== rootId ||
        previous.token !== input.token
      ) {
        throw new Error("此 requestId 已用于其他内容，请使用新的请求标识");
      }
      if (previous.host !== client.profile.host) {
        throw new Error("连接地址已改变，请核实原删除记录");
      }
      if (previous.status === "complete") {
        return previous.result;
      }
      throw new Error(
        `请求已有记录：${previous.status}。先用 operation-status 查看逐页状态并核实页面，不要重新提交。`,
      );
    }
    const plan = await loadPlan(client, input.token);
    if (plan.root.id !== rootId) {
      throw new Error("token 与 page 不是同一次预览，请重新 delete-preview");
    }
    if (plan.root.title !== input.title || plan.pages.length !== input.count) {
      throw new Error(
        `title/count 与预览不一致：预览为根页《${plan.root.title}》、删除 ${plan.pages.length} 页`,
      );
    }
    const authorization = await authorize({
      ...plan.root,
      count: plan.pages.length,
      keepRoot: plan.keepRoot,
    });
    const fresh = await subtree(client, rootId, plan.keepRoot);
    await guard(client, fresh.root, fresh.pages);
    if (fingerprint(fresh.pages) !== plan.fingerprint) {
      throw new ConfluenceError(
        409,
        "预览后子树已变化（页面增减、移动或被修改），未删除任何页面；请重新 delete-preview 并再次确认",
      );
    }
    const record: DeleteRecord = {
      kind: "delete",
      requestId: input.requestId,
      profile: client.profile.id,
      host: client.profile.host,
      token: input.token,
      createdAt: new Date().toISOString(),
      authorization: authorization.method,
      root: plan.root,
      parent: plan.parent,
      keepRoot: plan.keepRoot,
      status: "pending",
      pages: plan.pages.map((page) => ({ ...page, state: "pending" })),
    };
    // 进行中为 pending；中途停止（如取消）而没有失败页时，结束时记为 failed。
    const save = async (status = deleteStatus(record.pages)) => {
      record.status = status;
      await jsonWrite(file, record);
    };
    await jsonWrite(file, record);
    let stopped: string | undefined;
    // 稳定排序：同层保持先序，自最深层开始，父页总在其子页之后删除。
    for (const page of [...record.pages].sort((a, b) => b.depth - a.depth)) {
      if (signal?.aborted) {
        stopped = "操作已取消";
        break;
      }
      if (page.children) {
        try {
          const left = await client.childPages(page.id);
          if (left.length) {
            throw new Error(
              `出现预览之外的子页面：${left.map((row) => row.title).join("、")}`,
            );
          }
        } catch (error) {
          page.state = "failed";
          page.error = message(error);
          await save();
          stopped = page.error;
          break;
        }
      }
      page.state = "deleting";
      await save();
      try {
        await client.trash(page.id);
        page.state = "trashed";
      } catch (error) {
        page.error = message(error);
        if (error instanceof ConfluenceError && error.status === 404) {
          // 已不存在：确认是在回收站（可能被他人删除）才算完成，否则结果不明。
          const status = await client
            .contentStatus(page.id)
            .catch(() => "unknown");
          page.state = status === "trashed" ? "trashed" : "unknown";
        } else {
          page.state = rejected(error) ? "failed" : "unknown";
        }
        if (page.state === "trashed") {
          delete page.error;
        }
      }
      await save();
      if (page.state !== "trashed") {
        stopped = `《${page.title}》${page.error}`;
        break;
      }
    }
    const trashed = record.pages.filter((page) => page.state === "trashed");
    await Promise.all(
      trashed.map((page) =>
        invalidateReadCache(client.profile, page.id).catch(() => undefined),
      ),
    );
    const summary = {
      requestId: input.requestId,
      root: plan.root,
      parent: plan.parent,
      keepRoot: plan.keepRoot,
      count: record.pages.length,
      deleted: trashed.length,
      authorization: authorization.method,
    };
    if (record.status === "complete") {
      record.result = {
        status: "complete",
        ...summary,
        message: `${plan.keepRoot ? `已把《${plan.root.title}》下的 ${trashed.length} 个页面移到回收站，该页面本身保留` : trashed.length > 1 ? `已把《${plan.root.title}》连同子页面共 ${trashed.length} 页移到回收站` : `已把《${plan.root.title}》移到回收站`}。需要找回时用 restore + deleteRequestId（通常需要空间管理员权限）。`,
      };
      try {
        await jsonWrite(file, record);
      } catch {
        return {
          ...(record.result as object),
          warning: "页面已删除，但本地回执保存失败；不要重新提交。",
        };
      }
      return record.result;
    }
    record.error = stopped;
    const final = deleteStatus(record.pages);
    await save(final === "pending" ? "failed" : final);
    throw new Error(
      `已删除 ${trashed.length}/${record.pages.length} 页后停止：${stopped}；删除状态 ${record.status}，requestId=${input.requestId}。用 operation-status 查看逐页状态${trashed.length ? "，需要时用 restore 恢复已删除的页面" : ""}${record.status === "unknown" ? "；结果不明，禁止自动重发" : ""}`,
    );
  });
}

async function deleteRecord(client: ConfluenceClient, deleteRequestId: string) {
  const record = await jsonRead<DeleteRecord | null>(
    dataFile("operations", `${client.profile.id}-${validId(deleteRequestId)}`),
    null,
  );
  if (!record || record.kind !== "delete") {
    throw new Error("没有找到这个删除记录（删除回执保留 30 天）");
  }
  if (record.host !== client.profile.host) {
    throw new Error("连接地址已改变，不能按原删除记录恢复");
  }
  // 结果不明的页面也可能已在回收站，交给恢复时按服务器状态判断。
  return record.pages
    .filter((page) => ["trashed", "deleting", "unknown"].includes(page.state))
    .sort((a, b) => a.depth - b.depth);
}

/** 恢复预览只读：按删除记录自上而下列出页面及其当前状态（trashed / current / missing）。 */
export async function previewRestore(
  client: ConfluenceClient,
  deleteRequestId: string,
) {
  const pages = await deleteRecord(client, deleteRequestId);
  const rows = [];
  for (const page of pages) {
    rows.push({
      id: page.id,
      title: page.title,
      depth: page.depth,
      parentId: page.parentId,
      status: await client.contentStatus(page.id),
    });
  }
  return {
    status: "preview",
    deleteRequestId,
    count: rows.length,
    restorable: rows.filter((row) => row.status === "trashed").length,
    pages: rows,
    message:
      "预览未恢复。使用相同 deleteRequestId 加 apply=true 与新的稳定 requestId 恢复；自上而下恢复并放回原父页。恢复回收站页面通常需要空间管理员权限。",
  };
}
function restoreStatus(pages: RestorePage[]): RestoreRecord["status"] {
  if (pages.every((page) => ["restored", "skipped"].includes(page.state))) {
    return "complete";
  }
  if (pages.some((page) => ["restoring", "unknown"].includes(page.state))) {
    return "unknown";
  }
  return pages.some((page) => page.state === "failed") ? "failed" : "pending";
}

/**
 * 按删除记录从回收站恢复：父页先于子页，逐页把状态改回 current，恢复后若不在原父页下则移回。
 * 已不在回收站的页面跳过；服务器拒绝或回执不明时停止，不自动重发。
 */
export async function applyRestore(
  client: ConfluenceClient,
  deleteRequestId: string,
  requestId: string,
  signal?: AbortSignal,
) {
  writable(client);
  if (requestId === deleteRequestId) {
    throw new Error("恢复需要新的 requestId，不能沿用删除的 requestId");
  }
  const operationId = `${client.profile.id}-${validId(requestId)}`;
  const file = dataFile("operations", operationId);
  return withLock(`submit-${hash(operationId).slice(0, 32)}`, async () => {
    const previous = await jsonRead<RestoreRecord | null>(file, null);
    if (previous) {
      if (
        previous.kind !== "restore" ||
        previous.profile !== client.profile.id ||
        previous.deleteRequestId !== deleteRequestId
      ) {
        throw new Error("此 requestId 已用于其他内容，请使用新的请求标识");
      }
      if (previous.status === "complete") {
        return previous.result;
      }
      throw new Error(
        `请求已有记录：${previous.status}。先用 operation-status 查看逐页状态并核实页面，不要重新提交。`,
      );
    }
    const record: RestoreRecord = {
      kind: "restore",
      requestId,
      profile: client.profile.id,
      host: client.profile.host,
      deleteRequestId,
      status: "pending",
      pages: (await deleteRecord(client, deleteRequestId)).map((page) => ({
        id: page.id,
        title: page.title,
        parentId: page.parentId,
        depth: page.depth,
        state: "pending",
      })),
    };
    if (!record.pages.length) {
      throw new Error("删除记录中没有已删除的页面");
    }
    const save = async (status = restoreStatus(record.pages)) => {
      record.status = status;
      await jsonWrite(file, record);
    };
    await jsonWrite(file, record);
    let stopped: string | undefined;
    for (const page of record.pages) {
      if (signal?.aborted) {
        stopped = "操作已取消";
        break;
      }
      let trashed;
      try {
        trashed = await client.trashedPage(page.id);
        if (!trashed) {
          const status = await client.contentStatus(page.id);
          if (status === "current") {
            page.state = "skipped";
            page.note = "页面已不在回收站（当前可用）";
            await save();
            continue;
          }
          throw new Error("回收站中找不到该页面，可能已被永久清除");
        }
      } catch (error) {
        page.state = "failed";
        page.error = message(error);
        await save();
        stopped = `《${page.title}》${page.error}`;
        break;
      }
      page.state = "restoring";
      await save();
      try {
        await client.restore(page.id, trashed.title, trashed.version);
        page.state = "restored";
      } catch (error) {
        page.state = rejected(error) ? "failed" : "unknown";
        page.error =
          error instanceof ConfluenceError && error.status === 403
            ? "没有恢复权限（恢复回收站页面通常需要空间管理员）"
            : message(error);
        await save();
        stopped = `《${page.title}》${page.error}`;
        break;
      }
      // 恢复位置因版本而异：不在原父页下时移回，失败只记说明，不影响已完成的恢复。
      try {
        const node = await client.node(page.id);
        if (page.parentId && node.ancestorIds.at(-1) !== page.parentId) {
          await client.move(await client.get(page.id), page.parentId);
          page.note = "已移回原父页面";
        }
      } catch (error) {
        page.note = `已恢复，但未能放回原父页面：${message(error)}`;
      }
      await invalidateReadCache(client.profile, page.id).catch(() => undefined);
      await save();
    }
    const restored = record.pages.filter((page) => page.state === "restored");
    const summary = {
      requestId,
      deleteRequestId,
      count: record.pages.length,
      restored: restored.length,
      skipped: record.pages.filter((page) => page.state === "skipped").length,
      notes: record.pages
        .filter((page) => page.note)
        .map((page) => ({ id: page.id, title: page.title, note: page.note })),
    };
    if (record.status === "complete") {
      record.result = { status: "complete", ...summary };
      await jsonWrite(file, record).catch(() => undefined);
      return record.result;
    }
    record.error = stopped;
    const final = restoreStatus(record.pages);
    await save(final === "pending" ? "failed" : final);
    throw new Error(
      `已恢复 ${restored.length}/${record.pages.length} 页后停止：${stopped}；恢复状态 ${record.status}，requestId=${requestId}。用 operation-status 查看逐页状态${record.status === "unknown" ? "；结果不明，禁止自动重发" : ""}`,
    );
  });
}
