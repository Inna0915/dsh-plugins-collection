import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import {
  RECENT_PAGE_SIZE,
  buildRecents,
  canCollapseRecents,
  effectiveVisibleCount,
  hasMoreRecents,
  nextVisibleCount,
} from '../core/recents.js';
import { openRecentSession } from './navigation.js';
import { buildSessionActivity, buildWorkspaceActivityIndex, buildWorkspaceActivity } from '../core/activity.js';
import { ActivityIndicator } from './activity-indicator.js';
import { PinButton } from './pin-button.js';
import { toggleSessionPin } from '../core/pins.js';

const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_SESSIONS = Object.freeze({ ids: [], byId: {} });
const EMPTY_WORKSPACES = Object.freeze({ items: [], archivedSessionIds: [] });
const EMPTY_STATUS = new Map();
const EMPTY_PINS = Object.freeze({ ids: [] });
const EMPTY_CHROME = Object.freeze({
  total: 0,
  limit: RECENT_PAGE_SIZE,
  searchActive: false,
  collapsed: false,
  available: false,
  portalHost: null,
  activityTargets: [],
  pinTargets: [],
});
const getEmptySessions = () => EMPTY_SESSIONS;
const getEmptyWorkspaces = () => EMPTY_WORKSPACES;
const getEmptyChrome = () => EMPTY_CHROME;
const getEmptyStatus = () => EMPTY_STATUS;
const getEmptyPins = () => EMPTY_PINS;

function useStoreSnapshot(store, fallback) {
  const source = useMemo(
    () => store ? {
      subscribe: (listener) => store.subscribe(listener),
      getSnapshot: () => store.getSnapshot(),
    } : { subscribe: NOOP_SUBSCRIBE, getSnapshot: fallback },
    [store, fallback],
  );
  return useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
}

function useChromeSnapshot(chrome) {
  return useSyncExternalStore(
    chrome?.subscribe ?? NOOP_SUBSCRIBE,
    chrome?.getSnapshot ?? getEmptyChrome,
    chrome?.getSnapshot ?? getEmptyChrome,
  );
}

/**
 * Sidebar action entry. The footer action is only the lifecycle entry; its
 * visible content portals into the `.dsr-lower` sibling created immediately
 * below the native workspace browser.
 */
export function RecentsPanel({ wide, ctx, chrome, workspacePins, usePanelInfo }) {
  if (wide === false) return null;
  const sessions = ctx.get('sessions');
  const workspaces = ctx.get('workspaces');
  if (sessions?.list === undefined || workspaces?.list === undefined) return null;
  if (typeof usePanelInfo === 'function') {
    return (
      <RecentsPanelWithPanelInfo
        ctx={ctx}
        chrome={chrome}
        workspacePins={workspacePins}
        usePanelInfo={usePanelInfo}
        sessionStore={sessions.list}
        workspaceStore={workspaces.list}
      />
    );
  }
  return (
    <RecentsPanelConnected
      ctx={ctx}
      chrome={chrome}
      workspacePins={workspacePins}
      panelActive={false}
      sessionStore={sessions.list}
      workspaceStore={workspaces.list}
    />
  );
}

function RecentsPanelWithPanelInfo({ ctx, chrome, workspacePins, usePanelInfo, sessionStore, workspaceStore }) {
  const panelActive = usePanelInfo((info) => info?.activePanelId !== null);
  return (
    <RecentsPanelConnected
      ctx={ctx}
      chrome={chrome}
      workspacePins={workspacePins}
      panelActive={panelActive === true}
      sessionStore={sessionStore}
      workspaceStore={workspaceStore}
    />
  );
}

