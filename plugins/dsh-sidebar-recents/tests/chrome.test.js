import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspaceChrome } from '../src/client/chrome.js';
import { openRecentSession } from '../src/client/navigation.js';
import { injectStyles } from '../src/client/styles.js';

async function loadLinkedom() {
  try {
    return await import('linkedom');
  } catch (error) {
    const custom = process.env.LINKEDOM_PATH;
    if (custom === undefined || custom === '') return null;
    return import(pathToFileURL(path.resolve(custom)).href);
  }
}

const linkedom = await loadLinkedom();
if (linkedom === null) {
  throw new Error(
    'linkedom is required for the DOM integration tests; install devDependencies or set LINKEDOM_PATH',
  );
}

test(
  'chrome adapter applies five-group limit, search bypass, collapse-all, and dispose',
  async () => {
    const {
      parseHTML,
      HTMLElement,
      HTMLInputElement,
      HTMLButtonElement,
    } = linkedom;
    const { document, window } = parseHTML('<html><body></body></html>');
    const Event = window.Event;

    const previous = {
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      HTMLInputElement: globalThis.HTMLInputElement,
      HTMLButtonElement: globalThis.HTMLButtonElement,
      MutationObserver: globalThis.MutationObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    let frames = [];
    let observerCallback;
    globalThis.document = document;
    globalThis.HTMLElement = HTMLElement;
    globalThis.HTMLInputElement = HTMLInputElement;
    globalThis.HTMLButtonElement = HTMLButtonElement;
    globalThis.MutationObserver = class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
    globalThis.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    const flushFrames = () => {
      const queued = frames;
      frames = [];
      for (const callback of queued) callback();
    };

    try {
      const groups = Array.from(
        { length: 12 },
        (_, index) =>
          `<div class="group"><div class="hoverAnchor"><div data-row-key="workspace:w${index + 1}" role="treeitem" aria-expanded="true">w${index + 1}</div></div>${index === 0 ? '<div role="group"><div class="nested"><div class="hoverAnchor"><div data-row-key="workspace:child" role="treeitem">Nested folder</div></div></div></div>' : ''}</div>`,
      ).join('');
      document.body.innerHTML = `
        <div class="regionArea">
          <div data-slot="sidebar.workspaces">
            <div class="root">
              <div class="header">
                <span>工作区</span>
                <div class="search"><input type="text" /></div>
                <div class="actions"></div>
              </div>
              <div class="listArea"><div class="treeBody"><div class="list" role="tree">${groups}</div><span class="native_fade"></span></div></div>
            </div>
          </div>
        </div>`;

      const expandedCalls = [];
      const workspaceItems = Array.from({ length: 12 }, (_, index) => ({
        workspaceId: `w${index + 1}`,
      }));
      const ctx = {
        get(name) {
          if (name === 'uiWorkspace') {
            return {
              view: {
                setGroupExpanded(key, expanded) {
                  expandedCalls.push([key, expanded]);
                },
              },
            };
          }
          if (name === 'workspaces') {
            return {
              list: {
                getSnapshot() {
                  return { items: workspaceItems, archivedSessionIds: [] };
                },
              },
            };
          }
          return undefined;
        },
      };

      const chrome = createWorkspaceChrome(ctx);
      const disposeStyles = injectStyles();
      const styleText =
        document.querySelector('style[data-dsh-sidebar-recents]')?.textContent ?? '';
      assert.match(
        styleText,
        /\[data-dsr-hidden\][^{]*\{[^}]*display:\s*none/,
        'the hidden attribute must have a real display:none rule',
      );
      chrome.attach();
      flushFrames();

      const slot = document.querySelector('[data-slot="sidebar.workspaces"]');
      const groupElements = Array.from(slot.querySelectorAll('[role="tree"] > .group'));
      assert.equal(chrome.getSnapshot().total, 12);
      assert.equal(chrome.getSnapshot().limit, 5);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 7);
      assert.equal(
        groupElements.filter((group) => !group.hasAttribute('data-dsr-hidden')).length,
        5,
        'exactly five groups remain visible',
      );
      const portalHost = chrome.getPortalHost();
      assert.ok(portalHost, 'portal host is created');
      assert.equal(portalHost.parentElement, slot);
      assert.equal(portalHost.previousElementSibling, slot.firstElementChild);
      assert.ok(portalHost.classList.contains('dsr-lower'));
      assert.equal(chrome.getSnapshot().portalHost, portalHost);
      assert.ok(document.querySelector('.regionArea').hasAttribute('data-dsr-region'));
      assert.ok(slot.querySelector('.root').hasAttribute('data-dsr-workspace-root'));
      assert.ok(slot.querySelector('.listArea').hasAttribute('data-dsr-workspace-body'));
      assert.ok(slot.querySelector('.list').hasAttribute('data-dsr-workspace-tree'));
      const headerButton = slot.querySelector('[data-dsr-collapse-all]');
      assert.ok(headerButton, 'collapse-all button is injected in the workspace header');
      assert.equal(headerButton.getAttribute('aria-label'), '收起所有文件夹');
      assert.equal(slot.querySelector('.nested').hasAttribute('data-dsr-hidden'), false);
      chrome.setWorkspacePins(['w10', 'w8', 'child']);
      flushFrames();
      assert.equal(groupElements[9].hasAttribute('data-dsr-hidden'), false);
      assert.equal(groupElements[9].style.getPropertyValue('--dsr-pin-order'), '0');
      assert.equal(groupElements[7].style.getPropertyValue('--dsr-pin-order'), '1');
      assert.equal(groupElements[3].hasAttribute('data-dsr-hidden'), true);
      assert.equal(slot.querySelector('.nested').parentElement.getAttribute('role'), 'group', 'nested pin stays with its original parent');
      assert.equal(slot.querySelector('.nested').style.getPropertyValue('--dsr-pin-order'), '0');
      chrome.setWorkspacePins([]);
      flushFrames();
      assert.equal(slot.querySelector('[data-dsr-pin-container]'), null);
      assert.ok(!groupElements[9].style.getPropertyValue('--dsr-pin-order'));

      // A section toggle hides the whole body, preserves native expansion and
      // list limits, and supports keyboard without toggling folder contents.
      const sectionLabel = slot.querySelector('[data-dsr-section-toggle]');
      assert.equal(sectionLabel.getAttribute('aria-expanded'), 'true');
      sectionLabel.click();
      flushFrames();
      assert.equal(chrome.getSnapshot().collapsed, true);
      assert.ok(slot.querySelector('.listArea').hasAttribute('data-dsr-section-collapsed'));
      assert.equal(expandedCalls.length, 0);
      const space = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(space, 'key', { value: ' ' });
      sectionLabel.dispatchEvent(space);
      flushFrames();
      assert.equal(chrome.getSnapshot().collapsed, false);
      assert.equal(slot.querySelector('[data-dsr-section-collapsed]'), null);

      observerCallback([{ type: 'childList', target: portalHost }]);
      observerCallback([{ type: 'childList', target: slot.querySelector('[data-row-key]') }]);
      assert.equal(frames.length, 0, 'recent and native row content changes must not scan the tree');
      for (let index = 0; index < 20; index += 1) observerCallback([{ type: 'childList', target: slot.querySelector('[role="tree"]') }]);
      assert.equal(frames.length, 1, 'structural changes batch once per animation frame');
      flushFrames();

      chrome.setLimit(10);
      flushFrames();
      assert.equal(chrome.getSnapshot().limit, 10);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 2);

      chrome.collapseList();
      flushFrames();
      assert.equal(chrome.getSnapshot().limit, 5);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 7);

      const searchInput = slot.querySelector('input[type="text"]');
      chrome.setSectionCollapsed(true);
      flushFrames();
      searchInput.dispatchEvent(new Event('focus'));
      flushFrames();
      assert.equal(chrome.getSnapshot().collapsed, false, 'starting a native search reveals the section');
      searchInput.value = '项目';
      searchInput.dispatchEvent(new Event('input'));
      flushFrames();
      assert.equal(chrome.getSnapshot().searchActive, true);
      assert.equal(chrome.getSnapshot().total, 0);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 0);

      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      flushFrames();
      assert.equal(chrome.getSnapshot().searchActive, false);
      assert.equal(chrome.getSnapshot().total, 12);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 7);

      assert.equal(chrome.collapseAll(), true);
      assert.deepEqual(
        new Set(expandedCalls.map(([key]) => key)),
        new Set(['', ...workspaceItems.map((item) => item.workspaceId)]),
      );
      assert.ok(expandedCalls.every(([, expanded]) => expanded === false));

      chrome.setSectionCollapsed(true);
      flushFrames();
      chrome.detach();
      assert.equal(sectionLabel.hasAttribute('role'), false);
      assert.equal(sectionLabel.hasAttribute('aria-expanded'), false);
      assert.equal(slot.querySelector('[data-dsr-section-collapsed]'), null);
      assert.equal(slot.querySelector('[data-dsr-collapse-all]'), null);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 0);
      assert.equal(chrome.getPortalHost(), null);
      assert.equal(document.querySelector('.dsr-lower'), null);
      assert.equal(document.querySelector('[data-dsr-region]'), null);
      assert.equal(document.querySelector('[data-dsr-workspace-root]'), null);
      assert.equal(document.querySelector('[data-dsr-workspace-tree]'), null);

      chrome.attach();
      flushFrames();
      assert.equal(slot.querySelectorAll('[data-dsr-collapse-all]').length, 1);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 7);
      assert.ok(chrome.getPortalHost(), 'portal host returns after reattach');

      chrome.dispose();
      assert.equal(slot.querySelector('[data-dsr-collapse-all]'), null);
      assert.equal(groupElements.filter((group) => group.hasAttribute('data-dsr-hidden')).length, 0);
      chrome.attach();
      flushFrames();
      assert.equal(slot.querySelector('[data-dsr-collapse-all]'), null);

      disposeStyles();
      assert.equal(document.querySelector('style[data-dsh-sidebar-recents]'), null);
    } finally {
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.HTMLInputElement = previous.HTMLInputElement;
      globalThis.HTMLButtonElement = previous.HTMLButtonElement;
      globalThis.MutationObserver = previous.MutationObserver;
      globalThis.requestAnimationFrame = previous.requestAnimationFrame;
      globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    }
  },
);

test('openRecentSession calls the host navigation service with the original id only', () => {
  const opened = [];
  const ctx = {
    get(name) {
      if (name !== 'uiWorkspace') return undefined;
      return {
        openSession(sessionId) {
          opened.push(sessionId);
        },
      };
    },
  };
  assert.equal(openRecentSession(ctx, 'session-123'), true);
  assert.deepEqual(opened, ['session-123']);
  assert.equal(openRecentSession(ctx, ''), false);
  assert.equal(openRecentSession({ get: () => undefined }, 'session-123'), false);
  assert.deepEqual(opened, ['session-123']);
});
