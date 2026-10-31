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

export const inject = ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiSession'];
export function apply(ctx: any) {
  const open = () => openWorkspaceBoard(ctx, flushSync);
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
      (props: { wide?: boolean }) => (
        <button
          title="任务看板"
          aria-label="打开任务看板"
          onClick={() => ctx.layout.selectPanel('jira-flow')}
          style={{
            width: '100%',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            padding: '9px 10px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          <span style={{ fontWeight: 700, marginRight: props.wide ? 8 : 0 }}>▦</span>
          {props.wide ? '任务看板' : ''}
        </button>
      ),
    ),
  );
}
