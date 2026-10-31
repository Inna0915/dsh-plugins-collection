/**
 * Recents projection and pagination.
 *
 * Host contract verified against Desktop 0.2.1-rc.3:
 * - `ClientSessions.list` summaries carry `updatedAt`, computed by
 *   `@deepseek-ai/dsh-api-session-controller/lib/types/list.js` as
 *   `max(header.createdAt, sessionListMetadata.lastPromptAt)`.
 * - `lastPromptAt` advances only for `user/message` with `source.kind === "user"`;
 *   assistant stream tokens do not participate.
 * - `workspaces.list` carries `archivedSessionIds`; native visibility excludes
 *   `origin === "subagent"`, archived rows, and blank rows.
 *
 * Native pinned identities lead in pin order; other rows keep host recency.
 * Opening, file mtime, and read time do not reorder either group.
 */

export const RECENT_PAGE_SIZE = 5;

const FALLBACK_TITLE = '未命名会话';
const UNGROUPED_LABEL = '未分组';

/** Basename of a workspace path, accepting both Windows and POSIX separators. */
export function workspaceLabelOf(path) {
  if (typeof path !== 'string') return undefined;
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed === '') return undefined;
  const parts = trimmed.split(/[\\/]+/);
  const name = parts[parts.length - 1];
  return name === '' ? undefined : name;
}

/**
 * Build the recent-session rows from the host catalog.
 *
 * @param {{ ids?: string[], byId?: Record<string, any> } | undefined} sessionsSnapshot
 * @param {{ items?: any[], archivedSessionIds?: string[], pinnedSessionIds?: string[] } | undefined} workspacesSnapshot
 * @param {{ pageSize?: number, panelActive?: boolean }} [options]
 * @returns {Array<{
 *   sessionId: string,
 *   title: string,
 *   workspaceLabel: string,
 *   updatedAt: number,
 *   current: boolean,
 *   pinned: boolean,
 *   showWorkspaceHint: boolean,
 * }>}
 */
export function buildRecents(sessionsSnapshot, workspacesSnapshot, options = {}) {
  const list = sessionsSnapshot ?? {};
  const byId = list.byId ?? {};
  const ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId);
  const workspaces = Array.isArray(workspacesSnapshot?.items) ? workspacesSnapshot.items : [];
  const panelActive = options.panelActive === true;
  const pinRanks = new Map((workspacesSnapshot?.pinnedSessionIds ?? []).map((id, index) => [id, index]));
  const archived = new Set(
    Array.isArray(workspacesSnapshot?.archivedSessionIds)
      ? workspacesSnapshot.archivedSessionIds
      : [],
  );

  const workspaceLabelBySession = new Map();
  const workspaceIdBySession = new Map();
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.workspaceId !== 'string') continue;
    const label =
      (typeof workspace.title === 'string' && workspace.title.trim() !== ''
        ? workspace.title.trim()
        : workspaceLabelOf(workspace.path)) ?? UNGROUPED_LABEL;
    for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (!workspaceLabelBySession.has(sessionId)) {
        workspaceLabelBySession.set(sessionId, label);
        workspaceIdBySession.set(sessionId, workspace.workspaceId);
      }
    }
  }

  const seen = new Set();
  const rows = [];
  for (let index = 0; index < ids.length; index += 1) {
    const sessionId = ids[index];
    if (typeof sessionId !== 'string' || seen.has(sessionId)) continue;
    seen.add(sessionId);

    const summary = byId[sessionId];
    if (summary === undefined || summary === null) continue;
    if (summary.blank === true) continue;
    if (archived.has(sessionId)) continue;
    if (summary.origin === 'subagent') continue;

    const rawTitle =
      typeof summary.displayTitle === 'string' && summary.displayTitle.trim() !== ''
        ? summary.displayTitle
        : typeof summary.title === 'string'
          ? summary.title
          : '';
    const title = rawTitle.trim() === '' ? FALLBACK_TITLE : rawTitle.trim();
    const workspaceLabel =
      workspaceLabelBySession.get(sessionId) ??
      workspaceLabelOf(summary.cwd) ??
      UNGROUPED_LABEL;
    const workspaceId = workspaceIdBySession.get(sessionId);
    const updatedAt = Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0;

    rows.push({
      sessionId,
      title,
      workspaceLabel,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      updatedAt,
      current: !panelActive && (summary.retainedBy?.mainView ?? 0) > 0,
      pinned: pinRanks.has(sessionId),
      originalIndex: index,
    });
  }

  // Explicit pins lead; ordinary recency and its tie order are unchanged.
  rows.sort((left, right) => {
    const leftPin = pinRanks.get(left.sessionId) ?? Infinity;
    const rightPin = pinRanks.get(right.sessionId) ?? Infinity;
    if (leftPin !== rightPin) return leftPin - rightPin;
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return left.originalIndex - right.originalIndex;
  });

  const titleCounts = new Map();
  for (const row of rows) titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);

  return rows.map(({ originalIndex: _originalIndex, ...row }) => ({
    ...row,
    showWorkspaceHint: (titleCounts.get(row.title) ?? 0) > 1,
  }));
}

/** Rows visible for one pagination step. */
export function visibleRecents(items, visibleCount, pageSize = RECENT_PAGE_SIZE) {
  const limit = Number.isFinite(visibleCount) && visibleCount > 0 ? Math.floor(visibleCount) : pageSize;
  return items.slice(0, limit);
}

/** The next page boundary after "show more"; never past the total. */
export function nextVisibleCount(visibleCount, total, pageSize = RECENT_PAGE_SIZE) {
  const current = Number.isFinite(visibleCount) ? Math.max(pageSize, Math.floor(visibleCount)) : pageSize;
  return Math.min(Math.max(total, 0), current + pageSize);
}

/** Clamp a previously expanded boundary to the current data set without dropping below one page. */
export function effectiveVisibleCount(visibleCount, total, pageSize = RECENT_PAGE_SIZE) {
  const requested = Number.isFinite(visibleCount) ? Math.max(pageSize, Math.floor(visibleCount)) : pageSize;
  if (total <= pageSize) return total;
  return Math.min(requested, total);
}

/** True when the current dataset has rows beyond the visible page. */
export function hasMoreRecents(visibleCount, total) {
  return total > visibleCount;
}

/** True after the user expanded beyond the default page and the dataset still offers room. */
export function canCollapseRecents(visibleCount, pageSize = RECENT_PAGE_SIZE) {
  return visibleCount > pageSize;
}
