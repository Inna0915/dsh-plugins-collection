import React from 'react';
import { createWorkspaceChrome } from './chrome.js';
import { RecentsPanel } from './recents-panel.js';
import { injectStyles } from './styles.js';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { createWorkspacePinStore } from '../core/pins.js';

/**
 * Client plugin body. `sidebar.workspaces` is a single official occupant, so
 * the recents section uses the additive `sidebar.footer.action` list and a
 * bounded chrome adapter instead of shadowing or reimplementing the official
 * browser.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession'];

export function apply(ctx) {
  const disposeStyles = injectStyles();
  const chrome = createWorkspaceChrome(ctx);
  const workspacePins = createWorkspacePinStore(createSnapshotStore);

  ctx.effect(
    () => () => {
      chrome.dispose();
      disposeStyles();
    },
    'sidebar-recents: styles and chrome',
  );

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'sidebar-recents',
        order: 20,
      },
      (props) => React.createElement(RecentsPanel, { ...props, ctx, chrome, workspacePins }),
    ),
  );
}
