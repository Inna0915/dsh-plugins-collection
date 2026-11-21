const STYLE_ATTRIBUTE = 'data-dsh-sidebar-recents';
const STYLE_ID = 'dsh-sidebar-recents/styles';

// Shared left-sidebar variables and entry styles: shared/sidebar.css
// (synced by scripts/sync-sidebar-style.mjs; edit there, not here).
const SIDEBAR_CSS = /* @sidebar-style */ ":root{--dshx-label-inset: 10px;--dshx-row-inset: 12px;--dshx-footer-inset: 2px;--dshx-icon-box: 18px;--dshx-icon-gap: 10px;--dshx-row-height: 38px;--dshx-rail-size: 36px}[data-slot=\"sidebar.footer.action\"]:has(> .dshx-entry){display: flex !important;flex-direction: column;align-items: stretch;gap: 3px;width: 100%;min-width: 0}.dshx-entry{box-sizing: border-box;display: flex;align-items: center;gap: var(--dshx-icon-gap);width: 100%;min-width: 0;min-height: var(--dshx-row-height);margin: 0;padding: 0 calc(var(--dshx-row-inset) - var(--dshx-footer-inset));border: 0;border-radius: var(--dsw-radius-lg, 16px);background: transparent;color: var(--ink-2, var(--dsw-alias-label-secondary));font: inherit;font-size: var(--fs-strong, 14px);font-weight: 500;line-height: 22px;text-align: left;cursor: pointer;transition: background-color .14s ease, color .14s ease}.dshx-entry:hover{background: var(--hover, var(--dsw-alias-interactive-bg-hover));color: var(--ink, var(--dsw-alias-label-primary))}.dshx-entry:active{transform: translateY(1px)}.dshx-entry:focus-visible{outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));outline-offset: -2px}.dshx-entry[aria-current=\"page\"]{background: var(--accent-tint, var(--dsw-alias-interactive-bg-hover));color: var(--primary, var(--dsw-alias-state-business-primary, currentColor))}.dshx-entry-icon{display: inline-flex;flex: none;align-items: center;justify-content: center;width: var(--dshx-icon-box);height: var(--dshx-icon-box)}.dshx-entry-icon svg{width: 16px;height: 16px}.dshx-entry-label{min-width: 0;overflow: hidden;text-overflow: ellipsis;white-space: nowrap}.dshx-entry.dshx-rail{width: var(--dshx-rail-size);height: var(--dshx-rail-size);min-height: var(--dshx-rail-size);padding: 0;justify-content: center;align-self: center}" /* @sidebar-style-end */;

