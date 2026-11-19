/**
 * Reversible compatibility shim for third-party workspace owners (such as
 * `@iroha1145/dsh-modern-ui <= 0.1.22`) that replace `@deepseek-ai/dsh-client-ui-workspace`
 * on DSH 0.2.2-rc.3+ without declaring the `workspace.picker` factory and its
 * `workspace.picker.directoryFlow` child slot.
 *
 * Official `dsh-client-ui-directory-picker-native` and `-browse` nest three
 * `ctx.slots.inject(...)` calls (`conversation.hero.workspace.directoryFlow`,
 * `sidebar.workspaces.directoryFlow`, `workspace.picker.directoryFlow`) before
 * registering into any of them. When the third hole is missing, directory
 * pickers stay blocked and the sidebar/hero "Add workspace" entries disappear.
 *
 * This shim stays inert whenever `workspace.picker.directoryFlow` is already
 * declared (official `ui-workspace` or a future fixed third-party owner) and
 * disposes cleanly when either workspace slot or this plugin unloads.
 */
export const SIDEBAR_FLOW_SLOT = 'sidebar.workspaces.directoryFlow';
export const HERO_FLOW_SLOT = 'conversation.hero.workspace.directoryFlow';
export const PICKER_FACTORY_NAME = 'workspace.picker';
export const PICKER_FLOW_SLOT = 'workspace.picker.directoryFlow';

function WorkspacePickerCompatStub() {
  return null;
}

export function installDirectoryFlowCompat(ctx) {
  const slots = ctx?.slots;
  if (
    slots === undefined ||
    typeof slots.inject !== 'function' ||
    typeof slots.spec !== 'function' ||
    typeof slots.registerFactory !== 'function'
  ) {
    return () => {};
  }

  return slots.inject(SIDEBAR_FLOW_SLOT, () =>
    slots.inject(HERO_FLOW_SLOT, () => {
      let cancelled = false;
      let disposeFactory = null;

      // Yield one microtask so the active workspace owner finishes its
      // synchronous slot/factory declarations (official `ui-workspace` calls
      // `registerFactory('workspace.picker', ...)` right after registering
      // `sidebar.workspaces` and `conversation.hero.workspace`).
      queueMicrotask(() => {
        if (cancelled) return;
        if (slots.spec(SIDEBAR_FLOW_SLOT) === undefined) return;
        if (slots.spec(HERO_FLOW_SLOT) === undefined) return;
        if (slots.spec(PICKER_FLOW_SLOT) !== undefined) return;
        try {
          disposeFactory = slots.registerFactory(
            {
              name: PICKER_FACTORY_NAME,
              scope: 'root',
              children: {
                [PICKER_FLOW_SLOT]: { kind: 'single', scope: 'root' },
              },
            },
            WorkspacePickerCompatStub,
          );
        } catch (error) {
          console.warn('sidebar-recents: workspace.picker compat shim skipped:', error);
        }
      });

      return () => {
        cancelled = true;
        const dispose = disposeFactory;
        disposeFactory = null;
        dispose?.();
      };
    }),
  );
}
