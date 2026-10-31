import type {
  Auth,
  Issue,
  Profile,
  Column,
  SearchResult,
  Transition,
  History,
  JiraUser,
  Sprint,
} from '../types.js';
import { issueKey } from '../runtime/store.js';
import { normalizeUser, projectFor, readPages, type prepareCreate } from './creation.js';

type Json = Record<string, any>;
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function columnFor(
  status: { id?: string; name?: string; statusCategory?: { key?: string } },
  profile: Pick<Profile, 'statusColumns'>,
): Column {
  const name = (status.name || '').trim();
  const override = profile.statusColumns[status.id || ''] || profile.statusColumns[name];
  if (override) return override;
  if (status.statusCategory?.key === 'done' || /^(done|closed|resolved|已完成|已关闭|已解决)$/i.test(name))
    return 'done';
  if (
    /executed|build[ _-]?done|testing|test done|review|validat|已构建|构建完成|测试|审核|验收|验证/i.test(
      name,
    )
  )
    return 'review';
  if (/execution|in progress|doing|执行中|开发中|处理中|进行中/i.test(name)) return 'doing';
  if (status.statusCategory?.key === 'indeterminate' && !/ready|待办|就绪/i.test(name)) return 'doing';
  return 'todo';
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function plainRich(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as Json;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const children = (node.content || []).map(plainRich).join('');
  return children + (['paragraph', 'heading', 'listItem'].includes(node.type) ? '\n' : '');
}
export function normalizeIssue(raw: Json, profile: Profile): Issue {
  const f = raw.fields || {};
  const status = f.status || {};
  const sprintValues = Array.isArray(f[profile.sprintField])
    ? f[profile.sprintField]
    : [f[profile.sprintField]].filter(Boolean);
  const sprint =
    sprintValues.find((s: any) => s?.state === 'active' || /state=ACTIVE/i.test(String(s))) ||
    sprintValues.at(-1);
  const sprintName =
    typeof sprint === 'string'
      ? sprint.match(/(?:^|[,\[])name=([^,\]]+)/)?.[1] || sprint
      : sprint?.name || '';
  const rendered = raw.renderedFields?.description;
  const key = issueKey(raw.key);
  return {
    id: String(raw.id),
    key,
    project: f.project?.key || key.replace(/-\d+$/, ''),
    summary: text(f.summary),
    type: f.issuetype?.name || 'Task',
    status: {
      id: String(status.id || ''),
      name: status.name || '',
      category: status.statusCategory?.key || '',
    },
    column: columnFor(status, profile),
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || '',
    assigneeId: f.assignee?.accountId || f.assignee?.name || '',
    reporter: f.reporter?.displayName || '',
    created: f.created || '',
    updated: f.updated || '',
    dueDate: f[profile.dueDateField] || f.duedate || '',
    resolvedAt: f.resolutiondate || '',
    resolution: f.resolution?.name || '',
    storyPoints: typeof f[profile.storyPointsField] === 'number' ? f[profile.storyPointsField] : null,
    sprint: sprintName,
    sprintState:
      typeof sprint === 'string'
        ? sprint.match(/state=([^,\]]+)/)?.[1]?.toLowerCase() || ''
        : sprint?.state || '',
    description: typeof rendered === 'string' && rendered ? rendered : plainRich(f.description),
    descriptionFormat: rendered ? 'html' : 'wiki',
    attachments: (f.attachment || []).map((a: Json) => ({
      id: String(a.id),
      filename: a.filename,
      mimeType: a.mimeType || 'application/octet-stream',
      size: Number(a.size) || 0,
      content: a.content,
      thumbnail: a.thumbnail,
    })),
    comments: (f.comment?.comments || []).map((c: Json) => ({
      id: String(c.id),
      author: c.author?.displayName || '',
      created: c.created || '',
      body: plainRich(c.body),
    })),
    links: (f.issuelinks || [])
      .map((l: Json) => {
        const related = l.inwardIssue || l.outwardIssue;
        return {
          key: related?.key || '',
          summary: related?.fields?.summary || '',
          relation: l.inwardIssue ? l.type?.inward : l.type?.outward,
        };
      })
      .filter((l: Json) => l.key),
    url: `${profile.browseHost}/browse/${key}`,
    warnings: [],
  };
}
// Agent-facing history: keep only the requested change fields and the author's identity.
export function compactHistories(histories: History[], fields: string[]): History[] {
  const wanted = new Set(fields.map((field) => field.toLowerCase()));
  return histories.flatMap((history) => {
    const items = history.items
      .filter((item) => wanted.has(item.field.toLowerCase()))
      .map(({ field, from, fromString, to, toString }) => ({ field, from, fromString, to, toString }));
    if (!items.length) return [];
    const author = history.author && { name: history.author.name, displayName: history.author.displayName };
    return [{ id: history.id, created: history.created, author, items }];
  });
}
export function scopedJql(profile: Profile, query?: string): string {
  const input = (query ?? profile.jql).trim();
  const order = ` ${input.match(/(?:^|\s+)ORDER\s+BY\s+[^]*$/i)?.[0].trim() || 'ORDER BY updated DESC'}`;
  const body = input.replace(/(?:^|\s+)ORDER\s+BY\s+[^]*$/i, '').trim();
  const projects = profile.projectKeys.map((key) => `"${key}"`).join(',');
  return `project IN (${projects})${body ? ` AND (${body})` : ''}${order}`;
}
export class JiraClient {
  readonly profile: Profile;
  private readonly authorization: string;
  constructor(
    profile: Profile,
    auth: Auth,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {
    this.profile = profile;
    this.authorization =
      auth.kind === 'bearer'
        ? `Bearer ${auth.secret}`
        : `Basic ${Buffer.from(`${auth.username}:${auth.secret}`).toString('base64')}`;
  }
  private get fields(): string {
    return [
      ...new Set([
        'summary',
        'project',
        'description',
        'status',
        'issuetype',
        'priority',
        'assignee',
        'reporter',
        'created',
        'updated',
        'duedate',
        'resolution',
        'resolutiondate',
        'issuelinks',
        'attachment',
        this.profile.storyPointsField,
        this.profile.dueDateField,
        this.profile.sprintField,
      ]),
    ].join(',');
  }
  private scopedKey(key: string): string {
    const normalized = issueKey(key);
    if (!this.profile.projectKeys.includes(normalized.replace(/-\d+$/, '')))
      throw new Error('任务不在此连接允许的项目范围内');
    return normalized;
  }
  async request<T = Json>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const url = `${this.profile.host}/rest/${endpoint.startsWith('agile/') ? endpoint : `api/2/${endpoint}`}`;
    const multipart = body instanceof FormData;
    const signal = AbortSignal.any([
      AbortSignal.timeout(multipart ? 90_000 : 25_000),
      ...(this.signal ? [this.signal] : []),
    ]);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: 'application/json',
          ...(multipart ? { 'X-Atlassian-Token': 'no-check' } : { 'Content-Type': 'application/json' }),
        },
        body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (this.signal?.aborted) throw new Error('操作已取消');
      throw new Error(`Jira 网络请求失败或超时（${method}），请检查地址、网络和证书`);
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error('Jira 返回重定向，请配置实际 API 地址或检查登录方式');
    if (!response.ok) {
      let detail = '';
      try {
        const error = (await response.json()) as Json;
        detail = [...(error.errorMessages || []), ...Object.values(error.errors || {})]
          .filter((v) => typeof v === 'string')
          .join('；')
          .slice(0, 700);
      } catch {
        /* HTML login responses should not be logged. */
      }
      if (/authorization|password|cookie|token|secret/i.test(detail)) detail = '认证或权限配置有误';
      throw new JiraHttpError(response.status, `Jira ${response.status}${detail ? `：${detail}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    const raw = await response.text();
    if (!raw.trim()) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error('Jira 返回非 JSON 内容，请检查 API 地址和认证');
    }
  }
  async me(): Promise<JiraUser> {
    const user = await this.request('myself');
    return normalizeUser(user);
  }
  async attachmentSettings(): Promise<{ enabled: boolean; uploadLimit: number }> {
    const value = await this.request('attachment/meta');
    if (typeof value.enabled !== 'boolean' || !Number.isFinite(value.uploadLimit) || value.uploadLimit < 0)
      throw new Error('Jira 附件设置响应无效');
    return { enabled: value.enabled, uploadLimit: value.uploadLimit };
  }
  async uploadImage(
    key: string,
    image: { filename: string; mimeType: string; bytes: Uint8Array },
    apply: boolean,
  ) {
    this.writable(apply);
    const target = this.scopedKey(key);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.filename);
    const result = await this.request(`issue/${target}/attachments`, 'POST', form);
    if (!Array.isArray(result) || result.length !== 1 || !result[0]?.id)
      throw new Error('附件上传响应缺少唯一回执，请先在 Jira 核实，不要重复上传');
    const attachment = result[0];
    return {
      id: String(attachment.id),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      content: attachment.content,
    };
  }
  async search(query?: string, limit = 500, options: { description?: boolean } = {}): Promise<SearchResult> {
    limit = Math.max(1, Math.min(5000, Math.floor(limit)));
    // Lists for agents can skip bodies: rendered descriptions dominate the response size.
    const description = options.description !== false;
    const jql = scopedJql(this.profile, query);
    const issues: Issue[] = [];
    let total = 0;
    let startAt = 0;
    while (issues.length < limit) {
      const data = await this.request('search', 'POST', {
        jql,
        startAt,
        maxResults: Math.min(100, limit - issues.length),
        fields: this.fields.split(',').filter((field) => description || field !== 'description'),
        ...(description ? { expand: ['renderedFields'] } : {}),
      });
      if (!Array.isArray(data.issues) || typeof data.total !== 'number')
        throw new Error('Jira 查询响应缺少分页信息');
      total = data.total;
      for (const raw of data.issues) {
        const issue = normalizeIssue(raw, this.profile);
        if (this.profile.projectKeys.includes(issue.project)) issues.push(issue);
      }
      startAt += data.issues.length;
      if (startAt >= total) break;
      if (!data.issues.length) throw new Error('Jira 分页未完成，已停止同步以保留已有数据');
    }
    return { issues, total, complete: startAt >= total, fetchedAt: new Date().toISOString(), jql };
  }
  async get(key: string, comments = true): Promise<Issue> {
    const raw = await this.request(
      `issue/${this.scopedKey(key)}?fields=${this.fields}&expand=renderedFields`,
    );
    const issue = normalizeIssue(raw, this.profile);
    if (comments) {
      try {
        let start = 0;
        while (start < 1000) {
          const page = await this.request(
            `issue/${issue.key}/comment?startAt=${start}&maxResults=100&orderBy=created`,
          );
          const rows = page.comments || [];
          issue.comments.push(
            ...rows.map((c: Json) => ({
              id: String(c.id),
              author: c.author?.displayName || '',
              created: c.created || '',
              body: plainRich(c.body),
            })),
          );
          start += rows.length;
          if (start >= page.total) break;
          if (!rows.length) throw new Error('评论分页不完整');
          if (start >= 1000) issue.warnings.push('评论超过 1000 条，已截断');
        }
      } catch {
        issue.warnings.push('评论读取未完整完成；任务正文仍可使用');
      }
    }
    return issue;
  }
  async transitions(key: string): Promise<Transition[]> {
    const value = await this.request(`issue/${this.scopedKey(key)}/transitions?expand=transitions.fields`);
    return (value.transitions || []).map((t: Json) => ({
      id: t.id,
      name: t.name,
      to: t.to,
      fields: t.fields || {},
    }));
  }
  async download(source: string, maxBytes = 20 * 1024 * 1024): Promise<{ bytes: Buffer; mimeType: string }> {
    let url = new URL(source, this.profile.host + '/');
    const jiraOrigin = new URL(this.profile.host).origin;
    for (let hop = 0; hop < 4; hop++) {
      if (url.origin !== jiraOrigin || url.username || url.password)
        throw new Error('附件来源不是配置的 Jira，不向该地址发送凭证');
      const response = await this.fetcher(url, {
        headers: { Authorization: this.authorization },
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(this.signal ? [this.signal] : [])]),
      });
      if (response.status >= 300 && response.status < 400) {
        const destination = response.headers.get('location');
        if (!destination) throw new Error('附件重定向缺少地址');
        url = new URL(destination, url);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`附件下载失败（HTTP ${response.status}）`);
      const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      if (mimeType === 'text/html') throw new Error('附件返回登录页面');
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body.cancel();
        throw new Error('附件超过大小限制');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('附件超过大小限制');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return { bytes: Buffer.concat(chunks), mimeType };
    }
    throw new Error('附件重定向次数过多');
  }
  async history(key: string): Promise<{ histories: History[]; complete: boolean }> {
    const raw = await this.request(`issue/${this.scopedKey(key)}?fields=status&expand=changelog`);
    const history = raw.changelog;
    if (!history || !Array.isArray(history.histories)) return { histories: [], complete: false };
    const histories: History[] = [...history.histories];
    if (histories.length >= history.total) return { histories, complete: true };
    try {
      // Jira versions with a paged changelog endpoint. Older Server versions return 404.
      let startAt = 0;
      const complete: History[] = [];
      while (startAt < 10_000) {
        const page = await this.request(
          `issue/${this.scopedKey(key)}/changelog?startAt=${startAt}&maxResults=100`,
        );
        const values = page.values || page.histories || [];
        complete.push(...values);
        startAt += values.length;
        if (page.isLast || startAt >= page.total) return { histories: complete, complete: true };
        if (!values.length) break;
      }
    } catch {
      /* Report incomplete historical coverage, not a guessed completion date. */
    }
    return { histories, complete: false };
  }
  private writable(apply: boolean): void {
    if (!this.profile.allowWrites) throw new Error('此连接处于只读模式，请在连接设置中启用 Jira 更新');
    if (!apply) throw new Error('写操作需要明确 apply；先检查目标、字段和当前流转');
  }
  async transition(
    key: string,
    transitionId: string,
    fields: Json,
    comment: string,
    expectedUpdated: string,
    apply: boolean,
    beforeWrite?: () => Promise<void>,
  ): Promise<Issue> {
    this.writable(apply);
    const issue = await this.get(key, false);
    if (expectedUpdated && issue.updated !== expectedUpdated)
      throw new Error('Jira 任务已变化，请刷新后重试');
    const transitions = await this.transitions(key);
    const transition = transitions.find((t) => t.id === transitionId);
    if (!transition) throw new Error('该流转当前不可用，请刷新任务');
    for (const [field, definition] of Object.entries(transition.fields)) {
      if (
        definition.required &&
        field !== 'comment' &&
        (fields[field] === undefined ||
          fields[field] === '' ||
          fields[field] === null ||
          (Array.isArray(fields[field]) && !fields[field].length))
      )
        throw new Error(`请填写 ${definition.name}`);
      if (definition.required && field === 'comment' && !comment.trim()) throw new Error('请填写备注');
    }
    const body: Json = { transition: { id: transitionId } };
    if (Object.keys(fields).length) body.fields = fields;
    if (comment.trim()) body.update = { comment: [{ add: { body: comment } }] };
    await beforeWrite?.();
    await this.request(`issue/${this.scopedKey(key)}/transitions`, 'POST', body);
    return this.get(key, false);
  }
  async update(
    key: string,
    fields: Json,
    expectedUpdated: string,
    apply: boolean,
    beforeWrite?: () => Promise<void>,
  ): Promise<Issue> {
    this.writable(apply);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length)
      throw new Error('没有要更新的字段');
    if ('status' in fields || 'project' in fields)
      throw new Error('状态请使用流转工具，项目迁移不在此操作范围');
    const current = await this.get(key, false);
    if (expectedUpdated && expectedUpdated !== current.updated) throw new Error('任务已变化，请刷新后更新');
    await beforeWrite?.();
    await this.request(`issue/${this.scopedKey(key)}`, 'PUT', { fields });
    return this.get(key, false);
  }
  async comment(
    key: string,
    body: string,
    apply: boolean,
    beforeWrite?: () => Promise<void>,
  ): Promise<{ id: string }> {
    this.writable(apply);
    if (!body.trim()) throw new Error('评论不能为空');
    await beforeWrite?.();
    const result = await this.request(`issue/${this.scopedKey(key)}/comment`, 'POST', { body });
    return { id: String(result.id) };
  }
  async createPrepared(
    plan: Awaited<ReturnType<typeof prepareCreate>>,
    apply: boolean,
    beforeWrite?: () => Promise<void>,
  ) {
    this.writable(apply);
    if (!plan.ready)
      throw new Error(
        `缺少必填字段：${plan.missingFields.map((field) => `${field.name} (${field.key})`).join('、')}`,
      );
    await beforeWrite?.();
    const result = await this.request('issue', 'POST', { fields: plan.fields });
    const key = this.scopedKey(result.key);
    // Preserve the successful create receipt. A follow-up detail failure must not
    // turn a confirmed creation into an invitation to create a duplicate.
    return {
      created: true,
      id: String(result.id),
      key,
      url: `${this.profile.browseHost}/browse/${key}`,
      assignee: plan.assignee,
      sprint: plan.sprint,
    };
  }
  async sprints(project?: string): Promise<Sprint[]> {
    const projects = project ? [projectFor(this, project)] : this.profile.projectKeys;
    const results: Sprint[] = [];
    for (const projectKey of projects) {
      const boards = await readPages(
        this,
        `agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum`,
        ['values'],
      );
      for (const board of boards) {
        const values = await readPages(this, `agile/1.0/board/${board.id}/sprint?state=active,future`, [
          'values',
        ]);
        results.push(
          ...values.map((s: Json) => ({
            id: s.id,
            name: s.name,
            state: s.state,
            board: board.name,
            project: projectKey,
          })),
        );
      }
    }
    return [...new Map(results.map((s) => [s.id, s])).values()];
  }
}
