import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPinned, togglePinnedId, createWorkspacePinStore, toggleSessionPin } from '../src/core/pins.js';

test('multiple pins lead newest-first, preserve ordinary order and stay within the five-item page', () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ id: `w${index}` }));
  let ids = togglePinnedId([], 'w8');
  ids = togglePinnedId(ids, 'w6');
  const ordered = orderPinned(items, ids, (row) => row.id);
  assert.deepEqual(ordered.slice(0, 5).map((row) => row.id), ['w6', 'w8', 'w0', 'w1', 'w2']);
  assert.deepEqual(items.map((row) => row.id), Array.from({ length: 9 }, (_, index) => `w${index}`));
  ids = togglePinnedId(ids, 'w6');
  assert.deepEqual(orderPinned(items, ids, (row) => row.id).slice(0, 3).map((row) => row.id), ['w8', 'w0', 'w1']);
  assert.deepEqual(orderPinned(items, ['deleted'], (row) => row.id), items);
  assert.deepEqual(togglePinnedId(togglePinnedId([], ''), ''), [], 'ungrouped can also be pinned and unpinned');
});

test('workspace pin store restores host-persisted identities on recreation', () => {
  const saved = new Map();
  const factory = (initial, options) => {
    let snapshot = saved.get(options.persist.name) ?? initial;
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set(next) { snapshot = next; saved.set(options.persist.name, structuredClone(next)); },
    };
  };
  const pins = createWorkspacePinStore(factory);
  pins.toggle('one'); pins.toggle('two'); pins.toggle('three'); pins.toggle('two');
  const restored = createWorkspacePinStore(factory);
  assert.deepEqual(restored.getSnapshot().ids, ['three', 'one']);
  restored.toggle('one');
  assert.deepEqual(createWorkspacePinStore(factory).getSnapshot().ids, ['three']);
});

test('session pin command reads native state, keeps method binding and propagates failures', async () => {
  let ids = [];
  const service = {
    async pinSession(id) { assert.equal(this, service); ids = [id, ...ids]; },
    async unpinSession(id) { assert.equal(this, service); ids = ids.filter((value) => value !== id); },
  };
  const ctx = { get: (name) => name === 'uiWorkspace' ? service : { list: { getSnapshot: () => ({ pinnedSessionIds: ids }) } } };
  await toggleSessionPin(ctx, 'one'); await toggleSessionPin(ctx, 'two');
  assert.deepEqual(ids, ['two', 'one']);
  await toggleSessionPin(ctx, 'one');
  assert.deepEqual(ids, ['two']);
  service.pinSession = async () => { throw new Error('test failure'); };
  await assert.rejects(toggleSessionPin(ctx, 'three'), /test failure/);
  assert.deepEqual(ids, ['two']);
});
