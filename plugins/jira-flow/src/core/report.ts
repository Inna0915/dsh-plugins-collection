import type { Issue, Profile, History } from '../types.js';
import { JiraClient, columnFor } from './jira.js';
export interface Milestone {
  key: string;
  summary: string;
  type: string;
  at: string;
  kind: 'development' | 'business' | 'reopened';
  status: string;
  actor: string;
  url: string;
}
export function milestones(
  issue: Issue,
  history: History[],
  profile: Profile,
  start: string,
  end: string,
): Milestone[] {
  const isDevelopment = (name: string | null) =>
    profile.developmentStatuses.some((status) => status.toLowerCase() === (name || '').toLowerCase()) ||
    /^(executed|build[ _-]?done|validating)(?:\s|$)/i.test(name || '');
  const isDone = (name: string | null) =>
    /^(done|closed|resolved)(?:\s|$)|^(已完成|已关闭|已解决)$/i.test(name || '') ||
    profile.statusColumns[name || ''] === 'done';
  const records: Milestone[] = [];
  for (const event of history) {
    const time = new Date(event.created).getTime();
    if (!(time >= new Date(start).getTime() && time < new Date(end).getTime())) continue;
    for (const change of event.items) {
      if (change.field.toLowerCase() !== 'status') continue;
      const returnedToWork = ['todo', 'doing'].includes(
        columnFor({ id: change.to || '', name: change.toString || '' }, profile),
      );
      const kind = isDone(change.toString)
        ? 'business'
        : isDevelopment(change.toString)
          ? 'development'
          : returnedToWork && (isDone(change.fromString) || isDevelopment(change.fromString))
            ? 'reopened'
            : undefined;
      if (kind)
        records.push({
          key: issue.key,
          summary: issue.summary,
          type: issue.type,
          at: event.created,
          kind,
          status: change.toString || '',
          actor: event.author?.displayName || event.author?.name || '',
          url: issue.url,
        });
    }
  }
  return records;
}
export function weekRange(date = new Date()): { start: string; end: string } {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay() || 7;
  const midnight =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - weekday + 1) -
    8 * 60 * 60 * 1000;
  return { start: new Date(midnight).toISOString(), end: new Date(midnight + 7 * 86400000).toISOString() };
}
export async function weeklyReport(client: JiraClient, start?: string, end?: string, query?: string) {
  const range = weekRange();
  start ||= range.start;
  end ||= range.end;
  if (
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  )
    throw new Error('周报时间范围无效');
  const startDate = new Date(Date.parse(start) - 86400000).toISOString().slice(0, 10);
  const scope =
    query?.replace(/\s+ORDER\s+BY[\s\S]*$/i, '').trim() ||
    '(assignee = currentUser() OR assignee WAS currentUser() OR reporter = currentUser())';
  const found = await client.search(`(${scope}) AND updated >= "${startDate}" ORDER BY updated DESC`, 1000);
  const events: Milestone[] = [];
  const incomplete: string[] = [];
  for (const issue of found.issues) {
    try {
      const history = await client.history(issue.key);
      events.push(...milestones(issue, history.histories, client.profile, start, end));
      if (!history.complete) incomplete.push(issue.key);
    } catch {
      incomplete.push(issue.key);
    }
  }
  const unique = (kind: Milestone['kind']) => [
    ...new Map(events.filter((event) => event.kind === kind).map((event) => [event.key, event])).values(),
  ];
  const development = unique('development');
  const business = unique('business');
  const reopened = unique('reopened');
  const active = found.issues.filter((issue) => issue.column !== 'done');
  const counts = {
    development: development.length,
    business: business.length,
    reopened: reopened.length,
    active: active.length,
  };
  const section = (name: string, rows: Milestone[]) =>
    [
      `## ${name}`,
      '',
      ...(rows.length
        ? rows.map(
            (event) =>
              `- [${event.key} ${event.summary}](<${event.url}>) · ${event.type} · ${event.at} · 操作者：${event.actor || '未知'}`,
          )
        : ['无已确认事件']),
      '',
    ].join('\n');
  const markdown = [
    '# Jira 周报事实清单',
    '',
    `范围：${start} ≤ 事件时间 < ${end}（Asia/Shanghai）`,
    `候选：${found.total}；已读：${found.issues.length}；历史不完整：${incomplete.length}`,
    '',
    `开发里程碑：${counts.development} 个任务；最终状态：${counts.business} 个任务；重开/返回开发：${counts.reopened} 个任务。`,
    '说明：本表为所选范围的事件事实；经办人、报告人和状态操作者不必然是唯一贡献者。最终状态仍需结合取消、重复等解决结果解释。',
    '',
    section('开发完成', development),
    section('业务最终状态', business),
    section('重开与返工', reopened),
    '## 当前在途',
    '',
    ...active.map(
      (issue) =>
        `- [${issue.key} ${issue.summary}](<${issue.url}>) · ${issue.status.name} · ${issue.assignee || '未分配'}`,
    ),
    '',
    '## 数据范围与缺口',
    '',
    `查询：\`${found.jql}\``,
    `读取时间：${found.fetchedAt}`,
    ...(!found.complete ? ['- 查询达到数量上限，不能视为完整周报。'] : []),
    ...(incomplete.length
      ? [`- 以下任务历史不完整，不推测完成日期：${incomplete.join(', ')}`]
      : ['- 已读取候选任务完整状态历史。']),
    '',
    '## 下周计划',
    '',
    '请结合当前在途事项与用户安排填写；不将建议写成既定计划。',
    '',
  ].join('\n');
  return {
    start,
    end,
    counts,
    events,
    issues: found.issues.map((issue) => ({
      key: issue.key,
      summary: issue.summary,
      type: issue.type,
      status: issue.status.name,
      resolution: issue.resolution,
      assignee: issue.assignee,
      url: issue.url,
    })),
    complete: found.complete && !incomplete.length,
    incomplete,
    fetchedAt: found.fetchedAt,
    query: found.jql,
    markdown,
  };
}
