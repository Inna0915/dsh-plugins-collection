import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, requiresTransitionInput } from '../dist/test-exports.js';
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('重载后的旧令牌会先重新连接，再刷新；并发请求只刷新一次令牌', async () => {
  let active = 'first',
    connects = 0,
    accepted = 0;
  const transport = createTransport(async (url, init) => {
    assert.equal(init.cache, 'no-store');
    if (url.endsWith('bootstrap')) {
      connects++;
      return response({ token: active });
    }
    if (new Headers(init.headers).get('x-jira-flow-token') !== active)
      return response({ code: 'PAGE_TOKEN_EXPIRED' }, 403);
    accepted++;
    return response({ fresh: true });
  });
  await transport.bootstrap();
  active = 'second';
  const results = await Promise.all([
    transport.request('/jira-flow/api', { method: 'POST' }),
    transport.request('/jira-flow/api', { method: 'POST' }),
  ]);
  assert.equal(connects, 2);
  assert.equal(accepted, 2);
  for (const result of results) assert.deepEqual(await result.json(), { fresh: true });
});

test('Jira 拒绝、未知写入失败与已取消请求不会自动重放', async () => {
  let writes = 0,
    connects = 0;
  const transport = createTransport(async (url) => {
    if (url.endsWith('bootstrap')) {
      connects++;
      return response({ token: 'ok' });
    }
    writes++;
    return response({ error: 'no permission' }, 403);
  });
  assert.equal((await transport.request('/jira-flow/api', { method: 'POST' })).status, 403);
  assert.equal(writes, 1);
  assert.equal(connects, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.request('/jira-flow/api', { method: 'POST' }, controller.signal));
  assert.equal(writes, 1);
  const broken = createTransport(async (url) => {
    if (url.endsWith('bootstrap')) return response({ token: 'ok' });
    writes++;
    throw new Error('connection lost after write');
  });
  await assert.rejects(broken.request('/jira-flow/api', { method: 'POST' }), /connection lost/);
  assert.equal(writes, 2);
});

test('拖到必填字段或必填评论节点先补充信息，普通节点可以直接流转', () => {
  assert.equal(requiresTransitionInput({ fields: {} }), false);
  assert.equal(requiresTransitionInput({ fields: { reason: { required: false } } }), false);
  assert.equal(requiresTransitionInput({ fields: { reason: { required: true } } }), true);
  assert.equal(requiresTransitionInput({ fields: { comment: { required: true } } }), true);
});
