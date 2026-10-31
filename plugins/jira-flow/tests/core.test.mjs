import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Service calls run daily maintenance on the data home; keep this file off the user's directory.
await mkdir(path.resolve('.task-temp'), { recursive: true });
const isolatedHome = await mkdtemp(path.resolve('.task-temp', 'core-test-'));
process.env.JIRA_FLOW_HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
import {
  JiraClient,
  JiraService,
  normalizeProfile,
  normalizeIssue,
  scopedJql,
  columnFor,
  issueMarkdown,
  exportTasks,
  safeFilename,
  weekRange,
  milestones,
  inside,
  resolveAttachment,
  compactHistories,
} from '../dist/test-exports.js';

const profile = normalizeProfile({
  id: 'test',
  host: 'https://jira.example.test',
  projectKeys: ['PROJ'],
  allowWrites: true,
  credentialStore: 'environment',
});
const raw = (key = 'PROJ-1') => ({
  id: '1',
  key,
  fields: {
    project: { key: 'PROJ' },
    summary: '示例任务',
    issuetype: { name: 'Bug' },
    status: { id: '3', name: 'EXECUTION', statusCategory: { key: 'indeterminate' } },
    updated: '2026-10-20T10:00:00+0800',
    created: '2026-10-19T10:00:00+0800',
    attachment: [],
    description: '复现步骤',
  },
  renderedFields: { description: '<h2>复现</h2><p>打开页面</p>' },
});
const json = (value) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const auth = { kind: 'basic', username: 'fixture-user', secret: 'fixture-secret' };

test('正文旧图片域名通过已知附件 ID 解析，复制和导出保持图片引用', () => {
  const issue = normalizeIssue(raw(), profile);
  const canonical = 'https://jira.example.test/secure/attachment/42/image.png';
  const oldSource = 'http://old-jira.example.test/secure/attachment/42/image.png';
  issue.attachments = [
    { id: '42', filename: 'image.png', content: canonical, mimeType: 'image/png', size: 10 },
  ];
  issue.description = `<p>正文</p><img src="${oldSource}" alt="截图">`;
  issue.descriptionFormat = 'html';
  issue.comments = [{ id: '1', author: 'fixture', created: '', updated: '', body: `!${oldSource}!` }];
  assert.equal(resolveAttachment(issue, oldSource)?.content, canonical);
  assert.equal(resolveAttachment(issue, 'https://unknown.test/other.png'), undefined);
  const copied = issueMarkdown(issue);
  assert.ok(copied.includes(canonical));
  assert.ok(!copied.includes('old-jira.example.test'));
  const exported = issueMarkdown(issue, new Map([[canonical, '../assets/image.png']]));
  assert.ok(exported.includes('../assets/image.png'));
  assert.ok(!exported.includes(oldSource));
  const compact = issueMarkdown(issue, new Map(), true, {
    includeMetadata: false,
    omitInlineAttachments: true,
  });
  assert.ok(compact.startsWith('## 任务描述'));
  assert.ok(!compact.includes('## 附件'));
  assert.ok(!compact.includes('- 经办人：'));
  assert.ok(copied.includes('## 附件'));
});

