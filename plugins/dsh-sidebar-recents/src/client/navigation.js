/**
 * Open an existing session through the host's own navigation service.
 *
 * Never creates a session and never assembles a route: ui-workspace's
 * `openSession(id)` calls `replaceMain(id, ..., "reveal")`, selecting the
 * conversation panel and retaining the exact id.
 *
 * @returns {boolean} whether the host navigation service accepted the call
 */
export function openRecentSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  const uiWorkspace = ctx.get('uiWorkspace');
  if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
    console.warn('sidebar-recents: uiWorkspace.openSession is unavailable');
    return false;
  }
  try {
    uiWorkspace.openSession(sessionId);
    return true;
  } catch (error) {
    console.warn('sidebar-recents: failed to open session', error);
    return false;
  }
}
