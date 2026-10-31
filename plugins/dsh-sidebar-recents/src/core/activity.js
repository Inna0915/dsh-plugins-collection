const WAITING_LABELS = {
  approval: '等待审批',
  'plan-review': '等待计划确认',
  question: '等待回答',
};

/** Use the same live-status precedence and child catalog as native session rows. */
export function buildSessionActivity(list, statuses, archivedSessionIds = []) {
  const activity = new Map();
  const archived = new Set(archivedSessionIds);
  const byId = list?.byId ?? {};
  for (const id of list?.ids ?? Object.keys(byId)) {
    const session = byId[id];
    if (!session || session.origin === 'subagent' || archived.has(id)) continue;
    const status = statuses?.get(id);
    const waiting = WAITING_LABELS[status?.pendingInteraction?.kind];
    if (waiting) {
      activity.set(id, { state: 'warning', label: waiting });
      continue;
    }
    const running = status?.running ?? session.running;
    const children = list?.projectionsBySession?.[id]?.values?.subagentCatalog ?? [];
    const runningChildren = children.filter((child) =>
      (statuses?.get(child.id)?.running ?? byId[child.id]?.running) === true,
    ).length;
    if (running === true || runningChildren > 0) {
      activity.set(id, {
        state: 'ongoing',
        label: runningChildren > 0 ? `执行中（${runningChildren} 个子任务执行中）` : '执行中',
      });
    }
  }
  return activity;
}

// Match native folderPath: Windows separators, trailing slash removal and
// case-sensitive host spelling. A path prefix alone is not a parent folder.
function folderPath(path) {
  if (typeof path !== 'string' || path === '') return null;
  return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
    ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '');
}

/** Cache membership/ancestor relationships until workspace metadata changes. */
export function buildWorkspaceActivityIndex(workspaces) {
  const groups = (workspaces?.items ?? []).filter((item) => typeof item?.workspaceId === 'string');
  const paths = new Map(groups.map((item) => [item.workspaceId, folderPath(item.path)]));
  const memberships = new Map();
  for (const group of groups) {
    const ownPath = paths.get(group.workspaceId);
    const keys = new Set([group.workspaceId]);
    if (ownPath !== null) {
      for (const [key, parentPath] of paths) {
        if (parentPath !== null && ownPath !== parentPath && ownPath.startsWith(`${parentPath}/`)) keys.add(key);
      }
    }
    for (const id of group.sessionIds ?? []) {
      if (!memberships.has(id)) memberships.set(id, new Set());
      for (const key of keys) memberships.get(id).add(key);
    }
  }
  return memberships;
}

/** One root session contributes once to each folder, even with shared membership. */
export function buildWorkspaceActivity(sessionActivity, memberships) {
  const groups = new Map();
  for (const [id, activity] of sessionActivity) {
    for (const key of memberships.get(id) ?? ['']) {
      if (!groups.has(key)) groups.set(key, { running: 0, waiting: 0 });
      const group = groups.get(key);
      if (activity.state === 'ongoing') group.running += 1;
      else group.waiting += 1;
    }
  }
  return new Map([...groups].map(([key, { running, waiting }]) => [key, {
    state: running > 0 ? 'ongoing' : 'warning',
    label: [running > 0 ? `${running} 个会话执行中` : '', waiting > 0 ? `${waiting} 个会话等待处理` : ''].filter(Boolean).join('，'),
  }]));
}
