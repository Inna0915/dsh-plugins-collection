import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionActivity, buildWorkspaceActivityIndex, buildWorkspaceActivity } from '../src/core/activity.js';

test('live running status overrides stale catalog; completion and waiting do not keep a spinner', () => {
  const list = { ids: ['one', 'two', 'archived'], byId: {
    one: { running: true }, two: { running: false }, archived: { running: true },
  } };
  const activity = buildSessionActivity(list, new Map([
    ['one', { running: false, completionUnread: true }],
    ['two', { running: true }],
  ]), ['archived']);
  assert.equal(activity.has('one'), false);
  assert.equal(activity.has('archived'), false);
  assert.equal(activity.get('two').state, 'ongoing');
  for (const kind of ['approval', 'plan-review', 'question']) {
    const waiting = buildSessionActivity(list, new Map([['two', { running: true, pendingInteraction: { kind } }]]));
    assert.equal(waiting.get('two').state, 'warning');
  }
  assert.equal(buildSessionActivity(list, new Map()).get('one').state, 'ongoing', 'catalog is a fallback when no live status exists');
});

test('running subagents mark their parent, then clear on an explicit child stop', () => {
  const list = {
    ids: ['parent', 'child'],
    byId: { parent: { running: false }, child: { origin: 'subagent', running: true } },
    projectionsBySession: { parent: { values: { subagentCatalog: [{ id: 'child' }] } } },
  };
  const running = buildSessionActivity(list, new Map());
  assert.deepEqual([...running.keys()], ['parent']);
  assert.match(running.get('parent').label, /1 个子任务/);
  assert.equal(buildSessionActivity(list, new Map([['child', { running: false }]])).size, 0);
});

test('workspace activity reaches all registered ancestors, deduplicates shared sessions and clears independently', () => {
  const index = buildWorkspaceActivityIndex({ items: [
    { workspaceId: 'root', path: 'C:\\projects\\', sessionIds: ['shared'] },
    { workspaceId: 'parent', path: 'C:/projects/app', sessionIds: ['shared'] },
    { workspaceId: 'child', path: 'C:/projects/app/child', sessionIds: ['one', 'shared'] },
    { workspaceId: 'similar', path: 'C:/projects/application', sessionIds: ['two'] },
    { workspaceId: 'other-case', path: 'c:/projects/app', sessionIds: [] },
  ] });
  const active = new Map([
    ['one', { state: 'ongoing' }], ['shared', { state: 'ongoing' }],
    ['two', { state: 'warning' }], ['loose', { state: 'ongoing' }],
  ]);
  const folders = buildWorkspaceActivity(active, index);
  assert.deepEqual(folders.get('root'), { state: 'ongoing', label: '2 个会话执行中，1 个会话等待处理' });
  assert.equal(folders.get('parent').label, '2 个会话执行中');
  assert.equal(folders.get('child').label, '2 个会话执行中');
  assert.equal(folders.get('similar').state, 'warning');
  assert.equal(folders.has('other-case'), false);
  assert.equal(folders.get('').label, '1 个会话执行中');
  active.delete('one');
  assert.equal(buildWorkspaceActivity(active, index).get('parent').label, '1 个会话执行中');
  active.delete('shared');
  assert.equal(buildWorkspaceActivity(active, index).has('parent'), false);
  assert.equal(buildWorkspaceActivity(active, index).get('root').state, 'warning');
  assert.equal(buildWorkspaceActivity(new Map(), index).size, 0);
});
