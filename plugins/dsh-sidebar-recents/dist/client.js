window.__ModuleLoader__.load({id:"dsh-sidebar-recents",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react4 = __toESM(require("react"), 1);

// src/core/workspaces.js
function workspaceGroupKeys(workspacesSnapshot) {
  const keys = /* @__PURE__ */ new Set();
  keys.add("");
  for (const workspace of workspacesSnapshot?.items ?? []) {
    if (typeof workspace?.workspaceId === "string" && workspace.workspaceId !== "") {
      keys.add(workspace.workspaceId);
    }
  }
  return [...keys];
}

// src/core/pins.js
var WORKSPACE_PIN_STORAGE = "dsh-sidebar-recents.workspace-pins.v1";
function togglePinnedId(ids, id) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [id, ...ids];
}
function orderPinned(items, pinnedIds, keyOf) {
  const ranks = new Map(pinnedIds.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index, rank: ranks.get(keyOf(item)) ?? Infinity })).sort((left, right) => left.rank === right.rank ? left.index - right.index : left.rank - right.rank).map(({ item }) => item);
}
function createWorkspacePinStore(createStore) {
  const source = createStore({ ids: [] }, { persist: { name: WORKSPACE_PIN_STORAGE } });
  return {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => source.subscribe(listener),
    toggle(id) {
      source.set({ ids: togglePinnedId(source.getSnapshot().ids, id) });
    }
  };
}
async function toggleSessionPin(ctx, id) {
  const service = ctx.get("uiWorkspace");
  const pinned = ctx.get("workspaces").list.getSnapshot().pinnedSessionIds?.includes(id) === true;
  await service[pinned ? "unpinSession" : "pinSession"](id);
}

