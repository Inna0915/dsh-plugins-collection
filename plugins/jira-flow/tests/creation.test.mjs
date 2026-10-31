import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  JiraClient,
  JiraService,
  normalizeProfile,
  prepareCreate,
  createContext,
  queryJql,
  scopedJql,
} from '../dist/test-exports.js';
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  const profile = normalizeProfile({
    id: 'test',
    host: 'https://jira.example.test',
    projectKeys: options.projects || ['DEMO'],
    allowWrites: options.writable !== false,
    sprintField: 'customfield_10020',
  });
  const writes = [],
    reads = [];
  const types = [
    { id: '1', name: options.localized ? '任务' : 'Task' },
    { id: '2', name: 'Bug' },
    { id: '3', name: 'Story' },
    { id: '4', name: 'Sub-task', subtask: true },
  ];
  const fields = {
    project: { name: '项目', required: true },
    issuetype: { name: '类型', required: true },
    summary: { name: '标题', required: true },
    description: { name: '描述', required: false },
    assignee: { name: '负责人', required: true },
    customfield_10020: { name: 'Sprint', required: false },
    ...options.fields,
  };
  if (options.noSprintField) delete fields.customfield_10020;
  const current = options.cloud
    ? { accountId: 'account-self', displayName: 'Self', active: true }
    : { name: 'self', key: 'self-key', displayName: 'Self', active: true };
  const client = new JiraClient(profile, { kind: 'bearer', secret: 'fixture-only' }, async (url, init) => {
    const u = new URL(url),
      endpoint = u.pathname.replace('/rest/api/2/', '');
    if (endpoint === 'issue' && init.method === 'POST') {
      writes.push(JSON.parse(init.body));
      if (options.failCreate) throw new Error('connection lost');
      return json({ id: '123', key: 'DEMO-123' }, 201);
    }
    reads.push(u);
    if (endpoint === 'myself') return json(current);
    if (endpoint === 'user/assignable/search') {
      if (options.opaqueUser)
        return json(
          u.searchParams.has('accountId')
            ? [{ accountId: 'account-other', displayName: 'Other', active: true }]
            : [],
        );
      return json(options.users || [{ name: 'alice', displayName: 'Alice', active: true }]);
    }
    if (endpoint === 'issue/createmeta')
      return json({ projects: [{ key: 'DEMO', issuetypes: types.map((type) => ({ ...type, fields })) }] });
    if (endpoint.endsWith('/issuetypes')) {
      if (options.legacy) return json({}, 404);
      return json({ values: types, isLast: true });
    }
    if (endpoint.includes('/issuetypes/'))
      return json({
        values: Object.entries(fields).map(([fieldId, field]) => ({ fieldId, ...field })),
        isLast: true,
      });
    if (u.pathname.endsWith('/board')) {
      const start = Number(u.searchParams.get('startAt'));
      return json({
        values: [{ id: start + 1, name: 'Board' }],
        total: options.twoBoards ? 2 : 1,
        maxResults: 1,
      });
    }
    if (u.pathname.includes('/sprint'))
      return json({
        values: options.sprints || [
          { id: 12, name: 'Sprint 12', state: 'active' },
          { id: 13, name: 'Next', state: 'future' },
        ],
        isLast: true,
      });
    throw new Error(`Unexpected fixture request ${u.pathname}`);
  });
  return { client, profile, writes, reads };
}
test('query defaults to current user and active sprints; overrides remain explicit and project-scoped', () => {
  const f = fixture();
  assert.equal(queryJql({}), 'assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC');
  assert.equal(
    queryJql({ assignee: 'alice', sprint: '12', issueType: 'Bug' }),
    'assignee = "alice" AND sprint = 12 AND issuetype = "Bug" ORDER BY updated DESC',
  );
  assert.equal(
    scopedJql(f.profile, queryJql({ assignee: 'all', sprint: 'all' })),
    'project IN ("DEMO") ORDER BY updated DESC',
  );
  assert.equal(queryJql({ jql: 'reporter = currentUser()' }), 'reporter = currentUser()');
  assert.throws(() => queryJql({ jql: '', sprint: 'current' }), /不能同时/);
  assert.ok(queryJql({ assignee: 'a" OR x' }).includes('"a\\" OR x"'));
});
test('create preview uses self, one active sprint and metadata-required fields without writing', async () => {
  const f = fixture({ fields: { customfield_required: { name: '验收标准', required: true } } });
  const preview = await prepareCreate(f.client, { issueType: 'Bug', summary: 'Test' });
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.fields.assignee, { name: 'self' });
  assert.equal(preview.fields.customfield_10020, 12);
  assert.deepEqual(preview.fields.issuetype, { id: '2' });
  assert.equal(preview.missingFields[0].key, 'customfield_required');
  assert.equal(f.writes.length, 0);
  const plan = await prepareCreate(f.client, { summary: 'Test', fields: { customfield_required: 'given' } });
  const result = await f.client.createPrepared(plan, true);
  assert.equal(result.key, 'DEMO-123');
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.filter((url) => url.pathname.includes('/issue/DEMO-123')).length, 0);
});
test('localized Task and required reporter use actual metadata and current login; Cloud accepts opaque account IDs', async () => {
  const f = fixture({ localized: true, fields: { reporter: { name: '报告人', required: true } } });
  const plan = await prepareCreate(f.client, { summary: 'Test', assignee: 'alice' });
  assert.equal(plan.issueType.name, '任务');
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.fields.reporter, { name: 'self' });
  assert.deepEqual(plan.fields.assignee, { name: 'alice' });
  const cloud = fixture({ cloud: true, opaqueUser: true });
  const other = await prepareCreate(cloud.client, { summary: 'Test', assignee: 'account-other' });
  assert.deepEqual(other.fields.assignee, { accountId: 'account-other' });
  assert.ok(cloud.reads.some((url) => url.searchParams.get('accountId') === 'account-other'));
});
test('explicit active sprint and assignable user work; ambiguous users and future sprints are rejected', async () => {
  const f = fixture({
    sprints: [
      { id: 12, name: 'A', state: 'active' },
      { id: 14, name: 'B', state: 'active' },
      { id: 13, name: 'Next', state: 'future' },
    ],
  });
  await assert.rejects(() => prepareCreate(f.client, { summary: 'Test' }), /唯一的进行中迭代/);
  const plan = await prepareCreate(f.client, { summary: 'Test', sprint: '14', assignee: 'alice' });
  assert.equal(plan.sprint.id, 14);
  assert.deepEqual(plan.fields.assignee, { name: 'alice' });
  await assert.rejects(() => prepareCreate(f.client, { summary: 'Test', sprint: '13' }), /进行中迭代/);
  const ambiguous = fixture({
    users: [
      { name: 'one', displayName: 'Same' },
      { name: 'two', displayName: 'Same' },
    ],
  });
  await assert.rejects(
    () => prepareCreate(ambiguous.client, { summary: 'Test', assignee: 'Same' }),
    /唯一匹配/,
  );
  assert.equal(f.writes.length, 0);
});
test('Cloud user uses accountId, legacy metadata works, sprint listing is paginated and deduplicated', async () => {
  const f = fixture({ cloud: true, legacy: true, twoBoards: true });
  const plan = await prepareCreate(f.client, { summary: 'Test' });
  assert.deepEqual(plan.fields.assignee, { accountId: 'account-self' });
  assert.equal(plan.sprint.id, 12);
  assert.equal(f.reads.filter((u) => u.pathname.endsWith('/board')).length, 2);
  assert.equal((await f.client.sprints()).length, 2);
});
test('no active sprint, foreign projects, protected overrides, and unavailable creation fields fail before POST', async () => {
  const f = fixture({ sprints: [] });
  await assert.rejects(() => prepareCreate(f.client, { summary: 'Test' }), /当前候选：无/);
  const backlog = await prepareCreate(f.client, { summary: 'Test', sprint: 'none' });
  assert.equal(backlog.sprint, null);
  assert.equal('customfield_10020' in backlog.fields, false);
  await assert.rejects(() => prepareCreate(f.client, { project: 'OTHER', summary: 'Test' }), /范围/);
  await assert.rejects(
    () =>
      prepareCreate(f.client, { summary: 'Test', sprint: 'none', fields: { assignee: { name: 'other' } } }),
    /不能通过 fields/,
  );
  const missing = fixture({ noSprintField: true });
  await assert.rejects(() => prepareCreate(missing.client, { summary: 'Test' }), /创建页面不支持字段/);
  const multi = fixture({ projects: ['DEMO', 'SECOND'] });
  await assert.rejects(() => createContext(multi.client, {}), /指定项目/);
  assert.equal(f.writes.length, 0);
});
test('writes require apply and enabled connection', async () => {
  const f = fixture({ writable: false });
  const plan = await prepareCreate(f.client, { summary: 'Test' });
  await assert.rejects(() => f.client.createPrepared(plan, true), /只读/);
  const writable = fixture();
  await assert.rejects(() => writable.client.createPrepared(plan, false), /apply/);
  assert.equal(f.writes.length, 0);
  assert.equal(writable.writes.length, 0);
});
test('create receipts are idempotent, uncertain POSTs cannot replay, and previews do not consume request IDs', async () => {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const temp = await mkdtemp(path.resolve('.task-temp/create-test-'));
  const old = process.env.JIRA_FLOW_HOME;
  process.env.JIRA_FLOW_HOME = temp;
  const f = fixture();
  const service = new JiraService();
  service.client = async () => f.client;
  try {
    const args = { profile: 'test', summary: 'Test', issueType: 'Bug' };
    const preview = await service.execute('create', args);
    assert.equal(preview.apply, false);
    assert.ok(preview.requestId);
    assert.equal(f.writes.length, 0);
    const write = { ...args, apply: true, requestId: preview.requestId };
    const first = await service.execute('create', write);
    const reads = f.reads.length;
    const again = await service.execute('create', write);
    assert.deepEqual(again, first);
    assert.equal(f.writes.length, 1);
    assert.equal(f.reads.length, reads);
    await assert.rejects(() => service.execute('create', { ...write, summary: 'Different' }), /其他请求/);
    await assert.rejects(() => service.execute('create', { ...args, apply: true }), /requestId/);
    const uncertain = fixture({ failCreate: true });
    service.client = async () => uncertain.client;
    const uncertainArgs = { ...write, requestId: 'uncertain-create' };
    await assert.rejects(() => service.execute('create', uncertainArgs), /网络/);
    await assert.rejects(() => service.execute('create', uncertainArgs), /尚未确认/);
    assert.equal(uncertain.writes.length, 1);
    const incomplete = fixture({ fields: { required: { name: 'Required', required: true } } });
    service.client = async () => incomplete.client;
    const retryArgs = { ...write, requestId: 'validation-failed' };
    await assert.rejects(() => service.execute('create', retryArgs), /必填/);
    service.client = async () => f.client;
    await service.execute('create', retryArgs);
    assert.equal(f.writes.length, 2);
  } finally {
    service.dispose();
    if (old === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old;
    assert.ok(temp.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
});
