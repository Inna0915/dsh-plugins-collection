// 按个人口径汇总周期内的开发完成、Bug 修复、跨期验证与在途事项。
// 数据来自 Jira Flow 运行层（doctor + search + 批量 history），只读；凭证由运行层管理，本脚本不读取。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TZ = 8 * HOUR; // Asia/Shanghai
const REJECTED = /否决|重复|取消|不修复|无法重现|不是问题|won't|duplicate|cannot reproduce|not a bug|rejected/i;
const BATCH = 500; // Jira Flow history 单次上限

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true;
    else { o[k] = v; i++; }
  }
  return o;
}

// 周：周一 00:00 至下周一 00:00；月：1 日 00:00 至下月 1 日 00:00；结束时刻不含
function periodRange(period, anchor) {
  const s = new Date(anchor + TZ);
  const y = s.getUTCFullYear(), m = s.getUTCMonth(), d = s.getUTCDate();
  if (period === 'month') return [Date.UTC(y, m, 1) - TZ, Date.UTC(y, m + 1, 1) - TZ];
  const start = Date.UTC(y, m, d - ((s.getUTCDay() + 6) % 7)) - TZ;
  return [start, start + 7 * DAY];
}

const parseTime = (s) => Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
const fmt = (ms) => new Date(ms + TZ).toISOString().slice(0, 16).replace('T', ' ');
const fmtDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);

const args = parseArgs(process.argv.slice(2));
const profileArgs = args.profile ? ['--profile', args.profile] : [];
const period = args.period === 'month' ? 'month' : 'week';
const anchor = args.date ? parseTime(`${args.date}T12:00:00+08:00`) : Date.now();
let [start, end] = periodRange(period, anchor);
if (args.start) start = parseTime(args.start);
if (args.end) end = parseTime(args.end);
if (!(start < end)) {
  process.stderr.write('周期无效：请检查 --date/--start/--end（ISO 时间需带时区）。\n');
  process.exit(1);
}

let cli;
try {
  const home = process.env.JIRA_FLOW_HOME || path.join(homedir(), '.jira-flow');
  ({ cli } = JSON.parse(await readFile(path.join(home, 'installation.json'), 'utf8')));
} catch {
  process.stderr.write('Jira Flow 未安装。请在运行层执行 skills install；不要向聊天提供凭证。\n');
  process.exit(1);
}

function jira(cmdArgs) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...cmdArgs, ...profileArgs],
      { maxBuffer: 256 << 20, windowsHide: true, timeout: 5 * 60_000 },
      (err, stdout, stderr) => {
        let body;
        try { body = JSON.parse(stdout); } catch {
          return reject(new Error(`${cmdArgs[0]} 输出无法解析：${String(stderr || stdout || err).slice(0, 300)}`));
        }
        if (!body.ok) return reject(new Error(`${cmdArgs[0]} 失败：${JSON.stringify(body.error ?? body).slice(0, 300)}`));
        resolve(body.data);
      });
  });
}

// 未指定 --user 时用 Jira 登录账号；与候选查询并行，省一次进程等待
const explicitUser = args.user || process.env.JIRA_REPORT_USER;
const who = explicitUser ? `"${explicitUser}"` : 'currentUser()';
const jql = `(assignee = ${who} OR assignee WAS ${who} OR reporter = ${who}) AND updated >= "${fmtDate(start - DAY)}" ORDER BY updated DESC`;
const [me, found] = await Promise.all([
  explicitUser
    ? { name: explicitUser, displayName: explicitUser }
    : jira(['doctor']).then((d) => ({ name: d.user?.name || d.user?.accountId, displayName: d.user?.displayName })),
  jira(['search', '--jql', jql, '--limit', '500', '--no-description']),
]);
if (!me.name) throw new Error('无法确定当前 Jira 用户，请用 --user 指定');
const isMe = (name) => !!name && (name === me.name || name === me.displayName);

const warnings = [];
if (found.complete === false) warnings.push(`候选列表不完整：total=${found.total}，已取 ${found.issues.length}`);

// 一次进程批量读取历史，只取状态、经办人、解决结果
const histories = new Map();
const keys = found.issues.map((i) => i.key);
for (let i = 0; i < keys.length; i += BATCH) {
  const chunk = keys.slice(i, i + BATCH);
  const data = await jira(['history', ...chunk, '--change-fields', 'status,assignee,resolution']);
  const items = chunk.length === 1 ? [{ key: chunk[0], ...data }] : data.items;
  for (const item of items) histories.set(item.key, item);
}

const inP = (t) => t >= start && t < end;
const isDone = (s) => /^(Closed|Done)/.test(s);
const groups = {
  devDone: [], bugFixed: [], bugCarried: [], selfClosed: [], rejected: [],
  reviewedOnly: [], othersDev: [], devEarlierClosedNow: [], inFlight: [],
};

