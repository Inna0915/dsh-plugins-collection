import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { parseHTML } from 'linkedom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Exercise the actual plugin/React portal in memory. No fixture files, server,
// polling, user profile, or real session contents are involved.
const bundle = buildSync({
  entryPoints: ['src/client/index.js'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'],
  loader: { '.js': 'jsx' }, logLevel: 'silent',
});
const module = { exports: {} };
const persisted = new Map();
const createdPinStores = [];
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)((name) => {
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
    StateDot: ({ state }) => React.createElement('span', { 'data-host-state': state }),
  };
  if (name === '@deepseek-ai/dsh-client-store') return {
    createSnapshotStore(initial, options) {
      const key = options.persist.name;
      const source = store(persisted.get(key) ?? initial);
      const set = source.set;
      source.set = (next) => { persisted.set(key, structuredClone(next)); set(next); };
      createdPinStores.push(source);
      return source;
    },
  };
  return require(name);
}, module, module.exports);

function store(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

test('real React portal: both section toggles, independent five-item pagers, updates, navigation and cleanup', async () => {
  const { document, window } = parseHTML('<html><head></head><body></body></html>');
  const globals = {
    document, window, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement, MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const frames = new Map();
  let frameId = 0;
  globals.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  globals.cancelAnimationFrame = (id) => frames.delete(id);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const flush = async () => {
    for (let pass = 0; pass < 8; pass += 1) {
      await act(async () => {
        const queued = [...frames.values()]; frames.clear();
        for (const callback of queued) callback();
      });
      if (frames.size === 0) return;
    }
    assert.fail('workspace observer did not settle within eight frames');
  };
  const click = async (element) => {
    assert.ok(element, 'click target exists');
    await act(async () => element.click());
    await flush();
  };
  let root;
  const cleanups = [];
  try {
    const groups = Array.from({ length: 8 }, (_, index) => `<div class="group"><div class="hoverAnchor"><div role="treeitem" data-row-key="workspace:${index === 7 ? '' : 'w' + index}">Project ${index}</div></div></div>`).join('');
    document.body.innerHTML = `<div class="regionArea"><div data-slot="sidebar.workspaces"><div class="root"><div class="header"><span>工作区</span><div><input type="text"></div><div class="actions"></div></div><div class="listArea"><div class="treeBody"><div role="tree">${groups}</div></div></div></div></div></div><div id="react-root"></div>`;
    const initial = { ids: [], byId: {} };
    for (let index = 0; index < 12; index += 1) {
      const id = `session-${index}`;
      initial.ids.push(id);
      initial.byId[id] = { id, title: `Test session ${index}`, updatedAt: index + 1, retainedBy: {} };
    }
    const sessions = store(initial);
    const workspaces = store({ items: [
      { workspaceId: 'w0', path: 'C:/root', sessionIds: [] },
      { workspaceId: 'child', path: 'C:/root/child', sessionIds: ['session-11'] },
      { workspaceId: 'w6', path: 'C:/other', sessionIds: ['session-10'] },
    ], archivedSessionIds: [], pinnedSessionIds: [] });
    const statuses = store(new Map());
    const opened = [];
    let failPin = false;
    let component;
    const ctx = {
      get(name) {
        if (name === 'sessions') return { list: sessions };
        if (name === 'workspaces') return { list: workspaces };
        if (name === 'uiWorkspace') return {
          openSession: (id) => opened.push(id),
          async pinSession(id) {
            if (failPin) throw new Error('test pin failure');
            const current = workspaces.getSnapshot();
            workspaces.set({ ...current, pinnedSessionIds: [id, ...current.pinnedSessionIds.filter((item) => item !== id)] });
          },
          async unpinSession(id) {
            const current = workspaces.getSnapshot();
            workspaces.set({ ...current, pinnedSessionIds: current.pinnedSessionIds.filter((item) => item !== id) });
          },
        };
        if (name === 'uiSession') return { sessionStatus: statuses };
      },
      effect(factory) { cleanups.push(factory()); },
      slots: {
        inject(_name, factory) { factory(); },
        register(_options, render) { component = render; return () => {}; },
      },
    };
    module.exports.apply(ctx);
    root = createRoot(document.getElementById('react-root'));
    await act(async () => root.render(React.createElement(component, { wide: true })));
    await flush();
    const recentRows = () => [...document.querySelectorAll('[data-dsr-session-id]')];
    const visibleGroups = () => document.querySelectorAll('[role="tree"] > .group:not([data-dsr-hidden])').length;
    const recentToggle = () => document.querySelector('.dsr-section-toggle');
    const workspaceToggle = () => document.querySelector('[data-dsr-section-toggle]');
    assert.equal(recentRows().length, 5);
    assert.equal(visibleGroups(), 5, 'HoverCard-wrapped folders are limited to five');
    assert.match(document.querySelector('.dsr-workspace-pager').textContent, /剩余 3 个/);
    const firstRow = recentRows()[0];
    const firstId = firstRow.getAttribute('data-dsr-session-id');
    await act(async () => statuses.set(new Map([['session-11', { running: true }], ['session-10', { running: true }]])));
    await flush();
    assert.equal(recentRows()[0].getAttribute('data-dsr-session-id'), firstId, 'status changes do not reorder recents');
    assert.ok(firstRow.querySelector('[data-host-state="ongoing"]'));
    assert.ok(document.querySelector('[data-dsr-workspace-activity="w0"] [data-host-state="ongoing"]'), 'closed ancestor folder shows running activity from its unmounted child');
    assert.ok(document.querySelector('[data-dsr-workspace-activity="w6"]'), 'pagination does not lose activity on hidden folders');
    const ancestorHost = document.querySelector('[data-dsr-workspace-activity="w0"]');
    await act(async () => statuses.set(new Map([['session-11', { running: true, completionUnread: true }], ['session-10', { running: true }]])));
    await flush();
    assert.equal(document.querySelector('[data-dsr-workspace-activity="w0"]'), ancestorHost, 'unchanged running state preserves the indicator node');
    await act(async () => statuses.set(new Map([['session-11', { running: false }], ['session-10', { running: true }]])));
    await flush();
    assert.equal(firstRow.querySelector('.dsr-activity'), null);
    assert.equal(document.querySelector('[data-dsr-workspace-activity="w0"]'), null);
    assert.ok(document.querySelector('[data-dsr-workspace-activity="w6"]'), 'another running folder is unaffected');
    await act(async () => statuses.set(new Map([['session-10', { running: true, pendingInteraction: { kind: 'approval' } }]])));
    await flush();
    assert.ok(document.querySelector('[data-dsr-workspace-activity="w6"] [data-host-state="warning"]'), 'approval waits use the native waiting marker, not an endless spinner');
    await act(async () => statuses.set(new Map()));
    await flush();
    assert.equal(document.querySelector('.dsr-activity'), null);
    assert.equal(document.querySelector('[data-dsr-workspace-activity]'), null);
    // Pin controls do not open a conversation or toggle its native folder.
    const folderPin = (id) => document.querySelector(`[data-dsr-workspace-pin="${id}"] button`);
    const recentPin = (id) => document.querySelector(`[data-dsr-session-id="${id}"]`)?.parentElement.querySelector('.dsr-pin-button');
    const groupFor = (id) => document.querySelector(`[data-row-key="workspace:${id}"]`).closest('.group');
    const nativeOrder = [...document.querySelectorAll('[role="tree"] > .group')];
    let nativeFolderClicks = 0;
    document.querySelector('[data-row-key="workspace:w6"]').addEventListener('click', () => nativeFolderClicks += 1);
    await click(document.querySelector('.dsr-workspace-pager button'));
    await click(folderPin('w6'));
    await click(folderPin('w2'));
    assert.equal(nativeFolderClicks, 0);
    assert.equal(folderPin('w6').getAttribute('aria-pressed'), 'true');
    assert.equal(groupFor('w2').style.getPropertyValue('--dsr-pin-order'), '0');
    assert.equal(groupFor('w6').style.getPropertyValue('--dsr-pin-order'), '1');
    assert.deepEqual([...document.querySelectorAll('[role="tree"] > .group')], nativeOrder, 'pinning leaves React-owned node order intact');
    await click(document.querySelector('.dsr-workspace-pager button'));
    assert.equal(visibleGroups(), 5);
    assert.equal(groupFor('w6').hasAttribute('data-dsr-hidden'), false);
    assert.equal(groupFor('w4').hasAttribute('data-dsr-hidden'), true);
    await click(folderPin('w6'));
    await click(folderPin('w2'));
    assert.equal(document.querySelector('[data-dsr-pin-container]'), null);
    assert.equal(groupFor('w6').hasAttribute('data-dsr-hidden'), true);

    await click(document.querySelector('.dsr-recents-action'));
    await click(recentPin('session-3'));
    await click(recentPin('session-9'));
    assert.deepEqual(recentRows().slice(0, 3).map((row) => row.dataset.dsrSessionId), ['session-9', 'session-3', 'session-11']);
    assert.deepEqual(opened, []);
    await click(document.querySelector('.dsr-recents-action[aria-expanded="true"]'));
    assert.equal(recentRows().length, 5);
    assert.ok(recentPin('session-3'));
    await click(recentPin('session-9'));
    await click(recentPin('session-3'));
    assert.equal(recentRows()[0].dataset.dsrSessionId, 'session-11');
    failPin = true;
    await click(recentPin('session-11'));
    assert.equal(recentPin('session-11').getAttribute('aria-pressed'), 'false');
    assert.match(document.querySelector('[role="alert"]').textContent, /失败/);
    failPin = false;
    await click(recentPin('session-11'));
    assert.equal(document.querySelector('[role="alert"]'), null);
    await click(recentPin('session-11'));
    await click(document.querySelector('.dsr-recents-action'));
    assert.equal(recentRows().length, 10);
    assert.equal(visibleGroups(), 5);
    await click(document.querySelector('.dsr-workspace-pager button'));
    assert.equal(visibleGroups(), 8);
    await click(workspaceToggle());
    assert.equal(workspaceToggle().getAttribute('aria-expanded'), 'false');
    assert.ok(document.querySelector('.listArea[data-dsr-section-collapsed]'));
    assert.equal(document.querySelector('.dsr-workspace-pager'), null);
    assert.equal(recentRows().length, 10);
    await click(recentToggle());
    assert.equal(recentToggle().getAttribute('aria-expanded'), 'false');
    assert.equal(recentRows().length, 0);
    assert.equal(document.querySelector('.dsr-recents-actions'), null);
    await click(workspaceToggle());
    assert.equal(visibleGroups(), 8, 'section reopens with previous paging');
    await click(recentToggle());
    assert.equal(recentRows().length, 10);
    await click(recentRows()[0]);
    assert.deepEqual(opened, ['session-11']);
    await click(document.querySelector('.dsr-workspace-pager button'));
    assert.equal(visibleGroups(), 5);
    await click(document.querySelector('.dsr-recents-action[aria-expanded="true"]'));
    assert.equal(recentRows().length, 5);
    for (const total of [6, 5, 1, 0, 12]) {
      const ids = initial.ids.slice(0, total);
      await act(async () => sessions.set({ ids, byId: initial.byId }));
      await flush();
      assert.equal(recentRows().length, Math.min(total, 5));
      assert.equal(document.querySelectorAll('.dsr-recents-action').length, total > 5 ? 1 : 0);
    }
    // Folder removal updates the pager; no stale count or blank hidden rows.
    for (const group of [...document.querySelectorAll('[role="tree"] > .group')].slice(5)) group.remove();
    await flush();
    assert.equal(document.querySelector('.dsr-workspace-pager'), null);
    assert.equal(visibleGroups(), 5);
    const css = document.querySelector('style[data-dsh-sidebar-recents]').textContent;
    assert.match(css, /\.dsr-recents-action\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary/);
    await act(async () => statuses.set(new Map([['session-11', { running: true }]])));
    await flush();
    assert.ok(document.querySelector('[data-dsr-workspace-activity="w0"]'));
    await click(folderPin('w0'));
    await click(recentPin('session-9'));
    await act(async () => root.unmount()); root = null;
    for (const cleanup of cleanups.reverse()) cleanup(); cleanups.length = 0;
    await flush();
    assert.equal(sessions.listenerCount, 0);
    assert.equal(workspaces.listenerCount, 0);
    assert.equal(statuses.listenerCount, 0);
    assert.equal(document.querySelector('[data-dsr-workspace-activity]'), null);
    assert.equal(document.querySelector('[data-dsr-workspace-pin]'), null);
    assert.equal(document.querySelector('[data-dsr-pin-container]'), null);
    assert.equal(createdPinStores[0].listenerCount, 0);
    assert.equal(document.querySelector('[data-dsr-lower]'), null);
    assert.equal(document.querySelector('[data-dsr-section-toggle]'), null);
    assert.equal(document.querySelector('[data-dsr-workspace-body]'), null);
    assert.equal(document.querySelector('style[data-dsh-sidebar-recents]'), null);

    // Recreate the entire plugin instance: persisted folder pins and native
    // session pins both return without retaining old subscriptions or hosts.
    module.exports.apply(ctx);
    root = createRoot(document.getElementById('react-root'));
    await act(async () => root.render(React.createElement(component, { wide: true })));
    await flush();
    assert.equal(folderPin('w0').getAttribute('aria-pressed'), 'true');
    assert.equal(recentRows()[0].dataset.dsrSessionId, 'session-9');
    assert.equal(recentPin('session-9').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelectorAll('[data-dsr-workspace-pin="w0"]').length, 1);
    await act(async () => root.unmount()); root = null;
    for (const cleanup of cleanups.reverse()) cleanup(); cleanups.length = 0;
    await flush();
    assert.ok(createdPinStores.every((source) => source.listenerCount === 0));
    assert.equal(document.querySelector('[data-dsr-workspace-pin]'), null);
    assert.equal(document.querySelector('[data-dsr-pin-container]'), null);
  } finally {
    if (root) await act(async () => root.unmount());
    for (const cleanup of cleanups.reverse()) cleanup();
    frames.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
