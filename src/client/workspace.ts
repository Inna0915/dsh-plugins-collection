export const BOARD_TAB_ID = "dsh-confluence-flow/documents";
export const BOARD_TAB_KIND = "confluence-flow-documents";

export interface Snapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
export interface WorkspaceHost {
  layout: { selectPanel(id: string | null): void };
  uiSession: { adapter: { current: Snapshot<{ key?: string }> } };
  sidebarRight: {
    mounted: Snapshot<string | undefined>;
    openTabs: Snapshot<
      Array<{ sessionId: string; tabId: string; kind: string }>
    >;
    openTab(kind: string, options?: { preferNewPane?: boolean }): void;
    focus(tabId: string): void;
    isExpanded(): boolean;
    toggleExpanded(): void;
  };
}

// Use the host's own tab inventory and navigation so reopening the board
// reveals its existing pane, including a pane restored after a reload.
export function openWorkspaceBoard(
  host: WorkspaceHost,
  commit: (action: () => void) => void,
) {
  if (!host.uiSession.adapter.current.getSnapshot().key) {
    throw new Error("请先在工作区打开一个会话，再打开Confluence 文档分栏。");
  }
  commit(() => host.layout.selectPanel(null));
  const sessionId = host.sidebarRight.mounted.getSnapshot();
  if (!sessionId) throw new Error("会话工作区尚未就绪，请稍后重试。");
  const existing = host.sidebarRight.openTabs
    .getSnapshot()
    .find((tab) => tab.sessionId === sessionId && tab.kind === BOARD_TAB_KIND);
  if (existing) {
    if (!host.sidebarRight.isExpanded()) host.sidebarRight.toggleExpanded();
    host.sidebarRight.focus(existing.tabId);
  } else {
    host.sidebarRight.openTab(BOARD_TAB_KIND, { preferNewPane: true });
  }
}
