import type { Auth, Page, Profile } from "../types.js";
import { pageId } from "../runtime/store.js";
import { parseDocument } from "htmlparser2";
import { isText, hasChildren } from "domhandler";

export class ConfluenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function cqlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
export function plainExcerpt(value: string): string {
  const text = (node: any): string =>
    isText(node)
      ? node.data
      : hasChildren(node)
        ? node.children.map(text).join("")
        : "";
  return text(parseDocument(value))
    .replace(/@@@(?:end)?hl@@@/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export class ConfluenceClient {
  private readonly authorization: string;
  constructor(
    readonly profile: Profile,
    auth: Auth,
    private readonly signal?: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.authorization =
      auth.kind === "bearer"
        ? `Bearer ${auth.secret}`
        : `Basic ${Buffer.from(`${auth.username}:${auth.secret}`).toString("base64")}`;
  }
  async request(
    endpoint: string,
    method = "GET",
    data?: unknown,
  ): Promise<any> {
    const url = this.profile.host + endpoint;
    const signal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const response = await this.fetcher(url, {
      method,
      signal,
      redirect: "manual",
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const detail: Record<number, string> = {
        401: "认证失败",
        403: "没有操作权限",
        404: "页面或接口不存在",
        409: "页面版本冲突，请重新读取",
        429: "请求过于频繁，请稍后重试",
      };
      throw new ConfluenceError(
        response.status,
        detail[response.status] ||
          `Confluence 请求失败（HTTP ${response.status}）`,
      );
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new Error("服务器未返回 JSON，可能需要重新认证");
    }
    return response.json();
  }
  async resolve(reference: string): Promise<string> {
    if (/^\d+$/.test(reference)) {
      return reference;
    }
    const target = this.profile.targets[reference];
    if (target) {
      return pageId(target);
    }
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new Error("请提供页面 ID、完整页面链接或已保存的发布位置名称");
    }
    const base = new URL(this.profile.host);
    if (
      url.origin !== base.origin ||
      (base.pathname !== "/" &&
        !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/"))
    ) {
      throw new Error("页面链接不属于当前 Confluence 连接");
    }
    const queryId = url.searchParams.get("pageId");
    const pathId = url.pathname.match(/\/pages\/(\d+)(?:\/|$)/)?.[1];
    if (queryId || pathId) {
      return pageId(queryId || pathId!);
    }
    const display = url.pathname.match(/\/display\/([^/]+)\/(.+)$/);
    if (display) {
      const space = decodeURIComponent(display[1]);
      const title = decodeURIComponent(display[2].replace(/\+/g, " "));
      const result = await this.request(
        "/rest/api/content?" +
          new URLSearchParams({
            type: "page",
            spaceKey: space,
            title,
            limit: "2",
          }),
      );
      if (result.results?.length === 1) {
        return String(result.results[0].id);
      }
      throw new Error("页面标题没有唯一匹配，请使用包含 pageId 的链接");
    }
    throw new Error("此链接无法解析，请使用页面 ID 或包含 pageId 的完整链接");
  }
  normalize(raw: any): Page {
    return {
      id: String(raw.id),
      title: raw.title,
      spaceKey: raw.space?.key || "",
      version: raw.version?.number || 1,
      parentId: raw.ancestors?.at(-1)?.id,
      storage: raw.body?.storage?.value || "",
      updated: raw.version?.when,
      url: `${this.profile.host}/pages/viewpage.action?pageId=${raw.id}`,
    };
  }
  async get(reference: string): Promise<Page> {
    const id = await this.resolve(reference);
    const raw = await this.request(
      `/rest/api/content/${id}?expand=body.storage,version,space,ancestors`,
    );
    if (
      raw.type !== "page" ||
      String(raw.id) !== id ||
      typeof raw.body?.storage?.value !== "string" ||
      !Number.isSafeInteger(raw.version?.number) ||
      raw.version.number < 1 ||
      !raw.space?.key
    ) {
      throw new Error("页面响应缺少正文、空间或版本，不能作为修改底稿");
    }
    return this.normalize(raw);
  }
  async search(
    query = "",
    space = "",
    parent = "",
    start = 0,
    limit = 30,
    match: "all" | "any" | "phrase" = "all",
    label?: string,
  ): Promise<any> {
    const clauses = ["type=page"];
    if (space) {
      clauses.push(`space=${cqlString(space)}`);
    }
    if (query) {
      if (match === "phrase") {
        clauses.push(`text~${cqlString('"' + query + '"')}`);
      } else {
        const terms = query
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((term) => `text~${cqlString(term)}`);
        if (terms.length) {
          clauses.push(
            "(" + terms.join(match === "all" ? " AND " : " OR ") + ")",
          );
        }
      }
    }
    if (label) {
      clauses.push(`label=${cqlString(label)}`);
    }
    if (parent) {
      const id = await this.resolve(parent);
      clauses.push(`(id=${id} OR ancestor=${id})`);
    } else if (!space && this.profile.rootPageIds.length) {
      const ids = this.profile.rootPageIds.join(",");
      clauses.push(`(id in (${ids}) OR ancestor in (${ids}))`);
    }
    const result = await this.request(
      "/rest/api/search?" +
        new URLSearchParams({
          cql: clauses.join(" AND ") + " ORDER BY lastmodified DESC",
          expand: "content.version,content.space",
          excerpt: "highlight",
          start: String(start),
          limit: String(limit),
        }),
    );
    return {
      results: (result.results || []).map((raw: any) => {
        const content = raw.content || {};
        return {
          id: String(content.id),
          title: content.title || plainExcerpt(raw.title || ""),
          spaceKey: content.space?.key || "",
          version: content.version?.number ?? null,
          url: `${this.profile.host}/pages/viewpage.action?pageId=${content.id}`,
          updated: raw.lastModified || content.version?.when || null,
          snippet: plainExcerpt(raw.excerpt || "").slice(0, 260),
        };
      }),
      start,
      limit,
      totalSize: Number.isFinite(result.totalSize) ? result.totalSize : null,
      match,
      order: "lastmodified DESC",
      nextStart: result._links?.next ? start + result.results.length : null,
    };
  }
  async children(reference: string, start = 0, limit = 50): Promise<any> {
    const id = await this.resolve(reference);
    const result = await this.request(
      `/rest/api/content/${id}/child/page?expand=space,version,ancestors&start=${start}&limit=${limit}`,
    );
    return {
      results: (result.results || []).map((raw: any) => {
        const { storage, ...page } = this.normalize(raw);
        return page;
      }),
      nextStart: result._links?.next ? start + result.results.length : null,
    };
  }
  async attachments(reference: string, start = 0, limit = 50): Promise<any> {
    const id = await this.resolve(reference);
    const result = await this.request(
      `/rest/api/content/${id}/child/attachment?start=${start}&limit=${limit}`,
    );
    return {
      results: (result.results || []).map((raw: any) => ({
        id: raw.id,
        title: raw.title,
        mediaType: raw.metadata?.mediaType,
        size: raw.extensions?.fileSize,
        url: raw._links?.download
          ? new URL(raw._links.download, this.profile.host + "/").toString()
          : "",
      })),
      nextStart: result._links?.next ? start + result.results.length : null,
    };
  }
  async convert(wiki: string, contextId?: string): Promise<string> {
    const context = contextId ? `?contentIdContext=${pageId(contextId)}` : "";
    const result = await this.request(
      "/rest/api/contentbody/convert/storage" + context,
      "POST",
      { value: wiki, representation: "wiki" },
    );
    if (
      typeof result.value !== "string" ||
      result.representation !== "storage"
    ) {
      throw new Error("服务器没有返回有效 storage 内容");
    }
    return result.value;
  }
  async create(title: string, parent: Page, storage: string): Promise<Page> {
    return this.normalize(
      await this.request(
        "/rest/api/content?expand=space,version,ancestors,body.storage",
        "POST",
        {
          type: "page",
          title,
          space: { key: parent.spaceKey },
          ancestors: [{ id: parent.id }],
          body: { storage: { value: storage, representation: "storage" } },
        },
      ),
    );
  }
  async update(
    id: string,
    title: string,
    version: number,
    storage: string,
    comment = "Updated with Confluence Flow",
  ): Promise<Page> {
    return this.normalize(
      await this.request(
        `/rest/api/content/${pageId(id)}?expand=space,version,ancestors,body.storage`,
        "PUT",
        {
          id,
          type: "page",
          title,
          version: { number: version + 1, message: comment },
          body: { storage: { value: storage, representation: "storage" } },
        },
      ),
    );
  }
}
