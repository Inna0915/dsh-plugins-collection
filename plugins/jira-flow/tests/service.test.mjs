import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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
