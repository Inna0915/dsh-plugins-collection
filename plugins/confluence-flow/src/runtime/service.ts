import { randomUUID } from "node:crypto";
import { ConfluenceClient, ConfluenceError } from "../core/confluence.js";
import { analyzeStorage, editStorage, withLayout } from "../core/storage.js";
import { getProfile, getAuth, profiles } from "./config.js";
import {
  dataFile,
  hash,
  jsonRead,
  jsonWrite,
  validId,
  withLock,
  message,
} from "./store.js";
import { toolSchema, type ToolInput } from "./schema.js";
import { PageReader, invalidateReadCache } from "./reading.js";
import { dailyMaintenance } from "./maintenance.js";
import {
  jsonOutput,
  fitRows,
  fitText,
  outputBytes,
  characterBoundary,
} from "./output.js";
import type { Draft, Page } from "../types.js";

interface Operation {
  requestId: string;
  draftId: string;
  fingerprint: string;
  sourceHash?: string;
  status: "pending" | "complete" | "failed" | "unknown";
  result?: unknown;
  error?: string;
}
function required(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`缺少${label}`);
  }
  return value;
}

export class ConfluenceService {
  private readonly controller = new AbortController();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  dispose(): void {
    this.controller.abort();
  }
  async client(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ConfluenceClient> {
    const profile = await getProfile(profileId);
    return new ConfluenceClient(
      profile,
      await getAuth(profile),
      signal
        ? AbortSignal.any([signal, this.controller.signal])
        : this.controller.signal,
      this.fetcher,
    );
  }
  private async snapshot(profile: string, page: Page): Promise<string> {
    const id = `${profile}-${page.id}-${page.version}-${hash(page.storage).slice(0, 12)}`;
    await jsonWrite(dataFile("snapshots", id), page);
    return id;
  }
  private async previewDraft(draft: Draft) {
    const rendered = analyzeStorage(draft.storage);
    return {
      draftId: draft.id,
      kind: draft.kind,
      pageId: draft.pageId,
      parentId: draft.parentId,
      spaceKey: draft.spaceKey,
      title: draft.title,
      expectedVersion: draft.expectedVersion,
      html: rendered.html,
      wiki: draft.wiki,
      change: draft.change,
      warnings: [...new Set([...draft.warnings, ...rendered.warnings])],
      status: "preview",
      message: "预览已保存，尚未发布。提交使用 draftId 与稳定 requestId。",
    };
  }
  private async prepare(
    client: ConfluenceClient,
    input: ToolInput,
  ): Promise<Draft> {
    const wiki = required(input.wiki, "wiki 正文");
    if (input.operation === "create") {
      const parent = await client.get(required(input.parent, "父页面"));
      const storage = withLayout(
        await client.convert(wiki, parent.id),
        input.layout || "right-toc",
      );
      return {
        id: randomUUID(),
        profile: input.profile,
        host: client.profile.host,
        kind: "create",
        createdAt: new Date().toISOString(),
        parentId: parent.id,
        spaceKey: parent.spaceKey,
        title: required(input.title, "标题").trim(),
        storage,
        wiki,
        change: { mode: "create", before: "", after: wiki },
        warnings: [],
      };
    }
    if (!input.expectedVersion) {
      throw new Error("更新前请 read 页面并提供 expectedVersion");
    }
    const page = await client.get(required(input.page, "目标页面"));
    if (page.version !== input.expectedVersion) {
      throw new ConfluenceError(
        409,
        `页面已由版本 ${input.expectedVersion} 变为 ${page.version}，请重新读取`,
      );
    }
    const snapshotId = await this.snapshot(input.profile, page);
    const mode = input.mode || "append";
    let replacement = await client.convert(wiki, page.id);
    if (mode === "replace-page") {
      replacement = withLayout(replacement, input.layout || "right-toc");
    } else if (input.layout) {
      throw new Error("局部修改保留原布局；layout 仅适用于新建或整页更新");
    }
    const edited = editStorage(
      page.storage,
      replacement,
      mode,
      input.sectionId,
      input.regionId,
    );
    const before = analyzeStorage(edited.before);
    const warnings = before.lossy
      ? [
          "本次选中范围包含特殊宏或格式，替换会移除该范围的原内容；范围外保持原样。",
        ]
      : [];
    return {
      id: randomUUID(),
      profile: input.profile,
      host: client.profile.host,
      kind: "update",
      createdAt: new Date().toISOString(),
      pageId: page.id,
      spaceKey: page.spaceKey,
      title: input.title?.trim() || page.title,
      expectedVersion: page.version,
      snapshotId,
      storage: edited.storage,
      wiki,
      change: { mode, before: before.wiki, after: wiki },
      warnings,
    };
  }
  private async commit(
    client: ConfluenceClient,
    draft: Draft,
    requestId: string,
    sourceHash?: string,
  ): Promise<any> {
    if (draft.profile !== client.profile.id) {
      throw new Error("草稿不属于当前连接");
    }
    if (draft.host !== client.profile.host) {
      throw new Error("连接地址已改变，请重新生成预览");
    }
    if (!client.profile.allowWrites) {
      throw new Error("此连接尚未启用写入，请在连接设置启用");
    }
    validId(requestId);
    const operationId = `${client.profile.id}-${requestId}`;
    const file = dataFile("operations", operationId);
    const fingerprint = hash(
      JSON.stringify({
        kind: draft.kind,
        profile: draft.profile,
        pageId: draft.pageId,
        parentId: draft.parentId,
        spaceKey: draft.spaceKey,
        title: draft.title,
        expectedVersion: draft.expectedVersion,
        storage: draft.storage,
      }),
    );
    return withLock(`submit-${hash(operationId).slice(0, 32)}`, async () => {
      const previous = await jsonRead<Operation | null>(file, null);
      if (previous) {
        if (
          previous.fingerprint !== fingerprint &&
          !(sourceHash && sourceHash === previous.sourceHash)
        ) {
          throw new Error("此 requestId 已用于其他内容，请使用新的请求标识");
        }
        if (previous.status === "complete") {
          return previous.result;
        }
        throw new Error(
          `请求已有记录：${previous.status}。${previous.status === "failed" ? "修正问题后使用新的 requestId。" : "先核实 Confluence 页面或查询 operation-status，不要重新发布。"}`,
        );
      }
      let parent: Page | undefined;
      if (draft.kind === "update") {
        const current = await client.get(draft.pageId!);
        if (current.version !== draft.expectedVersion) {
          throw new ConfluenceError(
            409,
            `页面已变为版本 ${current.version}，预览基于版本 ${draft.expectedVersion}；请重新读取并生成预览`,
          );
        }
        const snapshot = await jsonRead<Page>(
          dataFile("snapshots", draft.snapshotId!),
        );
        if (current.storage !== snapshot.storage) {
          throw new ConfluenceError(409, "页面内容已发生变化，请重新生成预览");
        }
      } else {
        parent = await client.get(draft.parentId!);
        if (parent.spaceKey !== draft.spaceKey) {
          throw new Error("父页面空间已变化，请重新生成发布预览");
        }
      }
      const operation: Operation = {
        requestId,
        draftId: draft.id,
        fingerprint,
        sourceHash,
        status: "pending",
      };
      await jsonWrite(file, operation);
      let result: any;
      try {
        const page =
          draft.kind === "create"
            ? await client.create(draft.title, parent!, draft.storage)
            : await client.update(
                draft.pageId!,
                draft.title,
                draft.expectedVersion!,
                draft.storage,
              );
        if (!page.id || !/^\d+$/.test(page.id)) {
          throw new Error("写入回执缺少页面 ID");
        }
        result = {
          status: "complete",
          requestId,
          draftId: draft.id,
          pageId: page.id,
          title: page.title,
          version: page.version,
          url: page.url,
          kind: draft.kind,
        };
      } catch (error) {
        operation.status =
          error instanceof ConfluenceError &&
          error.status >= 400 &&
          error.status < 500
            ? "failed"
            : "unknown";
        operation.error = message(error);
        await jsonWrite(file, operation);
        throw new Error(
          `${operation.error}；提交状态 ${operation.status}，requestId=${requestId}${operation.status === "unknown" ? "。请核实页面，禁止自动重发" : ""}`,
        );
      }
      await invalidateReadCache(client.profile, result.pageId).catch(
        () => undefined,
      );
      operation.status = "complete";
      operation.result = result;
      try {
        await jsonWrite(file, operation);
      } catch {
        return {
          ...result,
          warning:
            "页面已写入，但本地回执保存失败；请保留页面链接，不要重新提交。",
        };
      }
      return result;
    });
  }
  async execute(raw: unknown, signal?: AbortSignal): Promise<any> {
    await dailyMaintenance();
    return jsonOutput(await this.executeInternal(raw, signal));
  }
  private async executeInternal(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const input = toolSchema.parse(raw);
    if (input.operation === "profiles") {
      return profiles();
    }
    if (input.operation === "operation-status") {
      return jsonRead(
        dataFile(
          "operations",
          `${input.profile}-${required(input.requestId, "requestId")}`,
        ),
        { status: "not-found" },
      );
    }
    if (input.operation === "read" || input.operation === "scan") {
      const profile = await getProfile(input.profile);
      const reader = new PageReader(
        profile,
        () => this.client(input.profile, signal),
        signal
          ? AbortSignal.any([signal, this.controller.signal])
          : this.controller.signal,
      );
      if (
        (input.format === "full" || input.raw) &&
        (input.grep ||
          input.head !== undefined ||
          input.offset ||
          input.sectionId)
      ) {
        throw new Error(
          "full/raw 为完整表示，不能同时使用 grep/head/offset/sectionId；裁剪读取请用 wiki",
        );
      }
      // outline 先于正文裁剪返回，这些参数会被静默忽略；start 也不参与单页正文定位。
      if (
        input.operation === "read" &&
        input.format === "outline" &&
        (input.offset ||
          input.grep ||
          input.head !== undefined ||
          input.sectionId ||
          input.matchOffset)
      ) {
        throw new Error(
          "outline 只返回区域/章节目录，不能同时使用 offset/grep/head/sectionId/matchOffset；目录续读用 start=nextStart，正文用 wiki 读取",
        );
      }
      if (
        input.operation === "read" &&
        input.format !== "outline" &&
        input.start &&
        !input.scanId &&
        !input.pages
      ) {
        throw new Error(
          "start 只用于 outline 目录或 scanId 批次续读；wiki 正文续读用 offset=nextOffset",
        );
      }
      if (
        input.snapshotId &&
        (input.page || input.pages || input.scanId || input.refresh)
      ) {
        throw new Error(
          "snapshotId 是固定版本本地读取，不能同时指定 page/pages/scanId/refresh",
        );
      }
      if (
        input.scanId &&
        (input.pages || input.page || input.grep || input.refresh)
      ) {
        throw new Error(
          "scanId 续读请只提供 start 和输出预算；换条件请创建新扫描",
        );
      }
      if (input.scanId || input.pages || input.operation === "scan") {
        return reader.batch(input);
      }
      if (!input.snapshotId) {
        required(input.page, "页面或 snapshotId");
      }
      return reader.read(input);
    }
    const client = await this.client(input.profile, signal);
    switch (input.operation) {
      case "doctor": {
        const current = await client.request("/rest/api/user/current");
        const storage = await client.convert(
          "h1. Confluence Flow\n\nConnection check.",
        );
        return {
          connected: true,
          user: current.displayName || current.username || "",
          wikiConversion: /<h1>/.test(storage),
          allowWrites: client.profile.allowWrites,
          rootPageIds: client.profile.rootPageIds,
        };
      }
      case "search": {
        const found = await client.search(
          input.query,
          input.space,
          input.parent,
          input.start,
          input.limit,
          input.match,
          input.label,
        );
        const build = (results: any[]) => ({
          ...found,
          results,
          returned: results.length,
          nextStart:
            results.length < found.results.length
              ? input.start + results.length
              : found.nextStart,
        });
        // Prefer retaining all candidate IDs/titles, shortening snippets before dropping rows.
        const withSnippet = (length: number) =>
          found.results.map((row: any) => ({
            ...row,
            snippet: row.snippet.slice(
              0,
              characterBoundary(row.snippet, length),
            ),
            snippetTruncated: length < row.snippet.length,
          }));
        if (outputBytes(build(withSnippet(0))) <= input.maxBytes) {
          return fitText(
            "x".repeat(260),
            (part) => build(withSnippet(part.length)),
            input.maxBytes,
          );
        }
        return fitRows(withSnippet(80), build, input.maxBytes);
      }
      case "children":
        return client.children(
          required(input.page, "页面"),
          input.start,
          input.limit,
        );
      case "attachments":
        return client.attachments(
          required(input.page, "页面"),
          input.start,
          input.limit,
        );
      case "preview": {
        if (input.draftId) {
          const draft = await jsonRead<Draft>(
            dataFile("drafts", input.draftId),
          );
          if (draft.profile !== input.profile) {
            throw new Error("草稿不属于当前连接");
          }
          return this.previewDraft(draft);
        }
        const storage = withLayout(
          await client.convert(
            required(input.wiki, "wiki 正文"),
            input.page ? await client.resolve(input.page) : undefined,
          ),
          input.layout || "right-toc",
        );
        return {
          ...analyzeStorage(storage, client.profile.host),
          status: "preview",
        };
      }
      case "create":
      case "update": {
        if (input.apply) {
          required(input.requestId, "稳定 requestId");
        }
        const sourceHash = hash(
          JSON.stringify({ ...input, host: client.profile.host }),
        );
        if (input.apply) {
          const previous = await jsonRead<Operation | null>(
            dataFile(
              "operations",
              `${input.profile}-${validId(input.requestId!)}`,
            ),
            null,
          );
          if (previous) {
            if (previous.sourceHash !== sourceHash) {
              throw new Error(
                "此 requestId 已用于其他内容，请使用新的请求标识",
              );
            }
            if (previous.status === "complete") {
              return previous.result;
            }
            throw new Error(
              `请求已有记录：${previous.status}。请查询 operation-status 并核实页面，不要自动重发。`,
            );
          }
        }
        const draft = await this.prepare(client, input);
        await jsonWrite(dataFile("drafts", draft.id), draft);
        return input.apply
          ? this.commit(client, draft, input.requestId!, sourceHash)
          : this.previewDraft(draft);
      }
      case "commit": {
        const draft = await jsonRead<Draft>(
          dataFile("drafts", required(input.draftId, "draftId")),
        );
        return this.commit(
          client,
          draft,
          required(input.requestId, "稳定 requestId"),
        );
      }
    }
  }
}