// src/client/chrome.js
var SLOT_SELECTOR = '[data-slot="sidebar.workspaces"]';
var TREE_SELECTOR = '[role="tree"]';
var GROUP_ROW_PREFIX = "workspace:";
var HIDDEN_ATTRIBUTE = "data-dsr-hidden";
var HEADER_BUTTON_ATTRIBUTE = "data-dsr-collapse-all";
var DEFAULT_WORKSPACE_LIMIT = 5;
var COLLAPSE_LABEL = "\u6536\u8D77\u6240\u6709\u6587\u4EF6\u5939";
var COLLAPSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M9 13h6"/></svg>';
function sameChromeState(left, right) {
  return left.total === right.total && left.limit === right.limit && left.searchActive === right.searchActive && left.collapsed === right.collapsed && left.available === right.available && sameActivityTargets(left.activityTargets, right.activityTargets) && samePinTargets(left.pinTargets, right.pinTargets) && left.portalHost === right.portalHost;
}
function samePinTargets(left, right) {
  return left.length === right.length && left.every(
    (item, index) => item.host === right[index].host && item.name === right[index].name
  );
}
function sameActivityTargets(left, right) {
  return left.length === right.length && left.every(
    (item, index) => item.host === right[index].host && item.activity.state === right[index].activity.state && item.activity.label === right[index].activity.label
  );
}
function createWorkspaceChrome(ctx) {
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
  const listeners = /* @__PURE__ */ new Set();
  const layoutElements = /* @__PURE__ */ new Map();
  const hiddenGroups = /* @__PURE__ */ new Map();
  const activityHosts = /* @__PURE__ */ new Map();
  const pinHosts = /* @__PURE__ */ new Map();
  const pinContainers = /* @__PURE__ */ new Set();
  const pinGroups = /* @__PURE__ */ new Map();
  let workspacePinIds = [];
  let workspaceNames = /* @__PURE__ */ new Map();
  let workspaceActivity = /* @__PURE__ */ new Map();
  let state = {
    total: 0,
    limit: DEFAULT_WORKSPACE_LIMIT,
    searchActive: false,
    collapsed: false,
    available: false,
    portalHost: null,
    activityTargets: [],
    pinTargets: []
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
      (child) => child instanceof HTMLElement && // Real workspace rows are wrapped by HoverCard; ungrouped rows are not.
      // Inspect each top-level group once, stopping at its first matching row.
      // Nested workspaces therefore never count as additional top-level items.
      (child.matches(`[data-row-key^="${GROUP_ROW_PREFIX}"]`) || child.querySelector(`[data-row-key^="${GROUP_ROW_PREFIX}"]`) !== null)
    );
  }
  function groupKey(group) {
    const row = group.matches(`[data-row-key^="${GROUP_ROW_PREFIX}"]`) ? group : group.querySelector(`[data-row-key^="${GROUP_ROW_PREFIX}"]`);
    return row?.dataset.rowKey.slice(GROUP_ROW_PREFIX.length);
  }
  function setWorkspacePins(ids, workspaces = []) {
    const names = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.title ?? workspace.workspaceId]));
    const unchanged = ids.length === workspacePinIds.length && ids.every((id, index) => id === workspacePinIds[index]) && names.size === workspaceNames.size && [...names].every(([id, name]) => workspaceNames.get(id) === name);
    if (unchanged || disposed) return;
    workspacePinIds = [...ids];
    workspaceNames = names;
    scheduleApply();
  }
  function restorePinGroup(group, previous) {
    group.removeAttribute("data-dsr-pin-group");
    if (previous.value) group.style.setProperty("--dsr-pin-order", previous.value, previous.priority);
    else group.style.removeProperty("--dsr-pin-order");
  }
  function clearPinOrdering() {
    for (const container of pinContainers) container.removeAttribute("data-dsr-pin-container");
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
        host = document.createElement("span");
        host.className = "dsr-workspace-pin";
        host.setAttribute("data-dsr-workspace-pin", key);
        const actions = Array.from(row.children).find((child) => child.className?.includes("_rowActions"));
        row.insertBefore(host, actions ?? null);
        pinHosts.set(row, host);
      }
      const name = workspaceNames.get(key) ?? row.querySelector('[class*="_projectText"]')?.textContent ?? (key || "\u672A\u5206\u7EC4");
      targets.push({ key, host, name });
    }
    for (const [row, host] of pinHosts) {
      if (currentRows.has(row)) continue;
      host.remove();
      pinHosts.delete(row);
    }
    return targets;
  }
  function updatePinOrdering(rows) {
    const levels = /* @__PURE__ */ new Map();
    const pinned = new Set(workspacePinIds);
    for (const row of rows) {
      let group = row;
      while (group.parentElement && group.parentElement !== tree && group.parentElement.getAttribute("role") !== "group") group = group.parentElement;
      const container = group.parentElement;
      if (!container || container !== tree && container.getAttribute("role") !== "group") continue;
      if (!levels.has(container)) levels.set(container, []);
      levels.get(container).push(group);
    }
    const nextContainers = /* @__PURE__ */ new Set();
    const nextGroups = /* @__PURE__ */ new Map();
    for (const [container, groups] of levels) {
      if (!groups.some((group) => pinned.has(groupKey(group)))) continue;
      nextContainers.add(container);
      orderPinned(groups, workspacePinIds, groupKey).forEach((group, index) => nextGroups.set(group, String(index)));
    }
    for (const container of pinContainers) {
      if (!nextContainers.has(container)) container.removeAttribute("data-dsr-pin-container");
    }
    pinContainers.clear();
    for (const container of nextContainers) {
      container.setAttribute("data-dsr-pin-container", "");
      pinContainers.add(container);
    }
    for (const [group, previous] of pinGroups) {
      if (nextGroups.has(group)) continue;
      restorePinGroup(group, previous);
      pinGroups.delete(group);
    }
    for (const [group, order] of nextGroups) {
      if (!pinGroups.has(group)) pinGroups.set(group, {
        value: group.style.getPropertyValue("--dsr-pin-order"),
        priority: typeof group.style.getPropertyPriority === "function" ? group.style.getPropertyPriority("--dsr-pin-order") : ""
      });
      group.setAttribute("data-dsr-pin-group", "");
      if (group.style.getPropertyValue("--dsr-pin-order") !== order) group.style.setProperty("--dsr-pin-order", order);
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
    const activeRows = /* @__PURE__ */ new Set();
    for (const row of rows) {
      const key = row.dataset.rowKey.slice(GROUP_ROW_PREFIX.length);
      const activity = workspaceActivity.get(key);
      if (!activity) continue;
      activeRows.add(row);
      let host = activityHosts.get(row);
      if (!host || host.parentElement !== row) {
        host?.remove();
        host = document.createElement("span");
        host.className = "dsr-workspace-activity";
        host.setAttribute("data-dsr-workspace-activity", key);
        const actions = Array.from(row.children).find((child) => child.className?.includes("_rowActions"));
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
    if (typeof document === "undefined") return false;
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
      (child) => child instanceof HTMLElement && !child.hasAttribute("data-dsr-lower")
    );
    header = nativeRoot instanceof HTMLElement ? nativeRoot.firstElementChild : null;
    if (!(header instanceof HTMLElement)) header = null;
    searchInput = header instanceof HTMLElement ? header.querySelector('input[type="text"]') : null;
    return true;
  }
  function ensurePortalHost() {
    if (slot === null || !(nativeRoot instanceof HTMLElement)) return null;
    if (portalHost !== null && portalHost.isConnected && portalHost.parentElement === slot && portalHost.previousElementSibling === nativeRoot) {
      return portalHost;
    }
    if (portalHost !== null) portalHost.remove();
    const host = document.createElement("div");
    host.className = "dsr-lower";
    host.setAttribute("data-dsr-lower", "");
    slot.insertBefore(host, nativeRoot.nextSibling);
    portalHost = host;
    return host;
  }
  function restoreLayout() {
    collapsedBody?.removeAttribute("data-dsr-section-collapsed");
    collapsedBody = null;
    for (const [element, attribute] of layoutElements) {
      element.removeAttribute(attribute);
    }
    layoutElements.clear();
  }
  function updateLayout() {
    const elements = /* @__PURE__ */ new Map();
    if (slot?.parentElement && nativeRoot instanceof HTMLElement) {
      elements.set(slot.parentElement, "data-dsr-region");
      elements.set(nativeRoot, "data-dsr-workspace-root");
      const body = Array.from(nativeRoot.children).find(
        (child) => child !== header && (tree ? child.contains(tree) : child === header?.nextElementSibling)
      );
      if (body) elements.set(body, "data-dsr-workspace-body");
      if (tree !== null) {
        elements.set(tree, "data-dsr-workspace-tree");
      }
      if (collapsedBody !== body) collapsedBody?.removeAttribute("data-dsr-section-collapsed");
      collapsedBody = body ?? null;
      collapsedBody?.toggleAttribute("data-dsr-section-collapsed", state.collapsed);
    }
    for (const [element, attribute] of layoutElements) {
      if (elements.get(element) !== attribute) element.removeAttribute(attribute);
    }
    layoutElements.clear();
    for (const [element, attribute] of elements) {
      element.setAttribute(attribute, "");
      layoutElements.set(element, attribute);
    }
  }
  function showGroup(group) {
    if (!hiddenGroups.has(group)) return;
    const previousAriaHidden = hiddenGroups.get(group);
    group.removeAttribute(HIDDEN_ATTRIBUTE);
    if (previousAriaHidden === null) group.removeAttribute("aria-hidden");
    else group.setAttribute("aria-hidden", previousAriaHidden);
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
    queueMicrotask(() => {
      if (host.childElementCount === 0) host.remove();
    });
  }
  function searchIsActive() {
    return searchInput instanceof HTMLInputElement && searchInput.value.trim() !== "";
  }
  function ensureSectionToggle() {
    const label = Array.from(header?.children ?? []).find((child) => child.tagName === "SPAN");
    if (label !== sectionLabel) {
      removeSectionToggle();
      if (!label) return;
      sectionLabel = label;
      labelAttributes = new Map(["role", "tabindex", "aria-expanded", "aria-label"].map(
        (name) => [name, label.getAttribute(name)]
      ));
      label.setAttribute("data-dsr-section-toggle", "");
      label.setAttribute("role", "button");
      label.setAttribute("tabindex", "0");
      label.addEventListener("click", onSectionClick);
      label.addEventListener("keydown", onSectionKeyDown);
    }
    sectionLabel?.setAttribute("aria-expanded", String(!state.collapsed));
    sectionLabel?.setAttribute("aria-label", `${state.collapsed ? "\u5C55\u5F00" : "\u6536\u8D77"}${sectionLabel.textContent}`);
  }
  function removeSectionToggle() {
    if (sectionLabel === null) return;
    sectionLabel.removeEventListener("click", onSectionClick);
    sectionLabel.removeEventListener("keydown", onSectionKeyDown);
    sectionLabel.removeAttribute("data-dsr-section-toggle");
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
    if (event.key === "Enter" || event.key === " ") onSectionClick(event);
  }
  function ensureHeaderButton() {
    if (header === null || searchInput === null) return;
    if (headerButton !== null && header.contains(headerButton)) return;
    if (headerButton !== null) headerButton.remove();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dsr-collapse-all";
    button.setAttribute(HEADER_BUTTON_ATTRIBUTE, "");
    button.setAttribute("aria-label", COLLAPSE_LABEL);
    button.title = COLLAPSE_LABEL;
    button.innerHTML = COLLAPSE_SVG;
    button.addEventListener("click", onCollapseAllClick);
    const searchSlot = Array.from(header.children).find(
      (child) => child instanceof HTMLElement && child.tagName === "DIV"
    );
    if (searchSlot !== void 0) header.insertBefore(button, searchSlot);
    else header.append(button);
    headerButton = button;
  }
  function removeHeaderButton() {
    if (headerButton === null) return;
    headerButton.removeEventListener("click", onCollapseAllClick);
    headerButton.remove();
    headerButton = null;
  }
  function onCollapseAllClick(event) {
    event.preventDefault();
    event.stopPropagation();
    collapseAll();
  }
  function apply2() {
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
    if (searchActive && !state.searchActive) emit({ collapsed: false });
    updateLayout();
    if (searchInput !== null) ensureSectionToggle();
    else removeSectionToggle();
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
          hiddenGroups.set(group, group.getAttribute("aria-hidden"));
        }
        group.setAttribute(HIDDEN_ATTRIBUTE, "");
        group.setAttribute("aria-hidden", "true");
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
      pinTargets: updatePinTargets(rows)
    });
  }
  function scheduleApply() {
    if (disposed || !attached) return;
    if (typeof requestAnimationFrame !== "function") {
      apply2();
      return;
    }
    if (frame !== 0) return;
    frame = requestAnimationFrame(apply2);
  }
  function bindSearchInput() {
    if (searchInput === null) {
      if (searchListener !== null) {
        searchListener.target.removeEventListener("input", searchListener.handler);
        searchListener.target.removeEventListener("focus", searchListener.focus);
        searchListener = null;
      }
      return;
    }
    if (searchListener?.target === searchInput) return;
    if (searchListener !== null) {
      searchListener.target.removeEventListener("input", searchListener.handler);
      searchListener.target.removeEventListener("focus", searchListener.focus);
      searchListener = null;
    }
    const handler = () => scheduleApply();
    const focus = () => {
      if (state.collapsed) setSectionCollapsed(false);
    };
    searchInput.addEventListener("input", handler);
    searchInput.addEventListener("focus", focus);
    searchListener = { target: searchInput, handler, focus };
  }
  function ensureObserver() {
    if (slot === null) return;
    if (observer !== null && observerTarget === slot) return;
    observer?.disconnect();
    observer = new MutationObserver((records) => {
      const structural = records.some(({ type, target }) => {
        if (type !== "childList") return false;
        if (portalHost?.contains(target)) return false;
        const element = target instanceof HTMLElement ? target : target.parentElement;
        return !element?.closest("[data-row-key]");
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
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
    if (searchListener !== null) {
      searchListener.target.removeEventListener("input", searchListener.handler);
      searchListener.target.removeEventListener("focus", searchListener.focus);
      searchListener = null;
    }
    removeHeaderButton();
    removeSectionToggle();
    showAllGroups();
    restoreLayout();
    releasePortalHost();
    clearActivityHosts();
    clearPinHosts();
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
    const uiWorkspace = ctx.get("uiWorkspace");
    const workspaces = ctx.get("workspaces");
    const view = uiWorkspace?.view;
    if (view !== void 0 && typeof view.setGroupExpanded === "function") {
      const snapshot = workspaces?.list?.getSnapshot?.();
      for (const key of workspaceGroupKeys(snapshot)) view.setGroupExpanded(key, false);
      scheduleApply();
      return true;
    }
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
    workspaceActivity = /* @__PURE__ */ new Map();
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
    }
  };
}

// src/client/recents-panel.js
var import_react3 = __toESM(require("react"), 1);
var import_react_dom = require("react-dom");

// src/core/recents.js
var RECENT_PAGE_SIZE = 5;
var FALLBACK_TITLE = "\u672A\u547D\u540D\u4F1A\u8BDD";
var UNGROUPED_LABEL = "\u672A\u5206\u7EC4";
function workspaceLabelOf(path) {
  if (typeof path !== "string") return void 0;
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") return void 0;
  const parts = trimmed.split(/[\\/]+/);
  const name = parts[parts.length - 1];
  return name === "" ? void 0 : name;
}
function buildRecents(sessionsSnapshot, workspacesSnapshot, options = {}) {
  const list = sessionsSnapshot ?? {};
  const byId = list.byId ?? {};
  const ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId);
  const workspaces = Array.isArray(workspacesSnapshot?.items) ? workspacesSnapshot.items : [];
  const panelActive = options.panelActive === true;
  const pinRanks = new Map((workspacesSnapshot?.pinnedSessionIds ?? []).map((id, index) => [id, index]));
  const archived = new Set(
    Array.isArray(workspacesSnapshot?.archivedSessionIds) ? workspacesSnapshot.archivedSessionIds : []
  );
  const workspaceLabelBySession = /* @__PURE__ */ new Map();
  const workspaceIdBySession = /* @__PURE__ */ new Map();
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.workspaceId !== "string") continue;
    const label = (typeof workspace.title === "string" && workspace.title.trim() !== "" ? workspace.title.trim() : workspaceLabelOf(workspace.path)) ?? UNGROUPED_LABEL;
    for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (!workspaceLabelBySession.has(sessionId)) {
        workspaceLabelBySession.set(sessionId, label);
        workspaceIdBySession.set(sessionId, workspace.workspaceId);
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (let index = 0; index < ids.length; index += 1) {
    const sessionId = ids[index];
    if (typeof sessionId !== "string" || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const summary = byId[sessionId];
    if (summary === void 0 || summary === null) continue;
    if (summary.blank === true) continue;
    if (archived.has(sessionId)) continue;
    if (summary.origin === "subagent") continue;
    const rawTitle = typeof summary.displayTitle === "string" && summary.displayTitle.trim() !== "" ? summary.displayTitle : typeof summary.title === "string" ? summary.title : "";
    const title = rawTitle.trim() === "" ? FALLBACK_TITLE : rawTitle.trim();
    const workspaceLabel = workspaceLabelBySession.get(sessionId) ?? workspaceLabelOf(summary.cwd) ?? UNGROUPED_LABEL;
    const workspaceId = workspaceIdBySession.get(sessionId);
    const updatedAt = Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0;
    rows.push({
      sessionId,
      title,
      workspaceLabel,
      ...workspaceId === void 0 ? {} : { workspaceId },
      updatedAt,
      current: !panelActive && (summary.retainedBy?.mainView ?? 0) > 0,
      pinned: pinRanks.has(sessionId),
      originalIndex: index
    });
  }
  rows.sort((left, right) => {
    const leftPin = pinRanks.get(left.sessionId) ?? Infinity;
    const rightPin = pinRanks.get(right.sessionId) ?? Infinity;
    if (leftPin !== rightPin) return leftPin - rightPin;
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return left.originalIndex - right.originalIndex;
  });
  const titleCounts = /* @__PURE__ */ new Map();
  for (const row of rows) titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);
  return rows.map(({ originalIndex: _originalIndex, ...row }) => ({
    ...row,
    showWorkspaceHint: (titleCounts.get(row.title) ?? 0) > 1
  }));
}
function nextVisibleCount(visibleCount, total, pageSize = RECENT_PAGE_SIZE) {
  const current = Number.isFinite(visibleCount) ? Math.max(pageSize, Math.floor(visibleCount)) : pageSize;
  return Math.min(Math.max(total, 0), current + pageSize);
}
function effectiveVisibleCount(visibleCount, total, pageSize = RECENT_PAGE_SIZE) {
  const requested = Number.isFinite(visibleCount) ? Math.max(pageSize, Math.floor(visibleCount)) : pageSize;
  if (total <= pageSize) return total;
  return Math.min(requested, total);
}
function hasMoreRecents(visibleCount, total) {
  return total > visibleCount;
}
function canCollapseRecents(visibleCount, pageSize = RECENT_PAGE_SIZE) {
  return visibleCount > pageSize;
}

// src/client/navigation.js
function openRecentSession(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const uiWorkspace = ctx.get("uiWorkspace");
  if (uiWorkspace === void 0 || typeof uiWorkspace.openSession !== "function") {
    console.warn("sidebar-recents: uiWorkspace.openSession is unavailable");
    return false;
  }
  try {
    uiWorkspace.openSession(sessionId);
    return true;
  } catch (error) {
    console.warn("sidebar-recents: failed to open session", error);
    return false;
  }
}

// src/core/activity.js
var WAITING_LABELS = {
  approval: "\u7B49\u5F85\u5BA1\u6279",
  "plan-review": "\u7B49\u5F85\u8BA1\u5212\u786E\u8BA4",
  question: "\u7B49\u5F85\u56DE\u7B54"
};
function buildSessionActivity(list, statuses, archivedSessionIds = []) {
  const activity = /* @__PURE__ */ new Map();
  const archived = new Set(archivedSessionIds);
  const byId = list?.byId ?? {};
  for (const id of list?.ids ?? Object.keys(byId)) {
    const session = byId[id];
    if (!session || session.origin === "subagent" || archived.has(id)) continue;
    const status = statuses?.get(id);
    const waiting = WAITING_LABELS[status?.pendingInteraction?.kind];
    if (waiting) {
      activity.set(id, { state: "warning", label: waiting });
      continue;
    }
    const running = status?.running ?? session.running;
    const children = list?.projectionsBySession?.[id]?.values?.subagentCatalog ?? [];
    const runningChildren = children.filter(
      (child) => (statuses?.get(child.id)?.running ?? byId[child.id]?.running) === true
    ).length;
    if (running === true || runningChildren > 0) {
      activity.set(id, {
        state: "ongoing",
        label: runningChildren > 0 ? `\u6267\u884C\u4E2D\uFF08${runningChildren} \u4E2A\u5B50\u4EFB\u52A1\u6267\u884C\u4E2D\uFF09` : "\u6267\u884C\u4E2D"
      });
    }
  }
  return activity;
}
function folderPath(path) {
  if (typeof path !== "string" || path === "") return null;
  return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\") ? path.replaceAll("\\", "/") : path).replace(/\/+$/, "");
}
function buildWorkspaceActivityIndex(workspaces) {
  const groups = (workspaces?.items ?? []).filter((item) => typeof item?.workspaceId === "string");
  const paths = new Map(groups.map((item) => [item.workspaceId, folderPath(item.path)]));
  const memberships = /* @__PURE__ */ new Map();
  for (const group of groups) {
    const ownPath = paths.get(group.workspaceId);
    const keys = /* @__PURE__ */ new Set([group.workspaceId]);
    if (ownPath !== null) {
      for (const [key, parentPath] of paths) {
        if (parentPath !== null && ownPath !== parentPath && ownPath.startsWith(`${parentPath}/`)) keys.add(key);
      }
    }
    for (const id of group.sessionIds ?? []) {
      if (!memberships.has(id)) memberships.set(id, /* @__PURE__ */ new Set());
      for (const key of keys) memberships.get(id).add(key);
    }
  }
  return memberships;
}
function buildWorkspaceActivity(sessionActivity, memberships) {
  const groups = /* @__PURE__ */ new Map();
  for (const [id, activity] of sessionActivity) {
    for (const key of memberships.get(id) ?? [""]) {
      if (!groups.has(key)) groups.set(key, { running: 0, waiting: 0 });
      const group = groups.get(key);
      if (activity.state === "ongoing") group.running += 1;
      else group.waiting += 1;
    }
  }
  return new Map([...groups].map(([key, { running, waiting }]) => [key, {
    state: running > 0 ? "ongoing" : "warning",
    label: [running > 0 ? `${running} \u4E2A\u4F1A\u8BDD\u6267\u884C\u4E2D` : "", waiting > 0 ? `${waiting} \u4E2A\u4F1A\u8BDD\u7B49\u5F85\u5904\u7406` : ""].filter(Boolean).join("\uFF0C")
  }]));
}

// src/client/activity-indicator.js
var import_react = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
function ActivityIndicator({ activity }) {
  if (!activity) return null;
  return /* @__PURE__ */ import_react.default.createElement("span", { className: "dsr-activity", role: "img", "aria-label": activity.label, title: activity.label }, /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.StateDot, { state: activity.state }));
}

