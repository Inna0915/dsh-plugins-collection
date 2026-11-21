import React, { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { App } from './App.js';
import { BOARD_TAB_ID, BOARD_TAB_KIND, openWorkspaceBoard } from './workspace.js';
import { captureCurrentComposer } from './composer.js';

interface TabProps {
  sessionId: string;
  useTabInfo(): {
    tab: {
      visible: boolean;
      actions: { bindCommands(commands: { refresh: () => void }): () => void };
    };
  };
}

function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1M5.5 12h1M11.5 12h1" />
    </svg>
  );
}

// Left-sidebar entry: shared/sidebar.css (synced by scripts/sync-sidebar-style.mjs; edit there, not here).
const SIDEBAR_CSS = /* @sidebar-style */ ":root{--dshx-label-inset: 10px;--dshx-row-inset: 12px;--dshx-footer-inset: 2px;--dshx-icon-box: 18px;--dshx-icon-gap: 10px;--dshx-row-height: 38px;--dshx-rail-size: 36px}[data-slot=\"sidebar.footer.action\"]:has(> .dshx-entry){display: flex !important;flex-direction: column;align-items: stretch;gap: 3px;width: 100%;min-width: 0}.dshx-entry{box-sizing: border-box;display: flex;align-items: center;gap: var(--dshx-icon-gap);width: 100%;min-width: 0;min-height: var(--dshx-row-height);margin: 0;padding: 0 calc(var(--dshx-row-inset) - var(--dshx-footer-inset));border: 0;border-radius: var(--dsw-radius-lg, 16px);background: transparent;color: var(--ink-2, var(--dsw-alias-label-secondary));font: inherit;font-size: var(--fs-strong, 14px);font-weight: 500;line-height: 22px;text-align: left;cursor: pointer;transition: background-color .14s ease, color .14s ease}.dshx-entry:hover{background: var(--hover, var(--dsw-alias-interactive-bg-hover));color: var(--ink, var(--dsw-alias-label-primary))}.dshx-entry:active{transform: translateY(1px)}.dshx-entry:focus-visible{outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));outline-offset: -2px}.dshx-entry[aria-current=\"page\"]{background: var(--accent-tint, var(--dsw-alias-interactive-bg-hover));color: var(--primary, var(--dsw-alias-state-business-primary, currentColor))}.dshx-entry-icon{display: inline-flex;flex: none;align-items: center;justify-content: center;width: var(--dshx-icon-box);height: var(--dshx-icon-box)}.dshx-entry-icon svg{width: 16px;height: 16px}.dshx-entry-label{min-width: 0;overflow: hidden;text-overflow: ellipsis;white-space: nowrap}.dshx-entry.dshx-rail{width: var(--dshx-rail-size);height: var(--dshx-rail-size);min-height: var(--dshx-rail-size);padding: 0;justify-content: center;align-self: center}" /* @sidebar-style-end */;

/** Footer entry: highlighted while the board is the open main panel, like the host navigation rows. */
function SidebarEntry({ wide, usePanelInfo, onOpen }: { wide?: boolean; usePanelInfo?: (pick: (info: any) => boolean) => boolean; onOpen(): void }) {
  const active = typeof usePanelInfo === 'function' ? usePanelInfo((info) => info?.activePanelId === 'jira-flow') : false;
  return (
    <button
      type="button"
      className={wide ? 'dshx-entry' : 'dshx-entry dshx-rail'}
      title={wide ? undefined : '任务看板'}
      aria-label="打开任务看板"
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
    >
      <span className="dshx-entry-icon">
        <BoardIcon />
      </span>
      {wide ? <span className="dshx-entry-label">任务看板</span> : null}
    </button>
  );
}

export const inject = ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiSession'];
export function apply(ctx: any) {
  const open = () => openWorkspaceBoard(ctx, flushSync);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.dshxSidebar = 'jira-flow';
    style.textContent = SIDEBAR_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'jira-flow: sidebar entry style');
  function FullPage() {
    return <App onOpenWorkspace={open} captureComposer={() => captureCurrentComposer(ctx)} />;
  }
  function WorkspaceBoard({ useTabInfo, sessionId }: TabProps) {
    const { tab } = useTabInfo();
    const bindRefresh = useCallback(
      (refresh: () => void) => tab.actions.bindCommands({ refresh }),
      [tab.actions],
    );
    return (
      <div className="jf-workspace-board">
        <App
          workspacePane
          active={tab.visible}
          bindRefresh={bindRefresh}
          captureComposer={() => captureCurrentComposer(ctx, sessionId)}
          onOpenFullPage={() => ctx.layout.selectPanel('jira-flow')}
        />
      </div>
    );
  }
  function WorkspaceButton() {
    const [error, setError] = useState('');
    return (
      <button
        aria-label="在工作区打开任务看板"
        title={error || '在工作区打开任务看板'}
        onClick={() => {
          try {
            open();
            setError('');
          } catch (error) {
            setError(error instanceof Error ? error.message : '无法打开任务看板');
          }
        }}
        style={{
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          padding: 6,
          width: 30,
          height: 30,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <BoardIcon />
      </button>
    );
  }
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: BOARD_TAB_ID,
        kind: BOARD_TAB_KIND,
        title: () => '任务看板',
        keepMounted: true,
        guide: [
          {
            id: 'kanban',
            order: 35,
            title: () => '任务看板',
            description: () => 'Jira Story 与 Bug，可与会话、文件和终端分栏显示',
            icon: BoardIcon,
          },
        ],
      }),
    'jira-flow: workspace tab type',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: BOARD_TAB_ID }, WorkspaceBoard),
      ),
    'jira-flow: workspace tab body',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'jira-flow-workspace-entry', order: 35 },
          WorkspaceButton,
        ),
      ),
    'jira-flow: conversation entry',
  );
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: 'jira-flow', id: 'jira-flow', label: '任务看板', order: 35 },
      FullPage,
    ),
  );
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'jira-flow-entry', order: 35 },
      (props: { wide?: boolean; usePanelInfo?: (pick: (info: any) => boolean) => boolean }) => (
        <SidebarEntry {...props} onOpen={() => ctx.layout.selectPanel('jira-flow')} />
      ),
    ),
  );
}
