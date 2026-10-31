import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_PAGE_SIZE,
  buildRecents,
  canCollapseRecents,
  effectiveVisibleCount,
  hasMoreRecents,
  nextVisibleCount,
  visibleRecents,
  workspaceLabelOf,
} from '../src/core/recents.js';
import { workspaceGroupKeys } from '../src/core/workspaces.js';

function summary(sessionId, updatedAt, extra = {}) {
  return {
    sessionId,
    updatedAt,
    blank: false,
    displayTitle: sessionId,
    cwd: `C:\\work\\${sessionId}`,
    ...extra,
  };
}

function sessions(rows) {
  return {
    ids: rows.map((row) => row.sessionId),
    byId: Object.fromEntries(rows.map((row) => [row.sessionId, row])),
  };
}

function workspaces(items = [], archivedSessionIds = [], pinnedSessionIds = []) {
  return { items, archivedSessionIds, pinnedSessionIds };
}

function ws(id, path, sessionIds, title = id) {
  return { workspaceId: id, path, sessionIds, title };
}

test('0/1/5/6/12 row boundaries', () => {
  for (const total of [0, 1, 5, 6, 12]) {
    const rows = Array.from({ length: total }, (_, index) =>
      summary(`s${index + 1}`, 1_000 - index),
    );
    const items = buildRecents(sessions(rows), workspaces());
    assert.equal(items.length, total);
    assert.equal(new Set(items.map((row) => row.sessionId)).size, total);
    const firstPage = visibleRecents(items, 5);
    assert.equal(firstPage.length, Math.min(total, 5));
    assert.equal(hasMoreRecents(5, total), total > 5);
    assert.equal(canCollapseRecents(5), false);
    if (total === 6) {
      assert.equal(hasMoreRecents(5, total), true);
      assert.equal(nextVisibleCount(5, total), 6);
    }
    if (total === 12) {
      assert.equal(nextVisibleCount(5, total), 10);
      assert.equal(nextVisibleCount(10, total), 12);
      assert.equal(canCollapseRecents(10), true);
    }
  }
});

test('stable descending order by host updatedAt, not catalog order', () => {
  const items = buildRecents(
    sessions([
      summary('old', 10),
      summary('new', 30),
      summary('tie-a', 20),
      summary('tie-b', 20),
    ]),
    workspaces(),
  );
  assert.deepEqual(
    items.map((row) => row.sessionId),
    ['new', 'tie-a', 'tie-b', 'old'],
  );
});

test('native pins lead recents; an unpinned summary flag does not override the native pin set', () => {
  const rows = [summary('a', 10, { pinned: true }), summary('b', 20)];
  const items = buildRecents(
    sessions(rows),
    workspaces([], [], ['a']),
  );
  assert.deepEqual(items.map((row) => row.sessionId), ['a', 'b']);
  assert.equal(items[0].pinned, true);
  assert.equal(items[1].pinned, false);
  assert.deepEqual(buildRecents(sessions(rows), workspaces()).map((row) => row.sessionId), ['b', 'a']);
});

test('multiple recent pins follow native pin order while archived and deleted pins stay hidden', () => {
  const rows = [summary('a', 40), summary('b', 10), summary('c', 30), summary('d', 20)];
  const items = buildRecents(sessions(rows), workspaces([], ['c'], ['deleted', 'b', 'c', 'd']));
  assert.deepEqual(items.map((row) => row.sessionId), ['b', 'd', 'a']);
  assert.deepEqual(items.map((row) => row.pinned), [true, true, false]);
});

test('current row is suppressed while a global panel is active', () => {
  const rows = [summary('a', 10, { retainedBy: { mainView: 1 } })];
  const inConversation = buildRecents(sessions(rows), workspaces(), {
    panelActive: false,
  });
  const inPanel = buildRecents(sessions(rows), workspaces(), { panelActive: true });
  assert.equal(inConversation[0].current, true);
  assert.equal(inPanel[0].current, false);
});

