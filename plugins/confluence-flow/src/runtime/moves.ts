import { ConfluenceClient, ConfluenceError } from "../core/confluence.js";
import type { Page, PageNode } from "../types.js";
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

interface MoveRecord {
  kind: "move";
  requestId: string;
  profile: string;
  host: string;
  pageId: string;
  parentId: string;
  status: "pending" | "complete" | "failed" | "unknown";
  result?: unknown;
  error?: string;
}
interface MovePlan {
  page: Page;
  from?: PageNode;
  to: PageNode;
  changed: boolean;
}
const brief = (node?: PageNode) =>
  node && { id: node.id, title: node.title, url: node.url };

/**
 * 读取并校验移动：目标须在同一空间，且不能是页面自身或其子孙（否则形成环）；
 * 已在目标父页下时标记无变化，调用方不发写请求。
 */
async function plan(
  client: ConfluenceClient,
  reference: string,
  parentReference: string,
  expectedVersion?: number,
): Promise<MovePlan> {
  const page = await client.get(reference);
  if (expectedVersion && page.version !== expectedVersion) {
    throw new ConfluenceError(
      409,
      `页面已由版本 ${expectedVersion} 变为 ${page.version}，请重新读取`,
    );
  }
  const to = await client.node(parentReference);
  if (to.id === page.id || to.ancestorIds.includes(page.id)) {
    throw new Error("不能把页面移到自身或其子页面下");
  }
  if (to.spaceKey !== page.spaceKey) {
    throw new Error("目标父页面属于其他空间；跨空间移动请在 Confluence 界面操作");
  }
  const from = page.parentId
    ? await client.node(String(page.parentId))
    : undefined;
  return { page, from, to, changed: String(page.parentId) !== to.id };
}

/** 预览只读：返回原父页与目标父页，不写入 Confluence。 */
export async function previewMove(
  client: ConfluenceClient,
  reference: string,
  parentReference: string,
  expectedVersion?: number,
) {
  const { page, from, to, changed } = await plan(
    client,
    reference,
    parentReference,
    expectedVersion,
  );
  return {
    status: changed ? "preview" : "no-change",
    pageId: page.id,
    title: page.title,
    version: page.version,
    url: page.url,
    from: brief(from),
    to: brief(to),
    message: changed
      ? "预览未移动。使用相同参数加 apply=true 与稳定 requestId 提交；子页面随之移动，页面产生一个正文不变的小改动版本。"
      : "页面已在目标父页面下，无需移动。",
  };
}

/**
 * 移动页面并持久化回执，记录与页面写入共用 operations 目录，requestId 不能跨用途复用。
 * 发送前先记 pending；服务器明确拒绝记 failed（需换 requestId），回执不明记 unknown，禁止自动重发。
 */
export async function applyMove(
  client: ConfluenceClient,
  reference: string,
  parentReference: string,
  requestId: string,
  expectedVersion?: number,
) {
  if (!client.profile.allowWrites) {
    throw new Error("此连接尚未启用写入，请在连接设置启用");
  }
  const operationId = `${client.profile.id}-${validId(requestId)}`;
  const file = dataFile("operations", operationId);
  return withLock(`submit-${hash(operationId).slice(0, 32)}`, async () => {
    const pageRef = await client.resolve(reference);
    const parentRef = await client.resolve(parentReference);
    const previous = await jsonRead<MoveRecord | null>(file, null);
    if (previous) {
      if (
        previous.kind !== "move" ||
        previous.profile !== client.profile.id ||
        previous.pageId !== pageRef ||
        previous.parentId !== parentRef
      ) {
        throw new Error("此 requestId 已用于其他内容，请使用新的请求标识");
      }
      if (previous.host !== client.profile.host) {
        throw new Error("连接地址已改变，请核实原移动记录");
      }
      if (previous.status === "complete") {
        return previous.result;
      }
      throw new Error(
        `请求已有记录：${previous.status}。${previous.status === "failed" ? "修正问题后使用新的 requestId。" : "先核实页面位置或查询 operation-status，不要重新提交。"}`,
      );
    }
    const { page, from, to, changed } = await plan(
      client,
      pageRef,
      parentRef,
      expectedVersion,
    );
    const record: MoveRecord = {
      kind: "move",
      requestId,
      profile: client.profile.id,
      host: client.profile.host,
      pageId: page.id,
      parentId: to.id,
      status: "pending",
    };
    const summary = {
      requestId,
      pageId: page.id,
      title: page.title,
      url: page.url,
      from: brief(from),
      to: brief(to),
    };
    if (!changed) {
      record.status = "complete";
      record.result = {
        status: "complete",
        changed: false,
        ...summary,
        version: page.version,
      };
      await jsonWrite(file, record);
      return record.result;
    }
    await jsonWrite(file, record);
    let moved: Page;
    try {
      moved = await client.move(page, to.id);
    } catch (error) {
      record.status =
        error instanceof ConfluenceError &&
        error.status >= 400 &&
        error.status < 500
          ? "failed"
          : "unknown";
      record.error = message(error);
      await jsonWrite(file, record);
      throw new Error(
        `${record.error}；移动状态 ${record.status}，requestId=${requestId}${record.status === "unknown" ? "。请核实页面位置，禁止自动重发" : ""}`,
      );
    }
    if (String(moved.parentId) !== to.id) {
      record.status = "unknown";
      record.error = "移动回执的父页面与目标不符";
      await jsonWrite(file, record);
      throw new Error(
        `${record.error}；requestId=${requestId}。请核实页面位置，禁止自动重发`,
      );
    }
    await invalidateReadCache(client.profile, page.id).catch(() => undefined);
    record.status = "complete";
    record.result = {
      status: "complete",
      changed: true,
      ...summary,
      version: moved.version,
    };
    try {
      await jsonWrite(file, record);
    } catch {
      return {
        ...(record.result as object),
        warning: "页面已移动，但本地回执保存失败；不要重新提交。",
      };
    }
    return record.result;
  });
}
