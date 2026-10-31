const STYLE_ATTRIBUTE = 'data-dsh-sidebar-recents';
const STYLE_ID = 'dsh-sidebar-recents/styles';

const CSS = `
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
  padding: 0 var(--dsh-sidebar-inline-padding, 12px) 4px 4px;
  box-sizing: border-box;
}
.dsr-workspace-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px 4px;
  margin: 0 0 2px;
  flex: none;
}
.dsr-workspace-pager button,
.dsr-recents-action {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, #171717);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 6px;
  border-radius: var(--dsw-radius-sm, 6px);
  text-align: left;
}
.dsr-workspace-pager button:hover,
.dsr-recents-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
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
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsr-collapse-all:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
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
  border-top: 1px solid var(--dsw-alias-separator-secondary, rgba(127, 127, 127, 0.18));
  box-sizing: border-box;
}
.dsr-recents-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 36px;
  padding: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 18px;
  letter-spacing: 0.02em;
}
.dsr-section-toggle,
[data-dsr-section-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 4px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.dsr-section-toggle:hover,
[data-dsr-section-toggle]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
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
  color: var(--dsw-alias-label-tertiary);
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
  gap: 8px;
  flex: 1;
  width: 0;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dsr-recent-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  border-radius: var(--dsw-radius-md, 8px);
}
.dsr-recent-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
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
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
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
.dsr-pin-button[aria-pressed='true'] { color: var(--dsw-alias-label-primary); }
.dsr-pin-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
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
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 13px;
}
.dsr-recents-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 2px 2px 4px;
}
.dsr-recents-empty {
  padding: 6px 8px 8px;
  color: var(--dsw-alias-label-tertiary);
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