// src/client/pin-button.js
var import_react2 = __toESM(require("react"), 1);
function PinButton({ pinned, name, onToggle, onError }) {
  const inFlight = (0, import_react2.useRef)(false);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const label = `${pinned ? "\u53D6\u6D88\u7F6E\u9876" : "\u7F6E\u9876"}${name}`;
  return /* @__PURE__ */ import_react2.default.createElement(
    "button",
    {
      type: "button",
      className: "dsr-pin-button",
      "aria-label": label,
      "aria-pressed": pinned,
      title: label,
      disabled: busy,
      onClick: async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        onError("");
        try {
          await onToggle();
        } catch {
          onError(`${label}\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5`);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    /* @__PURE__ */ import_react2.default.createElement("svg", { viewBox: "0 0 24 24", fill: pinned ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, /* @__PURE__ */ import_react2.default.createElement("path", { d: "M9 3h6l-1 6 4 4v2H6v-2l4-4z" }), /* @__PURE__ */ import_react2.default.createElement("path", { d: "M12 15v6" }))
  );
}

// src/client/recents-panel.js
var NOOP_SUBSCRIBE = () => () => {
};
var EMPTY_SESSIONS = Object.freeze({ ids: [], byId: {} });
var EMPTY_WORKSPACES = Object.freeze({ items: [], archivedSessionIds: [] });
var EMPTY_STATUS = /* @__PURE__ */ new Map();
var EMPTY_PINS = Object.freeze({ ids: [] });
var EMPTY_CHROME = Object.freeze({
  total: 0,
  limit: RECENT_PAGE_SIZE,
  searchActive: false,
  collapsed: false,
  available: false,
  portalHost: null,
  activityTargets: [],
  pinTargets: []
});
var getEmptySessions = () => EMPTY_SESSIONS;
var getEmptyWorkspaces = () => EMPTY_WORKSPACES;
var getEmptyChrome = () => EMPTY_CHROME;
var getEmptyStatus = () => EMPTY_STATUS;
var getEmptyPins = () => EMPTY_PINS;
function useStoreSnapshot(store, fallback) {
  const source = (0, import_react3.useMemo)(
    () => store ? {
      subscribe: (listener) => store.subscribe(listener),
      getSnapshot: () => store.getSnapshot()
    } : { subscribe: NOOP_SUBSCRIBE, getSnapshot: fallback },
    [store, fallback]
  );
  return (0, import_react3.useSyncExternalStore)(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot
  );
}
function useChromeSnapshot(chrome) {
  return (0, import_react3.useSyncExternalStore)(
    chrome?.subscribe ?? NOOP_SUBSCRIBE,
    chrome?.getSnapshot ?? getEmptyChrome,
    chrome?.getSnapshot ?? getEmptyChrome
  );
}
function RecentsPanel({ wide, ctx, chrome, workspacePins, usePanelInfo }) {
  if (wide === false) return null;
  const sessions = ctx.get("sessions");
  const workspaces = ctx.get("workspaces");
  if (sessions?.list === void 0 || workspaces?.list === void 0) return null;
  if (typeof usePanelInfo === "function") {
    return /* @__PURE__ */ import_react3.default.createElement(
      RecentsPanelWithPanelInfo,
      {
        ctx,
        chrome,
        workspacePins,
        usePanelInfo,
        sessionStore: sessions.list,
        workspaceStore: workspaces.list
      }
    );
  }
  return /* @__PURE__ */ import_react3.default.createElement(
    RecentsPanelConnected,
    {
      ctx,
      chrome,
      workspacePins,
      panelActive: false,
      sessionStore: sessions.list,
      workspaceStore: workspaces.list
    }
  );
}
function RecentsPanelWithPanelInfo({ ctx, chrome, workspacePins, usePanelInfo, sessionStore, workspaceStore }) {
  const panelActive = usePanelInfo((info) => info?.activePanelId !== null);
  return /* @__PURE__ */ import_react3.default.createElement(
    RecentsPanelConnected,
    {
      ctx,
      chrome,
      workspacePins,
      panelActive: panelActive === true,
      sessionStore,
      workspaceStore
    }
  );
}
function RecentsPanelConnected({
  ctx,
  chrome,
  workspacePins,
  panelActive,
  sessionStore,
  workspaceStore
}) {
  const sessionsSnapshot = useStoreSnapshot(sessionStore, getEmptySessions);
  const workspacesSnapshot = useStoreSnapshot(workspaceStore, getEmptyWorkspaces);
  const statusSnapshot = useStoreSnapshot(ctx.get("uiSession")?.sessionStatus, getEmptyStatus);
  const pinSnapshot = useStoreSnapshot(workspacePins, getEmptyPins);
  const pinnedWorkspaces = (0, import_react3.useMemo)(() => new Set(pinSnapshot.ids), [pinSnapshot]);
  const chromeState = useChromeSnapshot(chrome);
  const [visibleCount, setVisibleCount] = (0, import_react3.useState)(RECENT_PAGE_SIZE);
  const [collapsed, setCollapsed] = (0, import_react3.useState)(false);
  const [pinError, setPinError] = (0, import_react3.useState)("");
  const portalHost = chromeState.portalHost;
  const rowRefs = (0, import_react3.useRef)([]);
  (0, import_react3.useEffect)(() => {
    chrome.attach();
    return () => chrome.detach();
  }, [chrome]);
  (0, import_react3.useEffect)(() => {
    chrome.setWorkspacePins(pinSnapshot.ids, workspacesSnapshot.items);
  }, [chrome, pinSnapshot, workspacesSnapshot]);
  const items = (0, import_react3.useMemo)(
    () => buildRecents(sessionsSnapshot, workspacesSnapshot, { panelActive }),
    [sessionsSnapshot, workspacesSnapshot, panelActive]
  );
  const sessionActivity = (0, import_react3.useMemo)(
    () => buildSessionActivity(sessionsSnapshot, statusSnapshot, workspacesSnapshot.archivedSessionIds),
    [sessionsSnapshot, statusSnapshot, workspacesSnapshot.archivedSessionIds]
  );
  const workspaceActivityIndex = (0, import_react3.useMemo)(
    () => buildWorkspaceActivityIndex(workspacesSnapshot),
    [workspacesSnapshot]
  );
  const workspaceActivity = (0, import_react3.useMemo)(
    () => buildWorkspaceActivity(sessionActivity, workspaceActivityIndex),
    [sessionActivity, workspaceActivityIndex]
  );
  (0, import_react3.useEffect)(() => {
    chrome.setWorkspaceActivity(workspaceActivity);
  }, [chrome, workspaceActivity]);
  const effectiveCount = effectiveVisibleCount(visibleCount, items.length);
  const rows = items.slice(0, effectiveCount);
  const showMore = hasMoreRecents(effectiveCount, items.length);
  const showCollapseRecents = canCollapseRecents(effectiveCount) && items.length > RECENT_PAGE_SIZE;
  const remaining = Math.max(0, items.length - effectiveCount);
  const showWorkspaceMore = chromeState.available && !chromeState.collapsed && !chromeState.searchActive && chromeState.total > chromeState.limit;
  const showWorkspaceCollapse = chromeState.available && !chromeState.collapsed && !chromeState.searchActive && chromeState.limit > RECENT_PAGE_SIZE && chromeState.total > RECENT_PAGE_SIZE;
  const workspaceRemaining = Math.max(0, chromeState.total - chromeState.limit);
  rowRefs.current.length = rows.length;
  const open = (sessionId) => {
    openRecentSession(ctx, sessionId);
  };
  const onListKeyDown = (event) => {
    const buttons = rowRefs.current.filter(
      (button) => button instanceof HTMLButtonElement && button.isConnected
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };
  const pager = showWorkspaceMore || showWorkspaceCollapse ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "dsr-workspace-pager", "data-dsr-workspace-pager": "" }, showWorkspaceMore ? /* @__PURE__ */ import_react3.default.createElement(
    "button",
    {
      type: "button",
      onClick: () => chrome.setLimit(chromeState.limit + RECENT_PAGE_SIZE),
      "aria-expanded": "false"
    },
    "\u5C55\u5F00\u66F4\u591A\uFF08\u5269\u4F59 ",
    workspaceRemaining,
    " \u4E2A\uFF09"
  ) : null, showWorkspaceCollapse ? /* @__PURE__ */ import_react3.default.createElement(
    "button",
    {
      type: "button",
      onClick: () => chrome.collapseList(),
      "aria-expanded": "true"
    },
    "\u6536\u8D77"
  ) : null) : null;
  const content = /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, pager, pinError ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "dsr-pin-error", role: "alert" }, pinError) : null, /* @__PURE__ */ import_react3.default.createElement("section", { className: "dsr-recents", "aria-label": "\u6700\u8FD1\u4F1A\u8BDD", "data-dsr-recents": "" }, /* @__PURE__ */ import_react3.default.createElement("div", { className: "dsr-recents-header" }, /* @__PURE__ */ import_react3.default.createElement(
    "button",
    {
      type: "button",
      className: "dsr-section-toggle",
      "aria-label": collapsed ? "\u5C55\u5F00\u6700\u8FD1" : "\u6536\u8D77\u6700\u8FD1",
      "aria-expanded": !collapsed,
      onClick: () => setCollapsed((value) => !value)
    },
    /* @__PURE__ */ import_react3.default.createElement("span", null, "\u6700\u8FD1"),
    items.length > 0 ? /* @__PURE__ */ import_react3.default.createElement("span", { className: "dsr-recents-count" }, "(", items.length, ")") : null
  )), !collapsed ? /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, rows.length === 0 ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "dsr-recents-empty" }, "\u6682\u65E0\u6700\u8FD1\u4F1A\u8BDD") : /* @__PURE__ */ import_react3.default.createElement(
    "div",
    {
      className: "dsr-recents-list",
      role: "list",
      "aria-label": "\u6700\u8FD1\u4F1A\u8BDD",
      onKeyDown: onListKeyDown,
      "data-dsr-recents-list": ""
    },
    rows.map((row, index) => {
      const activity = sessionActivity.get(row.sessionId);
      return /* @__PURE__ */ import_react3.default.createElement("div", { key: row.sessionId, className: "dsr-recent-item", role: "listitem" }, /* @__PURE__ */ import_react3.default.createElement(
        "button",
        {
          ref: (element) => {
            rowRefs.current[index] = element;
          },
          type: "button",
          "aria-current": row.current ? "page" : void 0,
          "aria-label": [row.title, row.pinned ? "\u5DF2\u7F6E\u9876" : "", row.showWorkspaceHint ? row.workspaceLabel : "", activity?.label].filter(Boolean).join("\uFF0C"),
          title: [row.title, row.workspaceLabel, activity?.label].filter(Boolean).join("\n"),
          className: "dsr-recent-row",
          "data-dsr-session-id": row.sessionId,
          onClick: () => open(row.sessionId)
        },
        /* @__PURE__ */ import_react3.default.createElement(ActivityIndicator, { activity }),
        /* @__PURE__ */ import_react3.default.createElement("span", { className: "dsr-recent-main" }, /* @__PURE__ */ import_react3.default.createElement("span", { className: "dsr-recent-title" }, row.title), row.showWorkspaceHint ? /* @__PURE__ */ import_react3.default.createElement("span", { className: "dsr-recent-workspace" }, row.workspaceLabel) : null)
      ), /* @__PURE__ */ import_react3.default.createElement(
        PinButton,
        {
          pinned: row.pinned,
          name: `\u4F1A\u8BDD\u201C${row.title}\u201D`,
          onToggle: () => toggleSessionPin(ctx, row.sessionId),
          onError: setPinError
        }
      ));
    })
  ), showMore || showCollapseRecents ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "dsr-recents-actions" }, showMore ? /* @__PURE__ */ import_react3.default.createElement(
    "button",
    {
      type: "button",
      className: "dsr-recents-action",
      onClick: () => setVisibleCount(nextVisibleCount(effectiveCount, items.length)),
      "aria-expanded": "false"
    },
    "\u5C55\u5F00\u66F4\u591A\uFF08\u5269\u4F59 ",
    remaining,
    " \u4E2A\uFF09"
  ) : null, showCollapseRecents ? /* @__PURE__ */ import_react3.default.createElement(
    "button",
    {
      type: "button",
      className: "dsr-recents-action",
      onClick: () => setVisibleCount(RECENT_PAGE_SIZE),
      "aria-expanded": "true"
    },
    "\u6536\u8D77"
  ) : null) : null) : null));
  if (portalHost === null) return null;
  return /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, (0, import_react_dom.createPortal)(content, portalHost), chromeState.activityTargets.map(({ key, host, activity }) => (0, import_react_dom.createPortal)(
    /* @__PURE__ */ import_react3.default.createElement(ActivityIndicator, { activity }),
    host,
    key
  )), chromeState.pinTargets.map(({ key, host, name }) => (0, import_react_dom.createPortal)(
    /* @__PURE__ */ import_react3.default.createElement(
      PinButton,
      {
        pinned: pinnedWorkspaces.has(key),
        name: `\u5DE5\u4F5C\u533A\u201C${name}\u201D`,
        onToggle: () => workspacePins.toggle(key),
        onError: setPinError
      }
    ),
    host,
    `pin:${key}`
  )));
}

