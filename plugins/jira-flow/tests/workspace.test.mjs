import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkspaceBoard, BOARD_TAB_KIND } from '../dist/test-exports.js';

function fixture({ session = 'current', tabs = [], expanded = true } = {}) {
  const calls = [];
  let mounted;
  const host = {
    layout: {
      selectPanel: (id) => {
        calls.push(['selectPanel', id]);
      },
    },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: session }) } } },
    sidebarRight: {
      mounted: { getSnapshot: () => mounted },
      openTabs: { getSnapshot: () => tabs },
      isExpanded: () => expanded,
      toggleExpanded: () => calls.push(['expand']),
      focus: (id) => calls.push(['focus', id]),
      openTab: (...args) => {
        assert.equal(mounted, session);
        calls.push(['openTab', ...args]);
      },
    },
  };
  return {
    host,
    calls,
    commit: (action) => {
      action();
      mounted = session;
    },
  };
}

test('workspace navigation commits the session before opening a native split tab', () => {
  const state = fixture();
  openWorkspaceBoard(state.host, state.commit);
  assert.deepEqual(state.calls, [
    ['selectPanel', null],
    ['openTab', BOARD_TAB_KIND, { preferNewPane: true }],
  ]);
});

test('reopening reveals the current session board instead of duplicating or selecting another session', () => {
  const state = fixture({
    expanded: false,
    tabs: [
      { sessionId: 'other', tabId: 'foreign', kind: BOARD_TAB_KIND },
      { sessionId: 'current', tabId: 'restored', kind: BOARD_TAB_KIND },
    ],
  });
  openWorkspaceBoard(state.host, state.commit);
  assert.deepEqual(state.calls, [['selectPanel', null], ['expand'], ['focus', 'restored']]);
});

test('a sessionless workspace does not navigate or create a hidden board', () => {
  const state = fixture({ session: undefined });
  // Explicitly model the host's empty selection (the fixture default is a session).
  state.host.uiSession.adapter.current.getSnapshot = () => ({});
  assert.throws(() => openWorkspaceBoard(state.host, state.commit), /先在工作区打开一个会话/);
  assert.deepEqual(state.calls, []);
});
