import type { Attachment, Auth, Page, PageNode, Profile } from "../types.js";
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
    // 附件上传走 multipart：由 fetch 生成边界，不能手写 Content-Type；Atlassian 要求 no-check 绕过 XSRF 校验。
    const multipart = data instanceof FormData;
    const timeout = AbortSignal.timeout(multipart ? 120_000 : 30_000);
    const signal = this.signal
      ? AbortSignal.any([this.signal, timeout])
      : timeout;
    const response = await this.fetcher(url, {
      method,
      signal,
      redirect: "manual",
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(multipart
          ? { "X-Atlassian-Token": "no-check" }
          : { "Content-Type": "application/json" }),
      },
      body: multipart
        ? (data as FormData)
        : data === undefined
          ? undefined
          : JSON.stringify(data),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const detail: Record<number, string> = {
        401: "认证失败",
        403: "没有操作权限",
        404: "页面或接口不存在",
        409: "页面版本冲突，请重新读取",
        413: "文件超过服务器附件大小限制",
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
  private attachment(raw: any): Attachment {
    return {
      id: String(raw.id),
      title: raw.title,
      version: Number.isSafeInteger(raw.version?.number)
        ? raw.version.number
        : null,
      mediaType: raw.metadata?.mediaType,
      size: raw.extensions?.fileSize,
      url: raw._links?.download
        ? new URL(raw._links.download, this.profile.host + "/").toString()
        : "",
    };
  }
  async attachments(reference: string, start = 0, limit = 50): Promise<any> {
    const id = await this.resolve(reference);
    const result = await this.request(
      `/rest/api/content/${id}/child/attachment?expand=version&start=${start}&limit=${limit}`,
    );
    return {
      results: (result.results || []).map((raw: any) => this.attachment(raw)),
      nextStart: result._links?.next ? start + result.results.length : null,
    };
  }
  /** 按文件名精确查找页面附件；Confluence 同一页面同名附件只有一个，上传同名文件即生成新版本。 */
  async findAttachment(
    id: string,
    filename: string,
  ): Promise<Attachment | undefined> {
    const result = await this.request(
      `/rest/api/content/${pageId(id)}/child/attachment?` +
        new URLSearchParams({ filename, expand: "version", limit: "5" }),
    );
    const raw = (result.results || []).find(
      (row: any) => row.title === filename,
    );
    return raw ? this.attachment(raw) : undefined;
  }
  /**
   * 上传附件：existingId 存在时为该附件上传新版本，否则新增附件。
   * 按小改动提交，不通知页面关注者；回执缺少附件 ID 时不视为成功，由调用方按结果不明处理。
   */
  async uploadAttachment(
    id: string,
    file: { filename: string; mediaType: string; bytes: Uint8Array },
    comment: string,
    existingId?: string,
  ): Promise<Attachment> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
      file.filename,
    );
    form.append("minorEdit", "true");
    if (comment) {
      form.append("comment", comment);
    }
    const base = `/rest/api/content/${pageId(id)}/child/attachment`;
    const result = await this.request(
      existingId ? `${base}/${pageId(existingId)}/data` : base,
      "POST",
      form,
    );
    // 新增返回 {results:[...]}，新版本返回附件本身；两种都只接受唯一回执。
    const raw = Array.isArray(result?.results)
      ? result.results.length === 1
        ? result.results[0]
        : undefined
      : result;
    if (!raw?.id) {
      throw new Error(
        "附件上传响应缺少唯一回执，请先在 Confluence 核实附件，不要重复上传",
      );
    }
    return this.attachment(raw);
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
  /** 只取页面层级元数据（不含正文），供移动前核对空间与祖先链。 */
  async node(reference: string): Promise<PageNode> {
    const id = await this.resolve(reference);
    const raw = await this.request(
      `/rest/api/content/${id}?expand=space,version,ancestors`,
    );
    if (raw.type !== "page" || String(raw.id) !== id || !raw.space?.key) {
      throw new Error("页面响应缺少类型或空间，无法确定层级");
    }
    return {
      id,
      title: raw.title,
      spaceKey: raw.space.key,
      version: raw.version?.number || 1,
      ancestorIds: (raw.ancestors || []).map((row: any) => String(row.id)),
      url: `${this.profile.host}/pages/viewpage.action?pageId=${id}`,
    };
  }
  /**
   * 移动页面到新父页下（子页面随之移动）。7.19 没有独立的 move 接口，按官方做法在更新请求中
   * 替换 ancestors；正文原样回传 GET 得到的 storage，因此会产生一个内容不变的新版本，按小改动提交不通知关注者。
   */
  async move(page: Page, parentId: string): Promise<Page> {
    return this.normalize(
      await this.request(
        `/rest/api/content/${pageId(page.id)}?expand=space,version,ancestors`,
        "PUT",
        {
          id: page.id,
          type: "page",
          title: page.title,
          space: { key: page.spaceKey },
          ancestors: [{ id: pageId(parentId) }],
          version: {
            number: page.version + 1,
            minorEdit: true,
            message: "Moved with Confluence Flow",
          },
          body: { storage: { value: page.storage, representation: "storage" } },
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