test('项目边界包住 OR 条件，重开任务不依赖 resolution', () => {
  const query = scopedJql(
    profile,
    'assignee = currentUser() OR reporter = currentUser() ORDER BY created DESC',
  );
  assert.equal(
    query,
    'project IN ("PROJ") AND (assignee = currentUser() OR reporter = currentUser()) ORDER BY created DESC',
  );
  const issue = raw();
  issue.fields.resolution = { name: 'Done' };
  assert.equal(normalizeIssue(issue, profile).column, 'doing');
  assert.equal(columnFor({ id: '10', name: '验收中' }, profile), 'review');
  assert.equal(
    columnFor({ id: '11', name: 'Build Done 构建完成', statusCategory: { key: 'indeterminate' } }, profile),
    'review',
  );
});
test('按服务器实际分页长度前进，未完成分页不返回成功', async () => {
  const calls = [];
  const client = new JiraClient(profile, auth, async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.startAt);
    return json({ issues: [raw(`PROJ-${body.startAt + 1}`)], total: 3, maxResults: 1 });
  });
  const result = await client.search('', 5);
  assert.equal(result.complete, true);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(result.issues.length, 3);
  const broken = new JiraClient(profile, auth, async () => json({ issues: [], total: 10, maxResults: 100 }));
  await assert.rejects(() => broken.search(), /分页未完成/);
});
test('列表查询可不取正文，默认仍返回渲染正文', async () => {
  const bodies = [];
  const client = new JiraClient(profile, auth, async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ issues: [raw()], total: 1, maxResults: 100 });
  });
  const full = await client.search('');
  const slim = await client.search('', 500, { description: false });
  assert.ok(bodies[0].fields.includes('description'));
  assert.deepEqual(bodies[0].expand, ['renderedFields']);
  assert.ok(!bodies[1].fields.includes('description'));
  assert.equal(bodies[1].expand, undefined);
  assert.ok(full.issues[0].description.includes('<h2>'));
  assert.equal(slim.issues[0].summary, '示例任务');
});
test('精简历史只保留指定字段与作者标识，空变更整条省略', () => {
  const histories = [
    {
      id: '1',
      created: '2026-10-20T10:00:00.000+0800',
      author: { name: 'dev', displayName: 'Dev', avatarUrls: { '16x16': 'https://jira.example.test/a.png' } },
      items: [
        { field: 'status', fieldtype: 'jira', from: '1', fromString: 'Open', to: '2', toString: 'In Review' },
        { field: 'description', fieldtype: 'jira', from: null, fromString: '旧', to: null, toString: '新' },
      ],
    },
    {
      id: '2',
      created: '2026-10-21T10:00:00.000+0800',
      author: { name: 'qa' },
      items: [{ field: 'description', from: null, fromString: 'a', to: null, toString: 'b' }],
    },
  ];
  const compact = compactHistories(histories, ['Status', 'assignee']);
  assert.equal(compact.length, 1);
  assert.deepEqual(compact[0], {
    id: '1',
    created: '2026-10-20T10:00:00.000+0800',
    author: { name: 'dev', displayName: 'Dev' },
    items: [{ field: 'status', from: '1', fromString: 'Open', to: '2', toString: 'In Review' }],
  });
});
test('附件鉴权不跟随跨域重定向，也不请求外站', async () => {
  let calls = 0;
  const client = new JiraClient(profile, auth, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://outside.example/image.png' } });
  });
  await assert.rejects(() => client.download('https://outside.example/image.png'), /不是配置的 Jira/);
  assert.equal(calls, 0);
  await assert.rejects(() => client.download('/secure/attachment/1/a.png'), /不是配置的 Jira/);
  assert.equal(calls, 1);
});
test('缺少必填流转字段不会写 Jira；合法提交刷新实际状态', async () => {
  const writes = [];
  let transitioned = false;
  const client = new JiraClient(profile, auth, async (url, options) => {
    if (url.includes('/transitions') && options.method === 'GET')
      return json({
        transitions: [
          {
            id: '9',
            name: '完成',
            to: { id: '6', name: 'DONE' },
            fields: {
              resolution: { name: '解决结果', required: true, allowedValues: [{ id: '1', name: 'Done' }] },
            },
          },
        ],
      });
    if (options.method === 'POST') {
      writes.push(JSON.parse(options.body));
      transitioned = true;
      return new Response(null, { status: 204 });
    }
    const issue = raw();
    if (transitioned) issue.fields.status = { id: '6', name: 'DONE', statusCategory: { key: 'done' } };
    return json(issue);
  });
  await assert.rejects(
    () => client.transition('PROJ-1', '9', {}, '', raw().fields.updated, true),
    /解决结果/,
  );
  assert.equal(writes.length, 0);
  const result = await client.transition(
    'PROJ-1',
    '9',
    { resolution: { id: '1' } },
    '',
    raw().fields.updated,
    true,
  );
  assert.equal(result.status.name, 'DONE');
  assert.equal(writes.length, 1);
  await assert.rejects(() => client.update('OTHER-1', { summary: 'x' }, '', true), /范围/);
});
test('只读和更新冲突会阻止写请求', async () => {
  let posts = 0;
  const fetcher = async (_url, options) => {
    if (options.method !== 'GET') posts++;
    return json(raw());
  };
  const readOnly = new JiraClient({ ...profile, allowWrites: false }, auth, fetcher);
  await assert.rejects(() => readOnly.comment('PROJ-1', 'hello', true), /只读/);
  const client = new JiraClient(profile, auth, fetcher);
  await assert.rejects(() => client.update('PROJ-1', { summary: 'x' }, 'old', true), /任务已变化/);
  assert.equal(posts, 0);
});

test('列表更新时间截秒时，流转上下文取详情精确版本，真正的毫秒级修改仍被拦截', async () => {
  let updated = '2026-10-20T10:00:00.375+0800';
  let writes = 0;
  const client = new JiraClient(profile, auth, async (url, options) => {
    const issue = raw();
    issue.fields.updated = updated;
    if (url.endsWith('/search')) {
      issue.fields.updated = updated.replace(/\.\d{3}/, '.000');
      return json({ issues: [issue], total: 1 });
    }
    if (url.includes('/transitions') && options.method === 'GET') {
      return json({
        transitions: [{ id: '9', name: '开始任务', to: { id: '3', name: '进行中' }, fields: {} }],
      });
    }
    if (options.method === 'POST') {
      writes++;
      return new Response(null, { status: 204 });
    }
    return json(issue);
  });
  const service = new JiraService();
  service.client = async () => client;
  try {
    const listed = (await client.search('', 1)).issues[0];
    assert.equal(listed.updated, '2026-10-20T10:00:00.000+0800');
    await assert.rejects(() => client.transition('PROJ-1', '9', {}, '', listed.updated, true), /任务已变化/);
    const context = await service.execute('transition-context', { profile: 'test', key: 'PROJ-1' });
    assert.equal(context.issue.updated, updated);
    assert.equal(writes, 0);
    await client.transition(
      context.issue.key,
      context.transitions[0].id,
      {},
      '',
      context.issue.updated,
      true,
    );
    assert.equal(writes, 1);
    updated = '2026-10-20T10:00:00.600+0800';
    await assert.rejects(
      () => client.transition('PROJ-1', '9', {}, '', context.issue.updated, true),
      /任务已变化/,
    );
    assert.equal(writes, 1);
    const refreshed = await service.execute('transition-context', { profile: 'test', key: 'PROJ-1' });
    await client.transition('PROJ-1', '9', {}, '', refreshed.issue.updated, true);
    assert.equal(writes, 2);
  } finally {
    service.dispose();
  }
});