const CSS = SIDEBAR_CSS + `
[data-slot="sidebar.workspaces"] [data-dsr-hidden] {
  display: none !important;
}
[data-dsr-region] {
  display: block !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  scrollbar-width: thin;
}
[data-dsr-workspace-root],
[data-dsr-workspace-body] {
  flex: none !important;
  min-height: auto !important;
  height: auto !important;
  overflow: visible !important;
}
[data-dsr-workspace-tree] {
  flex: none !important;
  overflow: visible !important;
  padding-bottom: 4px !important;
}
[data-dsr-workspace-body] [class*="_fade"] {
  display: none !important;
}
[data-dsr-workspace-body][data-dsr-section-collapsed] {
  display: none !important;
}
[data-dsr-pin-container] {
  display: flex !important;
  flex-direction: column !important;
  row-gap: 4px;
}
[data-dsr-pin-container] > [data-dsr-pin-group] {
  order: var(--dsr-pin-order);
  flex: none;
  margin-top: 0 !important;
}
.dsr-lower {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 100%;
  min-width: 0;
  min-height: 0;
  padding: 0 var(--dsh-sidebar-inline-padding, 12px) 4px 0;
  box-sizing: border-box;
}
.dsr-workspace-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px 4px calc(var(--dshx-row-inset) - 6px);
  margin: 0 0 2px;
  flex: none;
}
.dsr-workspace-pager button,
.dsr-recents-action {
  border: 0;
  background: transparent;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 6px;
  border-radius: var(--dsw-radius-sm, 8px);
  text-align: left;
  transition: background-color .14s ease, color .14s ease;
}
.dsr-workspace-pager button:hover,
.dsr-recents-action:hover {
  background: var(--hover, var(--dsw-alias-interactive-bg-hover));
  color: var(--ink, var(--dsw-alias-label-primary));
}
.dsr-workspace-pager button:focus-visible,
.dsr-recents-action:focus-visible,
.dsr-recent-row:focus-visible,
.dsr-pin-button:focus-visible,
.dsr-collapse-all:focus-visible,
.dsr-section-toggle:focus-visible,
[data-dsr-section-toggle]:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dsr-collapse-all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  cursor: pointer;
}
.dsr-collapse-all:hover {
  background: var(--hover, var(--dsw-alias-interactive-bg-hover));
  color: var(--ink, var(--dsw-alias-label-primary));
}
.dsr-collapse-all svg {
  width: 15px;
  height: 15px;
}
.dsr-recents {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 100%;
  min-width: 0;
  margin-top: 0;
  padding: 4px 0 0;
  border-top: 1px solid var(--line-soft, var(--dsw-alias-separator-secondary, rgba(127, 127, 127, 0.18)));
  box-sizing: border-box;
}
.dsr-recents-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 36px;
  padding: 0 0 0 var(--dshx-label-inset);
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  font-size: var(--fs-label, 12px);
  font-weight: 500;
  line-height: 18px;
  letter-spacing: .06em;
}
.dsr-section-toggle,
[data-dsr-section-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 4px;
  margin-left: -4px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  font: inherit;
  font-size: var(--fs-label, 12px);
  font-weight: 500;
  line-height: 18px;
  letter-spacing: .06em;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color .14s ease, color .14s ease;
}
.dsr-section-toggle:hover,
[data-dsr-section-toggle]:hover {
  background: var(--hover, var(--dsw-alias-interactive-bg-hover));
  color: var(--ink, var(--dsw-alias-label-primary));
}
.dsr-section-toggle::after,
[data-dsr-section-toggle]::after {
  content: '';
  flex: none;
  width: 5px;
  height: 5px;
  margin: -3px 3px 0 2px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
.dsr-section-toggle[aria-expanded='false']::after,
[data-dsr-section-toggle][aria-expanded='false']::after {
  transform: rotate(-45deg);
  margin-top: 0;
}
.dsr-recents-count {
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  font-variant-numeric: tabular-nums;
}
.dsr-recents-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: visible;
}
.dsr-recent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  width: 0;
  min-width: 0;
  min-height: 38px;
  padding: 0 var(--dshx-row-inset);
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background: transparent;
  color: var(--ink-2, var(--dsw-alias-label-secondary));
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  transition: color .14s ease;
}
.dsr-recent-row:active {
  transform: translateY(1px);
}
.dsr-recent-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  transition: background-color .14s ease;
}
.dsr-recent-item:hover {
  background: var(--hover, var(--dsw-alias-interactive-bg-hover));
}
.dsr-recent-item:hover .dsr-recent-row {
  color: var(--ink, var(--dsw-alias-label-primary));
}
.dsr-recent-item:has(> .dsr-recent-row[aria-current='page']) {
  background: var(--accent-tint, var(--dsw-alias-interactive-bg-hover));
}
.dsr-recent-row[aria-current='page'] {
  color: var(--primary, var(--dsw-alias-state-business-primary, var(--ink, var(--dsw-alias-label-primary))));
  font-weight: 500;
}
.dsr-workspace-pin {
  display: inline-flex;
  flex: none;
  width: 24px;
  height: 24px;
  margin-inline: 1px;
}
.dsr-pin-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  cursor: pointer;
  opacity: 0;
}
.dsr-pin-button svg { width: 15px; height: 15px; }
.dsr-pin-button[aria-pressed='true'],
.dsr-pin-button:focus-visible,
.dsr-pin-button:disabled,
.dsr-recent-item:hover .dsr-pin-button,
.dsr-recent-item:focus-within .dsr-pin-button,
[data-row-key]:hover > [data-dsr-workspace-pin] .dsr-pin-button,
[data-row-key]:focus-within > [data-dsr-workspace-pin] .dsr-pin-button {
  opacity: 1;
}
.dsr-pin-button[aria-pressed='true'] { color: var(--ink-2, var(--dsw-alias-label-secondary)); }
.dsr-pin-button:hover { background: var(--hover-2, var(--dsw-alias-interactive-bg-hover)); color: var(--ink, var(--dsw-alias-label-primary)); }
.dsr-pin-button:disabled { cursor: wait; }
@media (hover: none) { .dsr-pin-button { opacity: 1; } }
.dsr-pin-error {
  padding: 4px 8px;
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
  font-size: 12px;
}
.dsr-recent-main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.dsr-activity,
.dsr-workspace-activity {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
}
.dsr-workspace-activity {
  margin: 0 4px;
}
.dsr-recent-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsr-recent-workspace {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  font-size: 11px;
  line-height: 14px;
  font-weight: 400;
}
.dsr-recents-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 2px 2px 4px calc(var(--dshx-row-inset) - 6px);
}
.dsr-recents-empty {
  padding: 6px var(--dshx-row-inset) 8px;
  color: var(--ink-3, var(--dsw-alias-label-tertiary));
  font-size: 12px;
  line-height: 18px;
}
`;

/** Install the plugin stylesheet once per plugin lifetime. */
export function injectStyles() {
  if (typeof document === 'undefined') return () => {};
  let style = document.querySelector(`style[${STYLE_ATTRIBUTE}]`);
  if (style === null) {
    style = document.createElement('style');
    style.setAttribute(STYLE_ATTRIBUTE, '');
    style.setAttribute('data-plugin', 'dsh-sidebar-recents');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
  return () => {
    style?.remove();
  };
}
