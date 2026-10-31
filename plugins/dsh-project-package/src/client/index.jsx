import React from 'react';

export const inject = ['slots', 'layout', 'uiWorkspace', 'sessions'];
const PANEL = 'dsh-project-package';
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
  style.textContent = '.dpp-entry{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:36px;flex:0 0 36px;padding:7px 10px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;font-size:14px;cursor:pointer;text-align:left}.dpp-entry:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}.dpp-entry svg{flex:none}.dpp-entry span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dpp-entry.dpp-rail{width:36px;align-self:center;justify-content:center;padding:0}.dpp-entry:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:-2px}';
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove(), 'project-package: entry styles');
  ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:PANEL, id:PANEL, label:'项目打包'}, () => <LazyPanel ctx={ctx}/>));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({name:'sidebar.footer.action', id:PANEL, order:-5, label:'项目打包'}, props =>
    <button className={'dpp-entry' + (props.wide === true ? '' : ' dpp-rail')} aria-label="打开项目打包看板" title="项目打包" onClick={() => ctx.layout.selectPanel(PANEL)}><BoxIcon/>{props.wide === true && <span>项目打包</span>}</button>));
}
