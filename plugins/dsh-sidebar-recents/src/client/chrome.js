import { workspaceGroupKeys } from '../core/workspaces.js';
import { orderPinned } from '../core/pins.js';

/**
 * Minimal, reversible sidebar chrome adapter.
 *
 * The official `sidebar.workspaces` slot is a single occupant owned by
 * ui-workspace, and the package exports only its plugin body. Desktop
 * 0.2.1-rc.3 has no public workspace-group watermark API: it exposes a
 * per-Workspace Session watermark (ui-workspace lib/client.js:2805) but renders
 * every top-level Workspace group. The official expansion store is reachable
 * through `uiWorkspace.view.setGroupExpanded()` (same file:1284, 5039), so
 * collapsing all folders uses that service. Only the five-group visibility
 * limit and the header control need the bounded DOM seam below.
 *
 * The seam is deliberately narrow: one MutationObserver rooted at
 * `[data-slot="sidebar.workspaces"]`, no React Fiber, no timers, no polling,
 * and every DOM change is tagged with `data-dsr-*` for removal on dispose.
 */

export const SLOT_SELECTOR = '[data-slot="sidebar.workspaces"]';
export const TREE_SELECTOR = '[role="tree"]';
export const GROUP_ROW_PREFIX = 'workspace:';
export const HIDDEN_ATTRIBUTE = 'data-dsr-hidden';
export const HEADER_BUTTON_ATTRIBUTE = 'data-dsr-collapse-all';
export const DEFAULT_WORKSPACE_LIMIT = 5;

const COLLAPSE_LABEL = '收起所有文件夹';
const COLLAPSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M9 13h6"/></svg>';

function sameChromeState(left, right) {
  return (
    left.total === right.total &&
    left.limit === right.limit &&
    left.searchActive === right.searchActive &&
    left.collapsed === right.collapsed &&
    left.available === right.available &&
    sameActivityTargets(left.activityTargets, right.activityTargets) &&
    samePinTargets(left.pinTargets, right.pinTargets) &&
    left.portalHost === right.portalHost
  );
}

function samePinTargets(left, right) {
  return left.length === right.length && left.every((item, index) =>
    item.host === right[index].host && item.name === right[index].name,
  );
}

function sameActivityTargets(left, right) {
  return left.length === right.length && left.every((item, index) =>
    item.host === right[index].host &&
    item.activity.state === right[index].activity.state &&
    item.activity.label === right[index].activity.label,
  );
}

/**
 * @param {any} ctx client root context
 */
