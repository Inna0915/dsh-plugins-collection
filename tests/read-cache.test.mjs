import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache } from '../dist/test-exports.js';

test('短期读取缓存合并并发、失败可重试、失效后旧请求不覆盖新结果', async () => {
  const cache = new ReadCache(1000, 2);
  let reads = 0;
  let finish;
  const first = cache.get('issue', () => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const shared = cache.get('issue', async () => {
    reads++;
    return 'wrong';
  });
  await Promise.resolve();
  assert.equal(reads, 1);
  cache.clear();
  const current = cache.get('issue', async () => 'new');
  finish('old');
  assert.deepEqual(await Promise.all([first, shared, current]), ['old', 'old', 'new']);
  assert.equal(await cache.get('issue', async () => 'wrong'), 'new');
  await assert.rejects(
    cache.get('broken', async () => {
      throw new Error('offline');
    }),
  );
  assert.equal(await cache.get('broken', async () => 'retry'), 'retry');
  cache.delete('issue');
  assert.equal(await cache.get('issue', async () => 'refreshed'), 'refreshed');
});

test('读取缓存到期重新请求，容量上限会淘汰旧条目', async () => {
  const cache = new ReadCache(0, 2);
  await cache.get('a', async () => 1);
  assert.equal(await cache.get('a', async () => 2), 2);
  const bounded = new ReadCache(1000, 2);
  await bounded.get('a', async () => 1);
  await bounded.get('b', async () => 2);
  await bounded.get('c', async () => 3);
  assert.equal(await bounded.get('a', async () => 4), 4);
});
