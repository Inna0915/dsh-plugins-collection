export const WORKSPACE_PIN_STORAGE = 'dsh-sidebar-recents.workspace-pins.v1';

/** New pins lead; removing a pin leaves the other pins in their original order. */
export function togglePinnedId(ids, id) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [id, ...ids];
}

/** Stable pin-first projection; never change the host's underlying order. */
export function orderPinned(items, pinnedIds, keyOf) {
  const ranks = new Map(pinnedIds.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index, rank: ranks.get(keyOf(item)) ?? Infinity }))
    .sort((left, right) => left.rank === right.rank ? left.index - right.index : left.rank - right.rank)
    .map(({ item }) => item);
}

/** Use DSH's persistent snapshot store, the same mechanism as native view state. */
export function createWorkspacePinStore(createStore) {
  const source = createStore({ ids: [] }, { persist: { name: WORKSPACE_PIN_STORAGE } });
  return {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => source.subscribe(listener),
    toggle(id) {
      source.set({ ids: togglePinnedId(source.getSnapshot().ids, id) });
    },
  };
}

/** Keep recents and the native session-menu pin command on the same account. */
export async function toggleSessionPin(ctx, id) {
  const service = ctx.get('uiWorkspace');
  const pinned = ctx.get('workspaces').list.getSnapshot().pinnedSessionIds?.includes(id) === true;
  await service[pinned ? 'unpinSession' : 'pinSession'](id);
}