test('deduplicates session ids and excludes blank, archived, and subagent rows', () => {
  const rows = [
    summary('keep', 100),
    summary('blank', 200, { blank: true }),
    summary('archived', 300),
    summary('subagent', 400, { origin: 'subagent', parentSessionId: 'keep' }),
    summary('keep', 50, { displayTitle: 'duplicate' }),
  ];
  const items = buildRecents(sessions(rows), workspaces([], ['archived']));
  assert.deepEqual(items.map((row) => row.sessionId), ['keep']);
});

test('ordinary fork rows remain visible; only subagent origin is excluded', () => {
  const items = buildRecents(
    sessions([
      summary('parent', 10),
      summary('fork', 20, { parentSessionId: 'parent' }),
    ]),
    workspaces(),
  );
  assert.deepEqual(items.map((row) => row.sessionId), ['fork', 'parent']);
});

test('workspace label prefers membership, then cwd basename, then ungrouped', () => {
  const items = buildRecents(
    sessions([
      summary('member', 30, { cwd: 'C:\\work\\other' }),
      summary('from-cwd', 20, { cwd: 'C:\\projects\\alpha' }),
      summary('no-cwd', 10, { cwd: undefined }),
    ]),
    workspaces([ws('w1', 'C:\\work', ['member'], '工作区一')]),
  );
  const byId = Object.fromEntries(items.map((row) => [row.sessionId, row]));
  assert.equal(byId.member.workspaceLabel, '工作区一');
  assert.equal(byId['from-cwd'].workspaceLabel, 'alpha');
  assert.equal(byId['no-cwd'].workspaceLabel, '未分组');
});

test('duplicate titles carry a workspace hint; unique titles do not', () => {
  const items = buildRecents(
    sessions([
      summary('a', 30, { displayTitle: '同名' }),
      summary('b', 20, { displayTitle: '同名' }),
      summary('c', 10, { displayTitle: '唯一' }),
    ]),
    workspaces([
      ws('w1', 'C:\\one', ['a'], '一号'),
      ws('w2', 'C:\\two', ['b'], '二号'),
    ]),
  );
  assert.equal(items.find((row) => row.sessionId === 'a').showWorkspaceHint, true);
  assert.equal(items.find((row) => row.sessionId === 'b').showWorkspaceHint, true);
  assert.equal(items.find((row) => row.sessionId === 'c').showWorkspaceHint, false);
});

test('pagination clamps to current data and never drops below one page', () => {
  assert.equal(effectiveVisibleCount(5, 0), 0);
  assert.equal(effectiveVisibleCount(5, 1), 1);
  assert.equal(effectiveVisibleCount(5, 5), 5);
  assert.equal(effectiveVisibleCount(12, 6), 6);
  assert.equal(effectiveVisibleCount(10, 12), 10);
  assert.equal(effectiveVisibleCount(5, 12), 5);
  assert.equal(nextVisibleCount(5, 6), 6);
  assert.equal(nextVisibleCount(5, 12), 10);
  assert.equal(nextVisibleCount(10, 12), 12);
  assert.equal(RECENT_PAGE_SIZE, 5);
});

test('workspaceLabelOf accepts Windows and POSIX paths', () => {
  assert.equal(workspaceLabelOf('C:\\Users\\me\\project\\'), 'project');
  assert.equal(workspaceLabelOf('/home/me/project'), 'project');
  assert.equal(workspaceLabelOf('project'), 'project');
  assert.equal(workspaceLabelOf(''), undefined);
});

test('collapse keys include ungrouped and every workspace, including hidden descendants', () => {
  const keys = workspaceGroupKeys(
    workspaces([
      ws('root', 'C:\\work', []),
      ws('child', 'C:\\work\\child', []),
      ws('', '', []),
    ]),
  );
  assert.deepEqual(new Set(keys), new Set(['', 'root', 'child']));
});
