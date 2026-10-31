import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { dshAdapter } from '../dist/test-exports.js';
await mkdir('.task-temp', { recursive: true });
test('DSH 图片按原字节进入消息，投递使用队列和稳定请求 ID', async () => {
  const directory = await mkdtemp(path.resolve('.task-temp', 'image-adapter-'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUioAAAAASUVORK5CYII=',
    'base64',
  );
  let received;
  const adapter = dshAdapter({
    get: (name) =>
      name === 'sessionController'
        ? {
            prompt: async (value) => {
              received = value;
            },
          }
        : undefined,
  });
  try {
    await writeFile(path.join(directory, 'image.png'), image);
    await adapter.send(
      'session-1',
      'request-1',
      {
        directory,
        instruction: 'read',
        markdown: '# fixture',
        assets: [
          {
            status: 'downloaded',
            path: 'image.png',
            mimeType: 'image/png',
            issueKey: 'PROJ-1',
            filename: 'image.png',
          },
        ],
      },
      'test',
      true,
      new AbortController().signal,
    );
    assert.equal(received.mode, 'queue');
    assert.equal(received.requestId, 'request-1');
    const part = received.content.find((p) => p.type === 'image');
    assert.deepEqual(Buffer.from(part.data, 'base64'), image);
    assert.equal(part.mediaType, 'image/png');
  } finally {
    assert.ok(directory.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
