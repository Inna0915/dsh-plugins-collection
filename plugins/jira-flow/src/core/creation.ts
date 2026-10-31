import type { JiraClient } from './jira.js';
import type { CreateIssueInput, JiraUser } from '../types.js';

type Json = Record<string, any>;
export function projectFor(client: JiraClient, project?: string): string {
  const chosen =
    project?.trim().toUpperCase() ||
    (client.profile.projectKeys.length === 1 ? client.profile.projectKeys[0] : '');
  if (!chosen) throw new Error(`请指定项目：${client.profile.projectKeys.join('、')}`);
  if (!client.profile.projectKeys.includes(chosen)) throw new Error('项目不在此连接允许的范围内');
  return chosen;
}
export function normalizeUser(user: Json): JiraUser {
  return {
    ...(user.name ? { name: user.name } : {}),
    ...(user.key ? { key: user.key } : {}),
    ...(user.accountId ? { accountId: user.accountId } : {}),
    displayName: user.displayName || user.name || user.accountId || '',
    active: user.active !== false,
  };
}
export function userField(user: JiraUser) {
  if (user.accountId) return { accountId: user.accountId };
  if (user.name) return { name: user.name };
  throw new Error('Jira 用户缺少有效标识');
}

export async function readPages(client: JiraClient, endpoint: string, rowKeys: string[]): Promise<Json[]> {
  const rows: Json[] = [];
  let startAt = 0;
  while (startAt < 5000) {
    const page = await client.request(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}startAt=${startAt}&maxResults=100`,
    );
    const values = rowKeys.map((key) => page[key]).find(Array.isArray);
    if (!values) throw new Error('Jira 元数据响应缺少分页数据');
    rows.push(...values);
    startAt += values.length;
    if (page.isLast === true || (typeof page.total === 'number' && startAt >= page.total)) return rows;
    if (!values.length) throw new Error('Jira 元数据分页未完成');
    if (page.isLast === undefined && page.total === undefined) {
      if (typeof page.maxResults === 'number' && values.length < page.maxResults) return rows;
      throw new Error('Jira 元数据响应缺少分页结束标识');
    }
  }
  throw new Error('Jira 元数据超过读取上限，请缩小项目范围');
}

async function metadata(client: JiraClient, project: string, requestedType: string) {
  let issueTypes: Json[];
  let legacy = false;
  try {
    issueTypes = await readPages(client, `issue/createmeta/${project}/issuetypes`, ['values', 'issueTypes']);
  } catch (error) {
    if (![404, 405, 410].includes((error as { status?: number }).status || 0)) throw error;
    const result = await client.request(
      `issue/createmeta?projectKeys=${project}&expand=projects.issuetypes.fields`,
    );
    issueTypes = result.projects?.find((row: Json) => row.key === project)?.issuetypes || [];
    legacy = true;
  }
  const types = issueTypes.filter((type) => !type.subtask);
  const exact = types.filter(
    (type) => String(type.id) === requestedType || type.name.toLowerCase() === requestedType.toLowerCase(),
  );
  const aliases =
    [
      ['task', '任务'],
      ['bug', '缺陷'],
      ['story', '故事', '用户故事'],
    ].find((names) => names.includes(requestedType.toLowerCase())) || [];
  const selected = exact.length ? exact : types.filter((type) => aliases.includes(type.name.toLowerCase()));
  if (selected.length !== 1)
    throw new Error(
      `请指定项目中可创建的任务类型：${types.map((type) => `${type.name} (${type.id})`).join('、') || '当前账号无可创建类型'}`,
    );
  const type = selected[0];
  const fields: Json = legacy
    ? type.fields || {}
    : Object.fromEntries(
        (
          await readPages(client, `issue/createmeta/${project}/issuetypes/${encodeURIComponent(type.id)}`, [
            'values',
            'fields',
          ])
        ).map((field) => [field.fieldId || field.key, field]),
      );
  return {
    issueTypes: types.map((row) => ({ id: String(row.id), name: row.name })),
    issueType: { id: String(type.id), name: type.name },
    fields,
  };
}

export async function assignableUsers(
  client: JiraClient,
  project: string | undefined,
  query = 'me',
  me?: JiraUser,
) {
  const target = projectFor(client, project);
  const current = me || (await client.me());
  const search = query === 'me' ? current.accountId || current.name! : query.trim();
  if (!search) throw new Error('请输入要查找的用户名、accountId 或姓名');
  const parameter = current.accountId ? (search === current.accountId ? 'accountId' : 'query') : 'username';
  let values = await client.request(
    `user/assignable/search?project=${target}&${parameter}=${encodeURIComponent(search)}&startAt=0&maxResults=1000`,
  );
  if (current.accountId && parameter === 'query' && Array.isArray(values) && !values.length) {
    // Cloud's text query need not match an opaque accountId. Ask the same
    // assignable-user endpoint for the explicit identifier before rejecting it.
    try {
      values = await client.request(
        `user/assignable/search?project=${target}&accountId=${encodeURIComponent(search)}&startAt=0&maxResults=1000`,
      );
    } catch (error) {
      if (![400, 404].includes((error as { status?: number }).status || 0)) throw error;
    }
  }
  if (!Array.isArray(values)) throw new Error('Jira 用户查询响应无效');
  return {
    project: target,
    users: values.filter((row) => row.active !== false).map(normalizeUser),
    complete: values.length < 1000,
  };
}

export async function createContext(client: JiraClient, input: CreateIssueInput) {
  const project = projectFor(client, input.project);
  const meta = await metadata(client, project, input.issueType?.trim() || 'Task');
  const [me, sprints] = await Promise.all([client.me(), client.sprints(project)]);
  return { project, ...meta, sprints, defaultAssignee: me };
}

export async function prepareCreate(client: JiraClient, input: CreateIssueInput) {
  const context = await createContext(client, input);
  let assignee = context.defaultAssignee;
  if (input.assignee && input.assignee !== 'me') {
    const found = await assignableUsers(client, context.project, input.assignee, context.defaultAssignee);
    const exact = found.users.filter((user) =>
      [user.name, user.accountId, user.key].includes(input.assignee),
    );
    const matching = exact.length ? exact : found.users.filter((user) => user.displayName === input.assignee);
    if (matching.length !== 1 || (!exact.length && !found.complete))
      throw new Error(
        `无法唯一匹配可分配用户「${input.assignee}」，请用 users 查询后指定 username/accountId；候选：${found.users.map((user) => `${user.displayName} (${user.accountId || user.name})`).join('、') || '无'}`,
      );
    assignee = matching[0];
  }
  if (!assignee.active) throw new Error('负责人账号已停用');
  const sprintChoice = input.sprint || 'current';
  const active = context.sprints.filter((sprint) => sprint.state === 'active');
  const matchingSprints =
    sprintChoice === 'current'
      ? active
      : active.filter((sprint) => String(sprint.id) === sprintChoice || sprint.name === sprintChoice);
  if (sprintChoice !== 'none' && matchingSprints.length !== 1)
    throw new Error(
      `请指定唯一的进行中迭代（--sprint ID），或明确使用 none 放入待办池。当前候选：${active.map((sprint) => `${sprint.name} (${sprint.id})`).join('、') || '无'}`,
    );
  const sprint = sprintChoice === 'none' ? null : matchingSprints[0];
  const extra = input.fields || {};
  if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('fields 必须是对象');
  const protectedFields = [
    'project',
    'issuetype',
    'summary',
    'description',
    'assignee',
    client.profile.sprintField,
  ];
  if (Object.keys(extra).some((field) => protectedFields.includes(field)))
    throw new Error('项目、类型、标题、正文、负责人和迭代请使用专用参数，不能通过 fields 覆盖');
  const fields: Json = {
    ...extra,
    project: { key: context.project },
    issuetype: { id: context.issueType.id },
    summary: input.summary?.trim() || '',
    assignee: userField(assignee),
  };
  if (input.description !== undefined) fields.description = input.description;
  if (context.fields.reporter?.required && fields.reporter === undefined)
    fields.reporter = userField(context.defaultAssignee);
  if (sprint) fields[client.profile.sprintField] = sprint.id;
  for (const field of Object.keys(fields)) {
    if (!context.fields[field])
      throw new Error(`创建页面不支持字段 ${field}；请先在 Jira 创建页面配置该字段，未创建任务`);
  }
  const missing = Object.entries(context.fields)
    .filter(
      ([key, definition]) =>
        definition.required &&
        !definition.hasDefaultValue &&
        (fields[key] === undefined ||
          fields[key] === null ||
          fields[key] === '' ||
          (Array.isArray(fields[key]) && !fields[key].length)),
    )
    .map(([key, definition]) => ({
      key,
      name: definition.name || key,
      allowedValues: definition.allowedValues,
    }));
  if (!fields.summary && !missing.some((field) => field.key === 'summary'))
    missing.push({ key: 'summary', name: '标题', allowedValues: undefined });
  if (fields.summary.length > 255) throw new Error('任务标题不能超过 255 个字符');
  return {
    apply: false,
    ready: missing.length === 0,
    project: context.project,
    issueType: context.issueType,
    assignee,
    sprint,
    fields,
    missingFields: missing,
  };
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
export function queryJql(args: {
  jql?: string;
  assignee?: string;
  sprint?: string;
  issueType?: string;
}): string {
  if (args.jql !== undefined) {
    if (args.assignee !== undefined || args.sprint !== undefined || args.issueType !== undefined)
      throw new Error('自定义 JQL 与负责人/迭代/类型筛选不能同时使用');
    return args.jql;
  }
  const assignee = args.assignee || 'me';
  const sprint = args.sprint || 'current';
  const parts = [];
  if (assignee !== 'all')
    parts.push(assignee === 'me' ? 'assignee = currentUser()' : `assignee = ${jqlString(assignee)}`);
  if (sprint !== 'all')
    parts.push(
      sprint === 'current'
        ? 'sprint in openSprints()'
        : sprint === 'none'
          ? 'sprint IS EMPTY'
          : `sprint = ${/^\d+$/.test(sprint) ? sprint : jqlString(sprint)}`,
    );
  if (args.issueType) parts.push(`issuetype = ${jqlString(args.issueType)}`);
  return parts.join(' AND ') + ' ORDER BY updated DESC';
}