export function createWorkspaceChrome(ctx) {
  let slot = null;
  let tree = null;
  let header = null;
  let nativeRoot = null;
  let headerButton = null;
  let sectionLabel = null;
  let labelAttributes = null;
  let collapsedBody = null;
  let searchInput = null;
  let searchListener = null;
  let portalHost = null;
  let observer = null;
  let observerTarget = null;
  let frame = 0;
  let attached = false;
  let disposed = false;

  const listeners = new Set();
  const layoutElements = new Map();
  const hiddenGroups = new Map();
  const activityHosts = new Map();
  const pinHosts = new Map();
  const pinContainers = new Set();
  const pinGroups = new Map();
  let workspacePinIds = [];
  let workspaceNames = new Map();
  let workspaceActivity = new Map();
  let state = {
    total: 0,
    limit: DEFAULT_WORKSPACE_LIMIT,
    searchActive: false,
    collapsed: false,
    available: false,
    portalHost: null,
    activityTargets: [],
    pinTargets: [],
  };

  function emit(patch) {
    const next = { ...state, ...patch };
    if (sameChromeState(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function getSnapshot() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function topLevelGroups() {
    if (tree === null) return [];
    return Array.from(tree.children).filter(
      (child) =>
        child instanceof HTMLElement &&
        // Real workspace rows are wrapped by HoverCard; ungrouped rows are not.
        // Inspect each top-level group once, stopping at its first matching row.
        // Nested workspaces therefore never count as additional top-level items.
        (child.matches(`[data-row-key^="${GROUP_ROW_PREFIX}"]`) ||
          child.querySelector(`[data-row-key^="${GROUP_ROW_PREFIX}"]`) !== null),
    );
  }

  function groupKey(group) {
    const row = group.matches(`[data-row-key^="${GROUP_ROW_PREFIX}"]`)
      ? group : group.querySelector(`[data-row-key^="${GROUP_ROW_PREFIX}"]`);
    return row?.dataset.rowKey.slice(GROUP_ROW_PREFIX.length);
  }

  function setWorkspacePins(ids, workspaces = []) {
    const names = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.title ?? workspace.workspaceId]));
    const unchanged = ids.length === workspacePinIds.length && ids.every((id, index) => id === workspacePinIds[index]) &&
      names.size === workspaceNames.size && [...names].every(([id, name]) => workspaceNames.get(id) === name);
    if (unchanged || disposed) return;
    workspacePinIds = [...ids];
    workspaceNames = names;
    scheduleApply();
  }

  function restorePinGroup(group, previous) {
    group.removeAttribute('data-dsr-pin-group');
    if (previous.value) group.style.setProperty('--dsr-pin-order', previous.value, previous.priority);
    else group.style.removeProperty('--dsr-pin-order');
  }

  function clearPinOrdering() {
    for (const container of pinContainers) container.removeAttribute('data-dsr-pin-container');
    pinContainers.clear();
    for (const [group, previous] of pinGroups) restorePinGroup(group, previous);
    pinGroups.clear();
  }

  function clearPinHosts() {
    for (const host of pinHosts.values()) host.remove();
    pinHosts.clear();
    clearPinOrdering();
  }

  function updatePinTargets(rows) {
    const targets = [];
    const currentRows = new Set(rows);
    for (const row of rows) {
      const key = row.dataset.rowKey.slice(GROUP_ROW_PREFIX.length);
      let host = pinHosts.get(row);
      if (!host || host.parentElement !== row) {
        host?.remove();
        host = document.createElement('span');
        host.className = 'dsr-workspace-pin';
        host.setAttribute('data-dsr-workspace-pin', key);
        const actions = Array.from(row.children).find((child) => child.className?.includes('_rowActions'));
        row.insertBefore(host, actions ?? null);
        pinHosts.set(row, host);
      }
      const name = workspaceNames.get(key) ?? row.querySelector('[class*="_projectText"]')?.textContent ?? (key || '未分组');
      targets.push({ key, host, name });
    }
    for (const [row, host] of pinHosts) {
      if (currentRows.has(row)) continue;
      host.remove();
      pinHosts.delete(row);
    }
    return targets;
  }

  // CSS ordering preserves React-owned nodes and native drag order. In tree
  // mode pins only reorder siblings: children never leave their parent folder.
  function updatePinOrdering(rows) {
    const levels = new Map();
    const pinned = new Set(workspacePinIds);
    for (const row of rows) {
      let group = row;
      while (group.parentElement && group.parentElement !== tree && group.parentElement.getAttribute('role') !== 'group') group = group.parentElement;
      const container = group.parentElement;
      if (!container || (container !== tree && container.getAttribute('role') !== 'group')) continue;
      if (!levels.has(container)) levels.set(container, []);
      levels.get(container).push(group);
    }
    const nextContainers = new Set();
    const nextGroups = new Map();
    for (const [container, groups] of levels) {
      if (!groups.some((group) => pinned.has(groupKey(group)))) continue;
      nextContainers.add(container);
      orderPinned(groups, workspacePinIds, groupKey).forEach((group, index) => nextGroups.set(group, String(index)));
    }
    for (const container of pinContainers) {
      if (!nextContainers.has(container)) container.removeAttribute('data-dsr-pin-container');
    }
    pinContainers.clear();
    for (const container of nextContainers) {
      container.setAttribute('data-dsr-pin-container', '');
      pinContainers.add(container);
    }
    for (const [group, previous] of pinGroups) {
      if (nextGroups.has(group)) continue;
      restorePinGroup(group, previous);
      pinGroups.delete(group);
    }
    for (const [group, order] of nextGroups) {
      if (!pinGroups.has(group)) pinGroups.set(group, {
        value: group.style.getPropertyValue('--dsr-pin-order'),
        priority: typeof group.style.getPropertyPriority === 'function'
          ? group.style.getPropertyPriority('--dsr-pin-order') : '',
      });
      group.setAttribute('data-dsr-pin-group', '');
      if (group.style.getPropertyValue('--dsr-pin-order') !== order) group.style.setProperty('--dsr-pin-order', order);
    }
  }

  function clearActivityHosts() {
    for (const host of activityHosts.values()) host.remove();
    activityHosts.clear();
  }

  function updateActivityTargets(rows) {
    if (tree === null || workspaceActivity.size === 0) {
      clearActivityHosts();
      return [];
    }
    const targets = [];
    const activeRows = new Set();
    for (const row of rows) {
      const key = row.dataset.rowKey.slice(GROUP_ROW_PREFIX.length);
      const activity = workspaceActivity.get(key);
      if (!activity) continue;
      activeRows.add(row);
      let host = activityHosts.get(row);
      if (!host || host.parentElement !== row) {
        host?.remove();
        host = document.createElement('span');
        host.className = 'dsr-workspace-activity';
        host.setAttribute('data-dsr-workspace-activity', key);
        const actions = Array.from(row.children).find((child) => child.className?.includes('_rowActions'));
        row.insertBefore(host, actions ?? null);
        activityHosts.set(row, host);
      }
      targets.push({ key, host, activity });
    }
    for (const [row, host] of activityHosts) {
      if (activeRows.has(row)) continue;
      host.remove();
      activityHosts.delete(row);
    }
    return targets;
  }

  function setWorkspaceActivity(next) {
    if (disposed) return;
    const unchanged = next.size === workspaceActivity.size && [...next].every(([key, value]) => {
      const current = workspaceActivity.get(key);
      return current?.state === value.state && current?.label === value.label;
    });
    if (unchanged) return;
    workspaceActivity = next;
    scheduleApply();
  }

  function readParts() {
    if (typeof document === 'undefined') return false;
    slot = document.querySelector(SLOT_SELECTOR);
    if (!(slot instanceof HTMLElement)) {
      slot = null;
      tree = null;
      header = null;
      nativeRoot = null;
      searchInput = null;
      return false;
    }
    tree = slot.querySelector(TREE_SELECTOR);
    if (!(tree instanceof HTMLElement)) tree = null;
    nativeRoot = Array.from(slot.children).find(
      (child) => child instanceof HTMLElement && !child.hasAttribute('data-dsr-lower'),
    );
    header = nativeRoot instanceof HTMLElement ? nativeRoot.firstElementChild : null;
    if (!(header instanceof HTMLElement)) header = null;
    // The wide header owns the search field; the rail composition has no such
    // header, so the seam is inert there.
    searchInput =
      header instanceof HTMLElement ? header.querySelector('input[type="text"]') : null;
    return true;
  }

  /**
   * The portal container is a sibling of the native browser root inside the
   * display:contents `sidebar.workspaces` anchor, so it lays out directly below
   * the browser in `.regionArea`. It never enters the bottom `footArea` and the
   * native header/list/dialog tree is never rewritten. Existing footer actions
   * (session board, task board, settings) keep their positions.
   */
  function ensurePortalHost() {
    if (slot === null || !(nativeRoot instanceof HTMLElement)) return null;
    if (
      portalHost !== null &&
      portalHost.isConnected &&
      portalHost.parentElement === slot &&
      portalHost.previousElementSibling === nativeRoot
    ) {
      return portalHost;
    }
    if (portalHost !== null) portalHost.remove();
    const host = document.createElement('div');
    host.className = 'dsr-lower';
    host.setAttribute('data-dsr-lower', '');
    slot.insertBefore(host, nativeRoot.nextSibling);
    portalHost = host;
    return host;
  }

  function restoreLayout() {
    collapsedBody?.removeAttribute('data-dsr-section-collapsed');
    collapsedBody = null;
    for (const [element, attribute] of layoutElements) {
      element.removeAttribute(attribute);
    }
    layoutElements.clear();
  }

  function updateLayout() {
    const elements = new Map();
    if (slot?.parentElement && nativeRoot instanceof HTMLElement) {
      elements.set(slot.parentElement, 'data-dsr-region');
      elements.set(nativeRoot, 'data-dsr-workspace-root');
      const body = Array.from(nativeRoot.children).find(
        (child) => child !== header && (tree ? child.contains(tree) : child === header?.nextElementSibling),
      );
      if (body) elements.set(body, 'data-dsr-workspace-body');
      if (tree !== null) {
        elements.set(tree, 'data-dsr-workspace-tree');
      }
      if (collapsedBody !== body) collapsedBody?.removeAttribute('data-dsr-section-collapsed');
      collapsedBody = body ?? null;
      collapsedBody?.toggleAttribute('data-dsr-section-collapsed', state.collapsed);
    }
    for (const [element, attribute] of layoutElements) {
      if (elements.get(element) !== attribute) element.removeAttribute(attribute);
    }
    layoutElements.clear();
    for (const [element, attribute] of elements) {
      element.setAttribute(attribute, '');
      layoutElements.set(element, attribute);
    }
  }

  function showGroup(group) {
    if (!hiddenGroups.has(group)) return;
    const previousAriaHidden = hiddenGroups.get(group);
    group.removeAttribute(HIDDEN_ATTRIBUTE);
    if (previousAriaHidden === null) group.removeAttribute('aria-hidden');
    else group.setAttribute('aria-hidden', previousAriaHidden);
    hiddenGroups.delete(group);
  }

  function showAllGroups() {
    for (const group of hiddenGroups.keys()) showGroup(group);
  }

  function getPortalHost() {
    return portalHost;
  }

  function releasePortalHost() {
    const host = portalHost;
    portalHost = null;
    if (host === null) return;
    if (host.childElementCount === 0) {
      host.remove();
      return;
    }
    // React removes portal children during its commit. Check once on the next
    // microtask and remove only the now-empty host; this is cleanup, not a poll.
    queueMicrotask(() => {
      if (host.childElementCount === 0) host.remove();
    });
  }

  function searchIsActive() {
    return searchInput instanceof HTMLInputElement && searchInput.value.trim() !== '';
  }

  // Keep React's native label node and its search transition intact. Only add
  // reversible button semantics; the chevron is CSS, not a React child mutation.
  function ensureSectionToggle() {
    const label = Array.from(header?.children ?? []).find((child) => child.tagName === 'SPAN');
    if (label !== sectionLabel) {
      removeSectionToggle();
      if (!label) return;
      sectionLabel = label;
      labelAttributes = new Map(['role', 'tabindex', 'aria-expanded', 'aria-label'].map(
        (name) => [name, label.getAttribute(name)],
      ));
      label.setAttribute('data-dsr-section-toggle', '');
      label.setAttribute('role', 'button');
      label.setAttribute('tabindex', '0');
      label.addEventListener('click', onSectionClick);
      label.addEventListener('keydown', onSectionKeyDown);
    }
    sectionLabel?.setAttribute('aria-expanded', String(!state.collapsed));
    sectionLabel?.setAttribute('aria-label', `${state.collapsed ? '展开' : '收起'}${sectionLabel.textContent}`);
  }

  function removeSectionToggle() {
    if (sectionLabel === null) return;
    sectionLabel.removeEventListener('click', onSectionClick);
    sectionLabel.removeEventListener('keydown', onSectionKeyDown);
    sectionLabel.removeAttribute('data-dsr-section-toggle');
    for (const [name, value] of labelAttributes) {
      if (value === null) sectionLabel.removeAttribute(name);
      else sectionLabel.setAttribute(name, value);
    }
    sectionLabel = null;
    labelAttributes = null;
  }

  function setSectionCollapsed(collapsed) {
    emit({ collapsed: Boolean(collapsed) });
    scheduleApply();
  }

  function onSectionClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setSectionCollapsed(!state.collapsed);
  }

  function onSectionKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') onSectionClick(event);
  }

  function ensureHeaderButton() {
    if (header === null || searchInput === null) return;
    if (headerButton !== null && header.contains(headerButton)) return;
    if (headerButton !== null) headerButton.remove();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dsr-collapse-all';
    button.setAttribute(HEADER_BUTTON_ATTRIBUTE, '');
    button.setAttribute('aria-label', COLLAPSE_LABEL);
    button.title = COLLAPSE_LABEL;
    button.innerHTML = COLLAPSE_SVG;
    button.addEventListener('click', onCollapseAllClick);

    const searchSlot = Array.from(header.children).find(
      (child) => child instanceof HTMLElement && child.tagName === 'DIV',
    );
    if (searchSlot !== undefined) header.insertBefore(button, searchSlot);
    else header.append(button);
    headerButton = button;
  }

  function removeHeaderButton() {
    if (headerButton === null) return;
    headerButton.removeEventListener('click', onCollapseAllClick);
    headerButton.remove();
    headerButton = null;
  }

  function onCollapseAllClick(event) {
    event.preventDefault();
    event.stopPropagation();
    collapseAll();
  }

  function apply() {
    frame = 0;
    if (disposed) return;
    if (!readParts()) {
      removeHeaderButton();
      removeSectionToggle();
      bindSearchInput();
      showAllGroups();
      restoreLayout();
      releasePortalHost();
      clearActivityHosts();
      clearPinHosts();
      emit({ total: 0, searchActive: false, available: false, portalHost: null, activityTargets: [], pinTargets: [] });
      return;
    }

    ensurePortalHost();
    ensureObserver();
    bindSearchInput();
    const searchActive = searchIsActive();
    // A new native search must reveal its results, even after section collapse.
    if (searchActive && !state.searchActive) emit({ collapsed: false });
    updateLayout();

    if (searchInput !== null) ensureSectionToggle();
    else removeSectionToggle();

    // Version gate: both the official tree and its wide header search field must
    // exist. A future composition that changes this structure stays untouched.
    if (tree === null || searchInput === null) {
      removeHeaderButton();
      showAllGroups();
      clearActivityHosts();
      clearPinHosts();
      emit({ total: 0, searchActive: false, available: false, portalHost, activityTargets: [], pinTargets: [] });
      return;
    }

    ensureHeaderButton();
    const rows = [...tree.querySelectorAll(`[data-row-key^="${GROUP_ROW_PREFIX}"]`)];
    const groups = orderPinned(topLevelGroups(), workspacePinIds, groupKey);
    updatePinOrdering(rows);
    const currentGroups = new Set(groups);
    for (const group of hiddenGroups.keys()) {
      if (!currentGroups.has(group)) showGroup(group);
    }
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const hide = !searchActive && index >= state.limit;
      if (hide) {
        if (!hiddenGroups.has(group)) {
          hiddenGroups.set(group, group.getAttribute('aria-hidden'));
        }
        group.setAttribute(HIDDEN_ATTRIBUTE, '');
        group.setAttribute('aria-hidden', 'true');
      } else {
        showGroup(group);
      }
    }
    emit({
      total: searchActive ? 0 : groups.length,
      searchActive,
      available: true,
      portalHost,
      activityTargets: updateActivityTargets(rows),
      pinTargets: updatePinTargets(rows),
    });
  }

  function scheduleApply() {
    if (disposed || !attached) return;
    if (typeof requestAnimationFrame !== 'function') {
      apply();
      return;
    }
    if (frame !== 0) return;
    frame = requestAnimationFrame(apply);
  }

  function bindSearchInput() {
    if (searchInput === null) {
      if (searchListener !== null) {
        searchListener.target.removeEventListener('input', searchListener.handler);
        searchListener.target.removeEventListener('focus', searchListener.focus);
        searchListener = null;
      }
      return;
    }
    if (searchListener?.target === searchInput) return;
    if (searchListener !== null) {
      searchListener.target.removeEventListener('input', searchListener.handler);
      searchListener.target.removeEventListener('focus', searchListener.focus);
      searchListener = null;
    }
    const handler = () => scheduleApply();
    const focus = () => {
      if (state.collapsed) setSectionCollapsed(false);
    };
    searchInput.addEventListener('input', handler);
    searchInput.addEventListener('focus', focus);
    searchListener = { target: searchInput, handler, focus };
  }

  function ensureObserver() {
    if (slot === null) return;
    if (observer !== null && observerTarget === slot) return;
    observer?.disconnect();
    observer = new MutationObserver((records) => {
      // Recent-list renders and native row status/icon updates do not change
      // workspace membership. Ignore them; batch structural changes once/frame.
      const structural = records.some(({ type, target }) => {
        if (type !== 'childList') return false;
        if (portalHost?.contains(target)) return false;
        const element = target instanceof HTMLElement ? target : target.parentElement;
        return !element?.closest('[data-row-key]');
      });
      if (structural) scheduleApply();
    });
    observer.observe(slot, { childList: true, subtree: true });
    observerTarget = slot;
  }

  function attach() {
    if (disposed) return;
    attached = true;
    readParts();
    ensurePortalHost();
    bindSearchInput();
    ensureHeaderButton();
    ensureObserver();
    scheduleApply();
  }

  function detach() {
    attached = false;
    observer?.disconnect();
    observer = null;
    observerTarget = null;
    if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
    if (searchListener !== null) {
      searchListener.target.removeEventListener('input', searchListener.handler);
      searchListener.target.removeEventListener('focus', searchListener.focus);
      searchListener = null;
    }
    removeHeaderButton();
    removeSectionToggle();
    showAllGroups();
    restoreLayout();
    releasePortalHost();
    clearActivityHosts();
    clearPinHosts();
    // Keep the last total/limit; the next attach re-reads the DOM.
  }

  function setLimit(limit) {
    const next = Math.max(DEFAULT_WORKSPACE_LIMIT, Math.floor(Number(limit) || 0));
    if (next === state.limit) return;
    state = { ...state, limit: next };
    for (const listener of [...listeners]) listener();
    scheduleApply();
  }

  function collapseList() {
    setLimit(DEFAULT_WORKSPACE_LIMIT);
  }

  function collapseAll() {
    if (disposed) return false;
    const uiWorkspace = ctx.get('uiWorkspace');
    const workspaces = ctx.get('workspaces');
    const view = uiWorkspace?.view;
    if (view !== undefined && typeof view.setGroupExpanded === 'function') {
      const snapshot = workspaces?.list?.getSnapshot?.();
      for (const key of workspaceGroupKeys(snapshot)) view.setGroupExpanded(key, false);
      scheduleApply();
      return true;
    }
    // Reversible fallback for a host that hides the official view store:
    // activate only the native disclosure rows, one click each.
    let changed = false;
    for (const row of slot?.querySelectorAll('[role="treeitem"][aria-expanded="true"]') ?? []) {
      if (row instanceof HTMLElement && row.dataset.rowKey?.startsWith(GROUP_ROW_PREFIX)) {
        row.click();
        changed = true;
      }
    }
    if (changed) scheduleApply();
    return changed;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    detach();
    listeners.clear();
    slot = null;
    tree = null;
    header = null;
    nativeRoot = null;
    searchInput = null;
    workspaceActivity = new Map();
  }

  return {
    attach,
    detach,
    dispose,
    subscribe,
    getSnapshot,
    getPortalHost,
    setLimit,
    collapseList,
    setSectionCollapsed,
    setWorkspaceActivity,
    setWorkspacePins,
    collapseAll,
    get attached() {
      return attached;
    },
    get disposed() {
      return disposed;
    },
  };
}