test('流转上下文缺少精确版本时失败，不允许空版本绕过校验', async () => {
  const service = new JiraService();
  service.client = async () => ({ get: async () => ({ updated: '' }) });
  try {
    await assert.rejects(() => service.execute('transition-context', { key: 'PROJ-1' }), /无法获取任务版本/);
  } finally {
    service.dispose();
  }
});
test('Markdown 保留表格、代码与本地图片，移除脚本链接', () => {
  const issue = normalizeIssue(raw(), profile);
  issue.description =
    '<table><tr><th>A</th><th>B</th></tr><tr><td>甲</td><td>乙</td></tr></table><pre><code>x &lt; 2</code></pre><img src="shot.png"><script>secret()</script><a href="javascript:alert(1)">bad</a>';
  const text = issueMarkdown(issue, new Map([['shot.png', '../assets/shot.png']]));
  assert.match(text, /\| A/);
  assert.match(text, /x < 2/);
  assert.match(text, /\.\.\/assets\/shot.png/);
  assert.doesNotMatch(text, /secret\(\)|javascript:/);
});
test('批量导出区分成功、失败和图片资源；文件名不能穿越目录', async () => {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const base = await mkdtemp(path.resolve('.task-temp', 'export-test-'));
  const old = process.env.JIRA_FLOW_HOME;
  process.env.JIRA_FLOW_HOME = path.join(base, 'home');
  try {
    const issue = normalizeIssue(raw(), profile);
    issue.attachments = [
      {
        id: '22',
        filename: '截图.png',
        mimeType: 'image/png',
        size: 3,
        content: 'https://jira.example.test/img.png',
      },
    ];
    issue.description = '<p>说明</p><img src="https://jira.example.test/img.png">';
    const client = {
      profile,
      get: async (key) => {
        if (key === 'PROJ-2') throw new Error('not found');
        return issue;
      },
      download: async () => ({ bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png' }),
    };
    const result = await exportTasks(client, { keys: ['PROJ-1', 'PROJ-2'], outputDir: base, zip: true });
    assert.equal(result.keys.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.assets[0].status, 'downloaded');
    assert.match(
      await readFile(path.join(result.directory, 'issues/PROJ-1.md'), 'utf8'),
      /\.\.\/assets\/PROJ-1/,
    );
    assert.equal((await readFile(result.directory + '.zip')).length > 0, true);
    assert.doesNotMatch(await readFile(result.manifestPath, 'utf8'), /fixture-secret|Authorization/);
    assert.throws(() => inside(base, '../elsewhere'), /超出/);
    assert.equal(safeFilename('CON.png'), '_CON.png');
    assert.equal(safeFilename('../../x.png').includes('/'), false);
  } finally {
    if (old === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old;
    assert.ok(base.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(base, { recursive: true, force: true });
  }
});
test('周范围按上海时区，历史事件左右边界正确且不使用 updated', () => {
  assert.deepEqual(weekRange(new Date('2026-10-25T16:05:00Z')), {
    start: '2026-10-25T16:00:00.000Z',
    end: '2026-11-01T16:00:00.000Z',
  });
  const issue = normalizeIssue(raw(), profile);
  const histories = [
    {
      id: '1',
      created: '2026-10-19T00:00:00+08:00',
      items: [{ field: 'status', fromString: 'EXECUTION', toString: 'EXECUTED' }],
    },
    {
      id: '2',
      created: '2026-10-26T00:00:00+08:00',
      items: [{ field: 'status', fromString: 'EXECUTED', toString: 'DONE' }],
    },
  ];
  const result = milestones(
    issue,
    histories,
    profile,
    '2026-10-19T00:00:00+08:00',
    '2026-10-26T00:00:00+08:00',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'development');
  const next = [
    {
      id: '3',
      created: '2026-10-21T00:00:00+08:00',
      items: [{ field: 'status', fromString: 'Build Done 构建完成', toString: 'Testing & Review 测试' }],
    },
  ];
  assert.equal(
    milestones(issue, next, profile, '2026-10-19T00:00:00+08:00', '2026-10-26T00:00:00+08:00').length,
    0,
  );
});
