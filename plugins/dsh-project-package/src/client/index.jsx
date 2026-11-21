import React from 'react';

export const inject = ['slots', 'layout', 'uiWorkspace', 'sessions'];
const PANEL = 'dsh-project-package';
const SIDEBAR_CSS = /* @sidebar-style */ ":root{--dshx-label-inset: 10px;--dshx-row-inset: 12px;--dshx-footer-inset: 2px;--dshx-icon-box: 18px;--dshx-icon-gap: 10px;--dshx-row-height: 38px;--dshx-rail-size: 36px}[data-slot=\"sidebar.footer.action\"]:has(> .dshx-entry){display: flex !important;flex-direction: column;align-items: stretch;gap: 3px;width: 100%;min-width: 0}.dshx-entry{box-sizing: border-box;display: flex;align-items: center;gap: var(--dshx-icon-gap);width: 100%;min-width: 0;min-height: var(--dshx-row-height);margin: 0;padding: 0 calc(var(--dshx-row-inset) - var(--dshx-footer-inset));border: 0;border-radius: var(--dsw-radius-lg, 16px);background: transparent;color: var(--ink-2, var(--dsw-alias-label-secondary));font: inherit;font-size: var(--fs-strong, 14px);font-weight: 500;line-height: 22px;text-align: left;cursor: pointer;transition: background-color .14s ease, color .14s ease}.dshx-entry:hover{background: var(--hover, var(--dsw-alias-interactive-bg-hover));color: var(--ink, var(--dsw-alias-label-primary))}.dshx-entry:active{transform: translateY(1px)}.dshx-entry:focus-visible{outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));outline-offset: -2px}.dshx-entry[aria-current=\"page\"]{background: var(--accent-tint, var(--dsw-alias-interactive-bg-hover));color: var(--primary, var(--dsw-alias-state-business-primary, currentColor))}.dshx-entry-icon{display: inline-flex;flex: none;align-items: center;justify-content: center;width: var(--dshx-icon-box);height: var(--dshx-icon-box)}.dshx-entry-icon svg{width: 16px;height: 16px}.dshx-entry-label{min-width: 0;overflow: hidden;text-overflow: ellipsis;white-space: nowrap}.dshx-entry.dshx-rail{width: var(--dshx-rail-size);height: var(--dshx-rail-size);min-height: var(--dshx-rail-size);padding: 0;justify-content: center;align-self: center}" /* @sidebar-style-end */;
let panelPromise, panelModule;

/* global PANEL_VERSION -- injected by scripts/build.mjs from package.json */
export function loadPanel() {
  if (globalThis.__dshProjectPackagePanelVersion === PANEL_VERSION && globalThis.__dshProjectPackagePanelFactory) {
    if (!panelModule) panelModule = globalThis.__dshProjectPackagePanelFactory(name => {
    if (name === 'react') return React;
    throw new Error('Unsupported panel module: ' + name);
    });
    return Promise.resolve(panelModule);
  }
  if (!panelPromise) panelPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/dsh-project-package/panel.js?v=' + encodeURIComponent(PANEL_VERSION);
    script.dataset.plugin = PANEL;
    const timer = setTimeout(() => { script.remove(); panelPromise = null; reject(new Error('面板加载超时')); }, 15000);
    script.onload = () => { clearTimeout(timer); script.remove(); panelPromise = null; loadPanel().then(resolve, reject); };
    script.onerror = () => { clearTimeout(timer); script.remove(); panelPromise = null; reject(new Error('面板加载失败，请重试')); };
    document.head.appendChild(script);
  });
  return panelPromise;
}
function BoxIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z M3 8v9l9 5 9-5V8 M12 13v9 M7.5 5.5l9 5"/></svg>;
}
/** Footer entry: highlighted while the board is the open main panel, like the host navigation rows. */
function SidebarEntry({wide, usePanelInfo, ctx}) {
  const active = typeof usePanelInfo === 'function' ? usePanelInfo((info) => info?.activePanelId === PANEL) : false;
  return <button type="button" className={'dshx-entry' + (wide === true ? '' : ' dshx-rail')} aria-current={active ? 'page' : undefined} aria-label="打开项目打包看板" title="项目打包" onClick={() => ctx.layout.selectPanel(PANEL)}>
    <span className="dshx-entry-icon"><BoxIcon/></span>{wide === true && <span className="dshx-entry-label">项目打包</span>}
  </button>;
}
function LazyPanel({ctx}) {
  const [module, setModule] = React.useState(null);
  const [error, setError] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    loadPanel().then(value => { if (alive) setModule(value); }, reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [retry]);
  if (module) return <module.PackagePanel ctx={ctx}/>;
  return <div style={{padding: 28, fontSize: 14}} role="status">{error || '正在打开项目打包看板…'}{error && <button onClick={() => {setError(''); setRetry(x => x + 1);}}>重试</button>}</div>;
}
export function apply(ctx) {
  const style = document.createElement('style');
  // Left-sidebar entry: shared/sidebar.css (synced by scripts/sync-sidebar-style.mjs; edit there, not here).
  style.dataset.dshxSidebar = PANEL;
  style.textContent = SIDEBAR_CSS;
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove(), 'project-package: entry styles');
  ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:PANEL, id:PANEL, label:'项目打包'}, () => <LazyPanel ctx={ctx}/>));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({name:'sidebar.footer.action', id:PANEL, order:-5, label:'项目打包'}, props => <SidebarEntry {...props} ctx={ctx}/>));
}
