import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { JiraService, normalizeProfile, jsonWrite } from '../dist/test-exports.js';
test('派发重试保留会话和 request ID，创建失败可以恢复，成功不重复投递', async () => {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const temp = await mkdtemp(path.resolve('.task-temp', 'dispatch-test-'));
  const old = process.env.JIRA_FLOW_HOME;
  process.env.JIRA_FLOW_HOME = temp;
  let created = 0,
    sent = 0,
    first = true;
  const ids = [];
  const adapter = {
    targets: async () => ({ sessions: [], presets: [] }),
    create: async (input) => {
      created++;
      if (first) {
        first = false;
        throw new Error('temporary');
      }
      return input.sessionId;
    },
    send: async (_id, requestId) => {
      sent++;
      ids.push(requestId);
    },
  };
  const service = new JiraService(adapter);
  try {
    const profile = normalizeProfile({
      id: 'test',
      host: 'https://jira.example.test',
      projectKeys: ['PROJ'],
      workspace: temp,
      credentialStore: 'environment',
    });
    await jsonWrite(path.join(temp, 'profiles/test.json'), profile);
    const directory = path.join(temp, 'batch');
    await mkdir(directory);
    await jsonWrite(path.join(directory, 'manifest.json'), {
      id: 'batch-1',
      profile: 'test',
      keys: ['PROJ-1'],
      directory,
      assets: [],
      instruction: 'read',
      issues: [],
    });
    await writeFile(path.join(directory, 'combined.md'), 'fixture');
    await jsonWrite(path.join(temp, 'packages/batch-1.json'), { directory });
    const args = { profile: 'test', packageId: 'batch-1', runId: 'run-1' };
    await assert.rejects(() => service.execute('dispatch', args), /temporary/);
    assert.equal(sent, 0);
    const result = await service.execute('dispatch', args);
    assert.equal(result.state, 'delivered');
    assert.equal(created, 2);
    assert.equal(sent, 1);
    await service.execute('dispatch', args);
    assert.equal(sent, 1);
    await assert.rejects(() => service.execute('dispatch', { ...args, prompt: 'different' }), /参数已改变/);
  } finally {
    service.dispose();
    if (old === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old;
    assert.ok(temp.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
});
test('history 批量读取隔离单条失败；issue 精简输出；精简列表不覆盖看板缓存', async () => {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const temp = await mkdtemp(path.resolve('.task-temp', 'agent-read-test-'));
  const old = {
    home: process.env.JIRA_FLOW_HOME,
    auth: process.env.JIRA_FLOW_AUTH_TEST,
    fetch: globalThis.fetch,
  };
  process.env.JIRA_FLOW_HOME = temp;
  process.env.JIRA_FLOW_AUTH_TEST = JSON.stringify({ kind: 'bearer', secret: 'fixture-token' });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const issue = (key) => ({
    id: '1',
    key,
    fields: {
      project: { key: 'PROJ' },
      summary: '示例任务',
      issuetype: { name: 'Bug' },
      status: { id: '3', name: 'Open', statusCategory: { key: 'new' } },
      attachment: [],
      description: '复现步骤',
    },
    renderedFields: { description: '<p>复现步骤</p>' },
  });
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    const { pathname, search } = new URL(url);
    if (pathname.endsWith('/search')) return json({ issues: [issue('PROJ-1')], total: 1, maxResults: 100 });
    if (pathname.endsWith('/comment')) return json({ comments: [], total: 0 });
    const key = pathname.match(/issue\/([^/]+)/)?.[1];
    if (!search.includes('changelog')) return json(issue(key));
    historyCalls++;
    if (key === 'PROJ-2') return json({ errorMessages: ['不存在'] }, 404);
    return json({
      key,
      changelog: {
        total: 1,
        histories: [
          {
            id: '1',
            created: '2026-10-20T10:00:00.000+0800',
            author: { name: 'dev', displayName: 'Dev', avatarUrls: { '16x16': 'x' } },
            items: [
              {
                field: 'status',
                fieldtype: 'jira',
                from: '1',
                fromString: 'Open',
                to: '2',
                toString: 'In Review',
              },
              {
                field: 'description',
                fieldtype: 'jira',
                from: null,
                fromString: 'a',
                to: null,
                toString: 'b',
              },
            ],
          },
        ],
      },
    });
  };
  const service = new JiraService();
  try {
    await jsonWrite(
      path.join(temp, 'profiles/test.json'),
      normalizeProfile({
        id: 'test',
        host: 'https://jira.example.test',
        projectKeys: ['PROJ'],
        credentialStore: 'environment',
      }),
    );
    const single = await service.execute('history', { profile: 'test', key: 'PROJ-1' });
    assert.equal(single.histories[0].items.length, 2);
    assert.ok(single.histories[0].author.avatarUrls);

    historyCalls = 0;
    const batch = await service.execute('history', {
      profile: 'test',
      keys: ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-1'],
      changeFields: ['status'],
    });
    assert.equal(historyCalls, 3);
    assert.deepEqual(
      batch.items.map((item) => item.key),
      ['PROJ-1', 'PROJ-2', 'PROJ-3'],
    );
    assert.equal(batch.complete, false);
    assert.match(batch.items[1].error, /404/);
    assert.deepEqual(batch.items[0].histories[0].author, { name: 'dev', displayName: 'Dev' });
    assert.deepEqual(
      batch.items[2].histories[0].items.map((item) => item.field),
      ['status'],
    );

    const full = await service.execute('issue', { profile: 'test', key: 'PROJ-1' });
    const compact = await service.execute('issue', { profile: 'test', key: 'PROJ-1', detail: 'compact' });
    assert.ok(full.description && full.bodyMarkdown && full.markdown);
    assert.equal(compact.description, undefined);
    assert.equal(compact.bodyMarkdown, undefined);
    assert.ok(compact.markdown.includes('复现步骤'));

    const cache = path.join(temp, 'cache/test.json');
    await service.execute('search', { profile: 'test', jql: 'key = PROJ-1', includeDescription: false });
    await assert.rejects(() => readFile(cache, 'utf8'), { code: 'ENOENT' });
    await service.execute('search', { profile: 'test', jql: 'key = PROJ-1' });
    assert.ok(JSON.parse(await readFile(cache, 'utf8')).issues[0].description.includes('复现步骤'));
  } finally {
    service.dispose();
    globalThis.fetch = old.fetch;
    if (old.home === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old.home;
    if (old.auth === undefined) delete process.env.JIRA_FLOW_AUTH_TEST;
    else process.env.JIRA_FLOW_AUTH_TEST = old.auth;
    assert.ok(temp.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
});