// src/client/styles.js
var STYLE_ATTRIBUTE = "data-dsh-sidebar-recents";
var STYLE_ID = "dsh-sidebar-recents/styles";
var CSS = `
[data-slot="sidebar.workspaces"] [data-dsr-hidden] {
  display: none !important;
}
[data-dsr-region] {
  display: block !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  scrollbar-width: thin;
}
[data-dsr-workspace-root],
[data-dsr-workspace-body] {
  flex: none !important;
  min-height: auto !important;
  height: auto !important;
  overflow: visible !important;
}
[data-dsr-workspace-tree] {
  flex: none !important;
  overflow: visible !important;
  padding-bottom: 4px !important;
}
[data-dsr-workspace-body] [class*="_fade"] {
  display: none !important;
}
[data-dsr-workspace-body][data-dsr-section-collapsed] {
  display: none !important;
}
[data-dsr-pin-container] {
  display: flex !important;
  flex-direction: column !important;
  row-gap: 4px;
}
[data-dsr-pin-container] > [data-dsr-pin-group] {
  order: var(--dsr-pin-order);
  flex: none;
  margin-top: 0 !important;
}
.dsr-lower {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 100%;
  min-width: 0;
  min-height: 0;
  padding: 0 var(--dsh-sidebar-inline-padding, 12px) 4px 4px;
  box-sizing: border-box;
}
.dsr-workspace-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px 4px;
  margin: 0 0 2px;
  flex: none;
}
.dsr-workspace-pager button,
.dsr-recents-action {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, #171717);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 6px;
  border-radius: var(--dsw-radius-sm, 6px);
  text-align: left;
}
.dsr-workspace-pager button:hover,
.dsr-recents-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsr-workspace-pager button:focus-visible,
.dsr-recents-action:focus-visible,
.dsr-recent-row:focus-visible,
.dsr-pin-button:focus-visible,
.dsr-collapse-all:focus-visible,
.dsr-section-toggle:focus-visible,
[data-dsr-section-toggle]:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsr-collapse-all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsr-collapse-all:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsr-collapse-all svg {
  width: 15px;
  height: 15px;
}
.dsr-recents {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 100%;
  min-width: 0;
  margin-top: 0;
  padding: 4px 0 0;
  border-top: 1px solid var(--dsw-alias-separator-secondary, rgba(127, 127, 127, 0.18));
  box-sizing: border-box;
}
.dsr-recents-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 36px;
  padding: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 18px;
  letter-spacing: 0.02em;
}
.dsr-section-toggle,
[data-dsr-section-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 4px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.dsr-section-toggle:hover,
[data-dsr-section-toggle]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsr-section-toggle::after,
[data-dsr-section-toggle]::after {
  content: '';
  flex: none;
  width: 5px;
  height: 5px;
  margin: -3px 3px 0 2px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
.dsr-section-toggle[aria-expanded='false']::after,
[data-dsr-section-toggle][aria-expanded='false']::after {
  transform: rotate(-45deg);
  margin-top: 0;
}
.dsr-recents-count {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsr-recents-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: visible;
}
.dsr-recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  width: 0;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dsr-recent-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  border-radius: var(--dsw-radius-md, 8px);
}
.dsr-recent-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsr-workspace-pin {
  display: inline-flex;
  flex: none;
  width: 24px;
  height: 24px;
  margin-inline: 1px;
}
.dsr-pin-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  opacity: 0;
}
.dsr-pin-button svg { width: 15px; height: 15px; }
.dsr-pin-button[aria-pressed='true'],
.dsr-pin-button:focus-visible,
.dsr-pin-button:disabled,
.dsr-recent-item:hover .dsr-pin-button,
.dsr-recent-item:focus-within .dsr-pin-button,
[data-row-key]:hover > [data-dsr-workspace-pin] .dsr-pin-button,
[data-row-key]:focus-within > [data-dsr-workspace-pin] .dsr-pin-button {
  opacity: 1;
}
.dsr-pin-button[aria-pressed='true'] { color: var(--dsw-alias-label-primary); }
.dsr-pin-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsr-pin-button:disabled { cursor: wait; }
@media (hover: none) { .dsr-pin-button { opacity: 1; } }
.dsr-pin-error {
  padding: 4px 8px;
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
  font-size: 12px;
}
.dsr-recent-main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.dsr-activity,
.dsr-workspace-activity {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
}
.dsr-workspace-activity {
  margin: 0 4px;
}
.dsr-recent-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsr-recent-workspace {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 13px;
}
.dsr-recents-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 2px 2px 4px;
}
.dsr-recents-empty {
  padding: 6px 8px 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
`;
function injectStyles() {
  if (typeof document === "undefined") return () => {
  };
  let style = document.querySelector(`style[${STYLE_ATTRIBUTE}]`);
  if (style === null) {
    style = document.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    style.setAttribute("data-plugin", "dsh-sidebar-recents");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
  return () => {
    style?.remove();
  };
}

// src/client/index.js
var import_dsh_client_store = require("@deepseek-ai/dsh-client-store");
var inject = ["slots", "sessions", "workspaces", "uiWorkspace", "uiSession"];
function apply(ctx) {
  const disposeStyles = injectStyles();
  const chrome = createWorkspaceChrome(ctx);
  const workspacePins = createWorkspacePinStore(import_dsh_client_store.createSnapshotStore);
  ctx.effect(
    () => () => {
      chrome.dispose();
      disposeStyles();
    },
    "sidebar-recents: styles and chrome"
  );
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "sidebar-recents",
        order: 20
      },
      (props) => import_react4.default.createElement(RecentsPanel, { ...props, ctx, chrome, workspacePins })
    )
  );
}

return module.exports;}});
