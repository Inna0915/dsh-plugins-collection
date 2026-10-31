/**
 * Workspace grouping helpers.
 *
 * Native ui-workspace 0.2.1-rc.3 stores expansion per group key in
 * `dsh.workspace.view.v5`. A Workspace group key is its `workspaceId`; the
 * synthetic Ungrouped group uses the empty string. Tree mode nests Workspaces
 * by filesystem path but keeps one key per Workspace, so collapsing every key
 * also collapses descendants that are not currently rendered.
 */

/** Every expansion key the native browser can persist, including Ungrouped. */
export function workspaceGroupKeys(workspacesSnapshot) {
  const keys = new Set();
  keys.add('');
  for (const workspace of workspacesSnapshot?.items ?? []) {
    if (typeof workspace?.workspaceId === 'string' && workspace.workspaceId !== '') {
      keys.add(workspace.workspaceId);
    }
  }
  return [...keys];
}
