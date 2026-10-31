import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../dist/test-exports.js';
test('本机 API 检查来源与页面令牌，测试服务器完整关闭', async () => {
  const fake = { adapter: undefined, execute: async () => ({ safe: true }), dispose() {} };
  const app = await serve(0, fake);
  try {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const bootstrap = await (await fetch(`${origin}/jira-flow/bootstrap`)).json();
    let response = await fetch(`${origin}/jira-flow/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PAGE_TOKEN_EXPIRED');
    response = await fetch(`${origin}/jira-flow/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-jira-flow-token': bootstrap.token,
        Origin: 'https://untrusted.example',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/jira-flow/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-jira-flow-token': bootstrap.token },
      body: JSON.stringify({ operation: 'profiles' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { safe: true });
  } finally {
    await app.close();
    assert.equal(app.server.listening, false);
  }
});