for (const issue of found.issues) {
  const h = histories.get(issue.key);
  if (!h || h.error) { warnings.push(`${issue.key} 历史读取失败：${h?.error || '无返回'}`); continue; }
  if (h.complete === false) warnings.push(`${issue.key} 历史不完整`);
  const ev = [];
  for (const rec of h.histories ?? []) {
    const t = parseTime(rec.created);
    for (const it of rec.items ?? []) {
      ev.push({ t, by: rec.author?.name, field: it.field, from: it.fromString || '', to: it.toString || '' });
    }
  }
  ev.sort((a, b) => a.t - b.t);

  const status = ev.filter((e) => e.field === 'status');
  const isBug = issue.type === 'Bug';
  const rejected = REJECTED.test(issue.resolution || '');
  const parent = (issue.links ?? []).find((l) => /child of/i.test(l.relation));
  const row = (t, note) => ({
    key: issue.key, summary: issue.summary.replace(/\s+/g, ' ').trim(), type: issue.type,
    status: issue.status?.name, assignee: issue.assignee, reporter: issue.reporter,
    resolution: issue.resolution, parent: parent ? `${parent.key} ${parent.summary}` : '',
    url: issue.url, time: t ? fmt(t) : '', note: note || '',
  });

  const mine = (prefix) => status.filter((e) => e.to.startsWith(prefix) && isMe(e.by));
  const devMarks = mine('Build Done');
  const fixMarks = mine('In Review');
  const devIn = devMarks.filter((e) => inP(e.t)).at(-1);
  const fixIn = fixMarks.filter((e) => inP(e.t)).at(-1);
  const closedIn = status.filter((e) => isDone(e.to) && inP(e.t)).at(-1);
  const rejectedNote = rejected ? `解决结果：${issue.resolution}` : '';

  if (!isBug && devIn) {
    groups.devDone.push(row(devIn.t, devMarks.some((e) => e.t < start) ? '前期已开发完成过，本期再次完成（返工）' : ''));
  }
  if (isBug && fixIn) {
    (rejected ? groups.rejected : groups.bugFixed).push(row(fixIn.t, rejectedNote));
  }
  if (isBug && !fixIn && closedIn) {
    const lastFix = fixMarks.filter((e) => e.t < start).at(-1);
    if (lastFix) groups.bugCarried.push(row(lastFix.t, `上期 ${fmt(lastFix.t)} 修复，本期 ${fmt(closedIn.t)} 验证关闭`));
  }
  if (!isBug && !devIn && closedIn) {
    const lastDev = devMarks.filter((e) => e.t < start).at(-1);
    if (lastDev) groups.devEarlierClosedNow.push(row(closedIn.t, `开发完成于 ${fmt(lastDev.t)}`));
  }

  // 本人在期内关闭但未经过本人修复/开发流转
  const selfClose = status.filter((e) => isMe(e.by) && isDone(e.to) && inP(e.t)
    && !/^(In Review|Integrat)/.test(e.from)).at(-1);
  if (selfClose && !fixIn && !devIn) {
    (rejected ? groups.rejected : groups.selfClosed).push(row(selfClose.t, rejectedNote || `由「${selfClose.from}」直接关闭`));
  }

  if (isBug && !fixIn) {
    const otherFix = status.filter((e) => e.to.startsWith('In Review') && !isMe(e.by) && inP(e.t)).at(-1);
    if (otherFix && ev.some((e) => e.field === 'assignee' && isMe(e.to) && inP(e.t))) {
      groups.reviewedOnly.push(row(otherFix.t, `${otherFix.by} 修复，经你审核`));
    }
  }
  if (!isBug && !devIn && isMe(issue.reporter)) {
    const otherDev = status.filter((e) => e.to.startsWith('Build Done') && !isMe(e.by) && inP(e.t)).at(-1);
    if (otherDev) groups.othersDev.push(row(otherDev.t, `${otherDev.by} 开发`));
  }

  const assignedToMe = isMe(issue.assigneeId) || isMe(issue.assignee);
  if (issue.status?.category !== 'done' && (assignedToMe || devMarks.length)) {
    groups.inFlight.push(row(0, assignedToMe ? '经办人为你' : `你已开发完成，当前经办人 ${issue.assignee || '无'}`));
  }
}

for (const list of Object.values(groups)) list.sort((a, b) => a.time.localeCompare(b.time));

const meta = {
  user: me.name, period, start: fmt(start), end: fmt(end), timezone: 'Asia/Shanghai',
  candidates: found.issues.length, searchComplete: found.complete !== false,
  fetchedAt: found.fetchedAt, jql: found.jql || jql, warnings,
};

if (args.format === 'json') {
  process.stdout.write(`${JSON.stringify({ meta, ...groups }, null, 2)}\n`);
} else {
  const line = (r) => `- [${r.key}](${r.url}) ${r.summary} · ${r.type} · ${r.time || r.status}`
    + (r.time ? ` · ${r.status}` : '') + (r.parent ? ` · 父：${r.parent}` : '') + (r.note ? ` · ${r.note}` : '');
  const section = (title, list) => `## ${title}（${list.length}）\n\n${list.length ? list.map(line).join('\n') : '无'}\n`;
  process.stdout.write([
    `# 个人${period === 'month' ? '月' : '周'}报事实（${me.name}）\n`,
    `周期：${meta.start} ≤ 事件时间 < ${meta.end}（Asia/Shanghai）`,
    `候选：${meta.candidates}；候选完整：${meta.searchComplete}；读取时间：${meta.fetchedAt || '未知'}\n`,
    section('开发完成：本人转「Build Done」', groups.devDone),
    section('Bug 修复：本人转「In Review」', groups.bugFixed),
    section('待确认：上期修复、本期验证关闭', groups.bugCarried),
    section('待确认：本人直接关闭（未走修复/测试流转）', groups.selfClosed),
    section('前期开发、本期测试关闭', groups.devEarlierClosedNow),
    section('不计入：否决/重复/取消', groups.rejected),
    section('不计入：他人修复、经你审核', groups.reviewedOnly),
    section('不计入：你报告、他人开发', groups.othersDev),
    section('当前在途', groups.inFlight),
    `## 数据说明\n\n查询：\`${meta.jql}\`\n${warnings.length ? warnings.map((w) => `- ${w}`).join('\n') : '- 候选任务状态历史均已读取。'}\n`,
  ].join('\n'));
}
