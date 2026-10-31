import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import {
  JiraClient,
  JiraService,
  normalizeProfile,
  prepareImages,
  uploadImages,
  imageManifest,
  jsonWrite,
} from '../dist/test-exports.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGwoAAAAASUVORK5CYII=',
  'base64',
);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function sandbox(run) {
  await mkdir(path.resolve('.task-temp'), { recursive: true });
  const root = await mkdtemp(path.resolve('.task-temp/images-test-'));
  const old = process.env.JIRA_FLOW_HOME;
  process.env.JIRA_FLOW_HOME = path.join(root, 'data');
  try {
    const files = [path.join(root, '截图一.png'), path.join(root, '截图二.png')];
    await Promise.all(files.map((file) => writeFile(file, png)));
    await run({ root, files });
  } finally {
    if (old === undefined) delete process.env.JIRA_FLOW_HOME;
    else process.env.JIRA_FLOW_HOME = old;
    assert.ok(root.startsWith(path.resolve('.task-temp') + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}
function fixture(options = {}) {
  const profile = normalizeProfile({
    id: 'test',
    host: 'https://jira.example.test',
    projectKeys: ['DEMO'],
    allowWrites: options.writable !== false,
    sprintField: 'customfield_10020',
  });
  const state = { creates: 0, uploads: [], enabled: true, limit: 100 * 1024 * 1024, ...options };
  const client = new JiraClient(profile, { kind: 'bearer', secret: 'synthetic-token' }, async (url, init) => {
    const endpoint = new URL(url).pathname.replace('/rest/api/2/', '');
    if (endpoint === 'attachment/meta') return json({ enabled: state.enabled, uploadLimit: state.limit });
    if (endpoint === 'issue/DEMO-1/attachments') {
      assert.equal(init.headers['X-Atlassian-Token'], 'no-check');
      assert.equal(init.headers['Content-Type'], undefined);
      assert.equal(init.redirect, 'manual');
      const file = init.body.get('file');
      const bytes = Buffer.from(await file.arrayBuffer());
      state.uploads.push({ name: file.name, type: file.type, bytes });
      if (state.uploadReply) return state.uploadReply(file, state.uploads.length);
      return json([
        {
          id: String(state.uploads.length),
          filename: file.name,
          mimeType: file.type,
          size: bytes.length,
          content: `https://jira.example.test/attachment/${state.uploads.length}`,
        },
      ]);
    }
    if (endpoint === 'issue/DEMO-1') {
      if (state.detailError) throw new Error('read failed');
      return json({
        id: '1',
        key: 'DEMO-1',
        fields: { project: { key: 'DEMO' }, summary: 'Fixture', status: { id: '1', name: 'Open' } },
      });
    }
    if (endpoint === 'issue' && init.method === 'POST') {
      state.creates++;
      return json({ id: '1', key: 'DEMO-1' }, 201);
    }
    if (endpoint.endsWith('/issuetypes')) return json({ values: [{ id: '1', name: 'Bug' }], isLast: true });
    if (endpoint.includes('/issuetypes/'))
      return json({
        values: ['project', 'issuetype', 'summary', 'description', 'assignee', 'customfield_10020'].map(
          (fieldId) => ({ fieldId, name: fieldId, required: fieldId === 'summary' }),
        ),
        isLast: true,
      });
    if (endpoint === 'myself') return json({ name: 'self', displayName: 'Self', active: true });
    if (String(url).includes('/board') && !String(url).includes('/sprint'))
      return json({ values: [{ id: 1, name: 'Board' }], isLast: true });
    if (String(url).includes('/sprint'))
      return json({ values: [{ id: 12, name: 'Current', state: 'active' }], isLast: true });
    throw new Error(`Unexpected fixture endpoint ${endpoint}`);
  });
  const service = new JiraService();
  service.client = async () => client;
  return { service, client, state };
}
test('create image preview checks file bytes and settings without sending or persisting an operation', () =>
  sandbox(async ({ files, root }) => {
    const f = fixture();
    try {
      const result = await f.service.execute('create', {
        profile: 'test',
        issueType: 'Bug',
        summary: 'Fixture',
        imagePaths: files,
      });
      assert.equal(result.apply, false);
      assert.equal(result.ready, true);
      assert.equal(result.images.length, 2);
      assert.equal(result.images[0].mimeType, 'image/png');
      assert.equal('bytes' in result.images[0], false);
      assert.equal(f.state.creates, 0);
      assert.equal(f.state.uploads.length, 0);
      await assert.rejects(readFile(path.join(root, 'data/operations', `${result.requestId}.json`)), {
        code: 'ENOENT',
      });
    } finally {
      f.service.dispose();
    }
  }));
test('partial upload retains created issue; restart and retry skips successful files and never creates twice', () =>
  sandbox(async ({ files }) => {
    const f = fixture({
      uploadReply: (file, n) =>
        n === 2
          ? json({ errorMessages: ['Permission denied'] }, 403)
          : json([{ id: String(n), filename: file.name, mimeType: file.type, size: png.length }]),
    });
    const args = {
      profile: 'test',
      issueType: 'Bug',
      summary: 'Fixture',
      imagePaths: files,
      apply: true,
      requestId: 'create-with-images',
    };
    try {
      const first = await f.service.execute('create', args);
      assert.equal(first.created, true);
      assert.equal(first.key, 'DEMO-1');
      assert.equal(first.uploads.complete, false);
      assert.deepEqual(
        first.uploads.images.map((row) => row.state),
        ['uploaded', 'failed'],
      );
      const resumed = new JiraService();
      resumed.client = async () => f.client;
      try {
        const second = await resumed.execute('create', args);
        assert.equal(second.key, first.key);
        assert.equal(second.uploads.complete, true);
        assert.equal(f.state.creates, 1);
        assert.equal(f.state.uploads.length, 3);
        assert.equal(f.state.uploads[2].name, path.basename(files[1]));
        assert.deepEqual(f.state.uploads[0].bytes, png);
        await rm(files[0]);
        await rm(files[1]);
        const again = await resumed.execute('attach', {
          profile: 'test',
          key: first.key,
          imagePaths: files,
          requestId: first.uploadRequestId,
          apply: true,
        });
        assert.equal(again.complete, true);
        assert.equal(f.state.uploads.length, 3);
      } finally {
        resumed.dispose();
      }
    } finally {
      f.service.dispose();
    }
  }));
test('timeout, malformed receipts and interrupted uploading state are never replayed automatically', () =>
  sandbox(async ({ files, root }) => {
    const f = fixture({
      uploadReply: () => {
        throw new Error('lost response');
      },
    });
    try {
      const first = await uploadImages(f.client, 'DEMO-1', [files[0]], 'unknown');
      assert.equal(first.images[0].state, 'unknown');
      await uploadImages(f.client, 'DEMO-1', [files[0]], 'unknown');
      assert.equal(f.state.uploads.length, 1);
      const manifest = imageManifest(await prepareImages(f.client, [files[1]]));
      await jsonWrite(path.join(root, 'data/uploads/interrupted.json'), {
        requestId: 'interrupted',
        profile: 'test',
        key: 'DEMO-1',
        images: manifest.map((row) => ({ ...row, state: 'uploading' })),
      });
      const interrupted = await uploadImages(f.client, 'DEMO-1', [files[1]], 'interrupted');
      assert.equal(interrupted.images[0].state, 'unknown');
      assert.equal(f.state.uploads.length, 1);
      f.state.uploadReply = () => json([]);
      const malformed = await uploadImages(f.client, 'DEMO-1', [files[1]], 'malformed');
      assert.equal(malformed.images[0].state, 'unknown');
      await uploadImages(f.client, 'DEMO-1', [files[1]], 'malformed');
      assert.equal(f.state.uploads.length, 2);
    } finally {
      f.service.dispose();
    }
  }));
test('changed file content and upload ID target changes cannot replace the original upload silently', () =>
  sandbox(async ({ files }) => {
    const f = fixture({ uploadReply: () => json({}, 403) });
    try {
      await uploadImages(f.client, 'DEMO-1', [files[0]], 'same-upload');
      await writeFile(files[0], Buffer.concat([png, Buffer.from('changed')]));
      const changed = await uploadImages(f.client, 'DEMO-1', [files[0]], 'same-upload');
      assert.equal(changed.images[0].state, 'failed');
      assert.match(changed.images[0].error, /内容已改变/);
      assert.equal(f.state.uploads.length, 1);
      await assert.rejects(uploadImages(f.client, 'DEMO-2', [files[0]], 'same-upload'), /其他任务/);
      await assert.rejects(uploadImages(f.client, 'OTHER-1', [files[0]], 'foreign'), /范围/);
    } finally {
      f.service.dispose();
    }
  }));
test('local validation, Jira limits and disabled attachments fail before issue creation', () =>
  sandbox(async ({ files, root }) => {
    const f = fixture();
    const args = {
      profile: 'test',
      issueType: 'Bug',
      summary: 'Fixture',
      apply: true,
      requestId: 'invalid-files',
    };
    try {
      const fake = path.join(root, 'fake.png');
      await writeFile(fake, 'not an image');
      for (const input of [
        [fake],
        ['https://example.test/photo.png'],
        ['relative.png'],
        [files[0], files[0]],
        [],
      ]) {
        await assert.rejects(f.service.execute('create', { ...args, imagePaths: input }));
      }
      f.state.enabled = false;
      await assert.rejects(f.service.execute('create', { ...args, imagePaths: files }), /未启用/);
      f.state.enabled = true;
      f.state.limit = 10;
      await assert.rejects(f.service.execute('create', { ...args, imagePaths: files }), /单张限制/);
      assert.equal(f.state.creates, 0);
      assert.equal(f.state.uploads.length, 0);
      const readOnly = fixture({ writable: false });
      try {
        await assert.rejects(
          readOnly.service.execute('attach', {
            profile: 'test',
            key: 'DEMO-1',
            imagePaths: files,
            requestId: 'read-only',
            apply: true,
          }),
          /只读/,
        );
      } finally {
        readOnly.service.dispose();
      }
    } finally {
      f.service.dispose();
    }
  }));
test('batch size is bounded, and a successful create survives first detail lookup failure', () =>
  sandbox(async ({ files, root }) => {
    const f = fixture();
    try {
      const big = [];
      for (let i = 0; i < 3; i++) {
        const file = path.join(root, `big-${i}.png`);
        await writeFile(file, png);
        const handle = await open(file, 'r+');
        try {
          await handle.truncate(17 * 1024 * 1024);
        } finally {
          await handle.close();
        }
        big.push(file);
      }
      await assert.rejects(prepareImages(f.client, big), /本批图片超过/);
      f.state.detailError = true;
      const result = await f.service.execute('create', {
        profile: 'test',
        issueType: 'Bug',
        summary: 'Fixture',
        imagePaths: files,
        requestId: 'detail-fails',
        apply: true,
      });
      assert.equal(result.created, true);
      assert.equal(result.uploads.complete, false);
      assert.equal(result.key, 'DEMO-1');
      f.state.detailError = false;
      await writeFile(files[0], Buffer.concat([png, Buffer.from('changed')]));
      const resumed = await f.service.execute('attach', {
        profile: 'test',
        key: result.key,
        imagePaths: files,
        requestId: result.uploadRequestId,
        apply: true,
      });
      assert.match(resumed.images[0].error, /内容已改变/);
      assert.equal(resumed.images[1].state, 'uploaded');
      assert.equal(f.state.creates, 1);
    } finally {
      f.service.dispose();
    }
  }));
test('native fetch sends actual multipart image bytes with boundary and required Jira header', async () => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': req.headers['content-type'] },
    }).formData();
    const file = data.get('file');
    received = {
      headers: req.headers,
      name: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      url: req.url,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: '1', filename: file.name, mimeType: file.type, size: png.length }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new JiraClient(
      normalizeProfile({
        id: 'test',
        host: `http://127.0.0.1:${server.address().port}`,
        projectKeys: ['DEMO'],
        allowWrites: true,
      }),
      { kind: 'bearer', secret: 'fixture-token' },
    );
    const result = await client.uploadImage(
      'DEMO-1',
      { filename: 'screen.png', mimeType: 'image/png', bytes: png },
      true,
    );
    assert.equal(result.id, '1');
    assert.deepEqual(received.bytes, png);
    assert.equal(received.headers['x-atlassian-token'], 'no-check');
    assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(received.url, '/rest/api/2/issue/DEMO-1/attachments');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