function RecentsPanelConnected({
  ctx,
  chrome,
  workspacePins,
  panelActive,
  sessionStore,
  workspaceStore,
}) {
  const sessionsSnapshot = useStoreSnapshot(sessionStore, getEmptySessions);
  const workspacesSnapshot = useStoreSnapshot(workspaceStore, getEmptyWorkspaces);
  const statusSnapshot = useStoreSnapshot(ctx.get('uiSession')?.sessionStatus, getEmptyStatus);
  const pinSnapshot = useStoreSnapshot(workspacePins, getEmptyPins);
  const pinnedWorkspaces = useMemo(() => new Set(pinSnapshot.ids), [pinSnapshot]);
  const chromeState = useChromeSnapshot(chrome);
  const [visibleCount, setVisibleCount] = useState(RECENT_PAGE_SIZE);
  const [collapsed, setCollapsed] = useState(false);
  const [pinError, setPinError] = useState('');
  const portalHost = chromeState.portalHost;
  const rowRefs = useRef([]);

  // The adapter publishes the portal target with its snapshot, including
  // replacement targets after native workspace remounts.
  useEffect(() => {
    chrome.attach();
    return () => chrome.detach();
  }, [chrome]);

  useEffect(() => {
    chrome.setWorkspacePins(pinSnapshot.ids, workspacesSnapshot.items);
  }, [chrome, pinSnapshot, workspacesSnapshot]);

  const items = useMemo(
    () => buildRecents(sessionsSnapshot, workspacesSnapshot, { panelActive }),
    [sessionsSnapshot, workspacesSnapshot, panelActive],
  );
  const sessionActivity = useMemo(
    () => buildSessionActivity(sessionsSnapshot, statusSnapshot, workspacesSnapshot.archivedSessionIds),
    [sessionsSnapshot, statusSnapshot, workspacesSnapshot.archivedSessionIds],
  );
  const workspaceActivityIndex = useMemo(
    () => buildWorkspaceActivityIndex(workspacesSnapshot),
    [workspacesSnapshot],
  );
  const workspaceActivity = useMemo(
    () => buildWorkspaceActivity(sessionActivity, workspaceActivityIndex),
    [sessionActivity, workspaceActivityIndex],
  );
  useEffect(() => {
    chrome.setWorkspaceActivity(workspaceActivity);
  }, [chrome, workspaceActivity]);
  const effectiveCount = effectiveVisibleCount(visibleCount, items.length);
  const rows = items.slice(0, effectiveCount);
  const showMore = hasMoreRecents(effectiveCount, items.length);
  const showCollapseRecents = canCollapseRecents(effectiveCount) && items.length > RECENT_PAGE_SIZE;
  const remaining = Math.max(0, items.length - effectiveCount);
  const showWorkspaceMore =
    chromeState.available &&
    !chromeState.collapsed &&
    !chromeState.searchActive &&
    chromeState.total > chromeState.limit;
  const showWorkspaceCollapse =
    chromeState.available &&
    !chromeState.collapsed &&
    !chromeState.searchActive &&
    chromeState.limit > RECENT_PAGE_SIZE &&
    chromeState.total > RECENT_PAGE_SIZE;
  const workspaceRemaining = Math.max(0, chromeState.total - chromeState.limit);
  rowRefs.current.length = rows.length;

  const open = (sessionId) => {
    openRecentSession(ctx, sessionId);
  };

  const onListKeyDown = (event) => {
    const buttons = rowRefs.current.filter(
      (button) => button instanceof HTMLButtonElement && button.isConnected,
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };

  const pager =
    showWorkspaceMore || showWorkspaceCollapse ? (
      <div className="dsr-workspace-pager" data-dsr-workspace-pager="">
        {showWorkspaceMore ? (
          <button
            type="button"
            onClick={() => chrome.setLimit(chromeState.limit + RECENT_PAGE_SIZE)}
            aria-expanded="false"
          >
            展开更多（剩余 {workspaceRemaining} 个）
          </button>
        ) : null}
        {showWorkspaceCollapse ? (
          <button
            type="button"
            onClick={() => chrome.collapseList()}
            aria-expanded="true"
          >
            收起
          </button>
        ) : null}
      </div>
    ) : null;

  const content = (
    <>
      {pager}
      {pinError ? <div className="dsr-pin-error" role="alert">{pinError}</div> : null}
    <section className="dsr-recents" aria-label="最近会话" data-dsr-recents="">
      <div className="dsr-recents-header">
        <button
          type="button"
          className="dsr-section-toggle"
          aria-label={collapsed ? '展开最近' : '收起最近'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span>最近</span>
          {items.length > 0 ? <span className="dsr-recents-count">({items.length})</span> : null}
        </button>
      </div>
      {!collapsed ? <>
      {rows.length === 0 ? (
        <div className="dsr-recents-empty">暂无最近会话</div>
      ) : (
        <div
          className="dsr-recents-list"
          role="list"
          aria-label="最近会话"
          onKeyDown={onListKeyDown}
          data-dsr-recents-list=""
        >
          {rows.map((row, index) => {
            const activity = sessionActivity.get(row.sessionId);
            return (
            <div key={row.sessionId} className="dsr-recent-item" role="listitem">
            <button
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              type="button"
              aria-current={row.current ? 'page' : undefined}
              aria-label={[row.title, row.pinned ? '已置顶' : '', row.showWorkspaceHint ? row.workspaceLabel : '', activity?.label].filter(Boolean).join('，')}
              title={[row.title, row.workspaceLabel, activity?.label].filter(Boolean).join('\n')}
              className="dsr-recent-row"
              data-dsr-session-id={row.sessionId}
              onClick={() => open(row.sessionId)}
            >
              <ActivityIndicator activity={activity} />
              <span className="dsr-recent-main">
                <span className="dsr-recent-title">{row.title}</span>
                {row.showWorkspaceHint ? (
                  <span className="dsr-recent-workspace">{row.workspaceLabel}</span>
                ) : null}
              </span>
            </button>
            <PinButton
              pinned={row.pinned}
              name={`会话“${row.title}”`}
              onToggle={() => toggleSessionPin(ctx, row.sessionId)}
              onError={setPinError}
            />
            </div>
            );
          })}
        </div>
      )}
      {showMore || showCollapseRecents ? (
        <div className="dsr-recents-actions">
          {showMore ? (
            <button
              type="button"
              className="dsr-recents-action"
              onClick={() => setVisibleCount(nextVisibleCount(effectiveCount, items.length))}
              aria-expanded="false"
            >
              展开更多（剩余 {remaining} 个）
            </button>
          ) : null}
          {showCollapseRecents ? (
            <button
              type="button"
              className="dsr-recents-action"
              onClick={() => setVisibleCount(RECENT_PAGE_SIZE)}
              aria-expanded="true"
            >
              收起
            </button>
          ) : null}
        </div>
      ) : null}
      </> : null}
    </section>
    </>
  );

  if (portalHost === null) return null;
  return <>
    {createPortal(content, portalHost)}
    {chromeState.activityTargets.map(({ key, host, activity }) => createPortal(
      <ActivityIndicator activity={activity} />, host, key,
    ))}
    {chromeState.pinTargets.map(({ key, host, name }) => createPortal(
      <PinButton
        pinned={pinnedWorkspaces.has(key)}
        name={`工作区“${name}”`}
        onToggle={() => workspacePins.toggle(key)}
        onError={setPinError}
      />, host, `pin:${key}`,
    ))}
  </>;
}
