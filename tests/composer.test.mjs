import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { captureCurrentComposer, prepareComposerDraft } from '../dist/test-exports.js';

function fixture() {
  let draft = '保留的草稿';
  const events = [];
  const actions = {
    captureInsertion: () => ({ start: 0, end: draft.length, draftRev: 7 }),
    insertText(text, span) {
      assert.equal(span.start, span.end, 'selected draft is never replaced');
      assert.equal(span.draftRev, 7);
      draft = draft.slice(0, span.start) + text + draft.slice(span.end);
      events.push('text');
      return true;
    },
    addAttachments: (ids) => {
      events.push(['attach', ids]);
      return true;
    },
    persistDraft: () => events.push('persist'),
  };
  let binding = {
    key: 'session-a',
    props: { inputActions: actions },
    ctx: {
      get: () => ({
        createDrafts: (id, files) => {
          events.push(['files', id, files.map((f) => f.name)]);
          return files.map((_, i) => ({ id: `image-${i}` }));
        },
        releaseDraftAttachments: (rows) => events.push(['release', rows.map((row) => row.id)]),
      }),
    },
  };
  const host = {
    uiSession: { adapter: { current: { getSnapshot: () => binding } } },
    layout: { selectPanel: (id) => events.push(['panel', id]) },
  };
  return {
    host,
    actions,
    events,
    get draft() {
      return draft;
    },
    edit: (value) => {
      draft = value;
    },
    switch: () => {
      binding = { ...binding, key: 'session-b' };
    },
  };
}
const payload = {
  text: 'DEMO-1 完整任务正文',
  images: [{ name: 'DEMO-1.png', mimeType: 'image/png', data: 'aGk=' }],
  warnings: [],
};

test('composer preserves selection and edits made during loading, attaches images once, never sends', () => {
  const f = fixture();
  const insert = captureCurrentComposer(f.host, 'session-a');
  f.edit('读取期间继续输入的原草稿');
  assert.deepEqual(insert(payload), []);
  assert.ok(f.draft.startsWith('读取期间继续输入的原草稿'));
  assert.ok(f.draft.includes(payload.text));
  assert.deepEqual(f.events, [
    ['files', 'session-a', ['DEMO-1.png']],
    'text',
    ['attach', ['image-0']],
    'persist',
    ['panel', null],
  ]);
  assert.throws(() => insert(payload), /已经添加/);
});
test('session switch and wrong pane cannot append to a different conversation', () => {
  const f = fixture();
  assert.throws(() => captureCurrentComposer(f.host, 'another'), /所属/);
  const insert = captureCurrentComposer(f.host);
  f.switch();
  assert.throws(() => insert(payload), /已切换/);
  assert.deepEqual(f.events, []);
});
test('a locked composer releases newly prepared attachments without changing existing draft', () => {
  const f = fixture();
  f.actions.insertText = () => false;
  assert.throws(() => captureCurrentComposer(f.host)(payload), /暂不可编辑/);
  assert.equal(f.draft, '保留的草稿');
  assert.deepEqual(f.events.at(-1), ['release', ['image-0']]);
});
test('attachment rejection reports partial success and prevents duplicate text on retry', () => {
  const f = fixture();
  f.actions.addAttachments = () => false;
  const insert = captureCurrentComposer(f.host);
  assert.match(insert(payload)[0], /正文已添加/);
  assert.throws(() => insert(payload), /已经添加/);
  assert.ok(f.events.some((event) => event[0] === 'release'));
});
test('draft preparation includes image bytes, identifies missing resources and rejects path escape', async () => {
  const directory = await mkdtemp(path.resolve('.task-temp/draft-test-'));
  try {
    await writeFile(path.join(directory, 'image.png'), 'synthetic bytes');
    const asset = {
      issueKey: 'DEMO-1',
      filename: 'image.png',
      path: 'image.png',
      status: 'downloaded',
      mimeType: 'image/png',
    };
    const task = {
      directory,
      instruction: '读取任务资料',
      markdown: '# DEMO-1',
      errors: [],
      assets: [asset, { ...asset, status: 'failed' }],
    };
    const draft = await prepareComposerDraft(task);
    assert.equal(draft.images.length, 1);
    assert.equal(Buffer.from(draft.images[0].data, 'base64').toString(), 'synthetic bytes');
    assert.equal(draft.warnings.length, 1);
    await assert.rejects(prepareComposerDraft({ ...task, assets: [{ ...asset, path: '../escape' }] }));
    const many = await prepareComposerDraft({ ...task, assets: Array(21).fill(asset) });
    assert.equal(many.images.length, 20);
    assert.match(many.warnings[0], /限制/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
