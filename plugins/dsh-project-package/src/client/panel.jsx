import React from 'react';
import { CSS } from './styles.js';
import { JenkinsStatus } from './jenkins.jsx';

const {useState, useEffect, useRef} = React;
const LABELS = {build:'Maven 打包', shell:'WAR 加壳', fetch:'刷新远端分支', pull:'拉取更新', switch:'切换分支', reset:'重置到远端'};
const STATUS = {running:'运行中', cancelling:'正在取消', succeeded:'已完成', failed:'失败', cancelled:'已取消', interrupted:'已中断'};
const ARTIFACTS = {war:'原始 WAR', protected:'加壳包', notes:'版本说明文件', jar:'JAR 产物'};
let panelMemory = null, rememberedTab = 'logs', rememberedTaskId = '';
const draftFrom = value => value ? {release:{...value.config.release},shell:{...value.config.shell},monitorOptions:{...value.monitorOptions}} : null;

export async function request(operation, data, lease, timeout=55000) {
  const response = await fetch('/dsh-project-package/api', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({operation, data, lease}), signal:AbortSignal.timeout(timeout), cache:'no-store'});
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload.value;
}
const canonical = value => String(value || '').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
export function chooseProject(projects, cwd, recent=[], remembered='') {
  const current = canonical(cwd);
  return projects.find(p => canonical(p.path) === current)
    || projects.filter(p => current.startsWith(canonical(p.path) + '/')).sort((a,b) => b.path.length-a.path.length)[0]
    || projects.find(p => canonical(p.path) === canonical(remembered))
    || projects.find(p => recent.some(r => canonical(r) === canonical(p.path))) || projects[0];
}
export function finishedPackagingTask(previous, next) {
  if (!previous?.activeTask || next.activeTask) return null;
  return next.tasks.find(task => task.id === previous.activeTask && task.status === 'succeeded' && ['build','shell'].includes(task.kind)) || null;
}
function time(value) { return value ? new Date(value*1000).toLocaleString('zh-CN',{hour12:false}) : ''; }
function Button({children, tone='', ...props}) { return <button type="button" className={'dpp-btn '+tone} {...props}>{children}</button>; }
function Field({label, value, onChange, type='text', full=false, ...props}) {return <label className={'dpp-setting'+(full?' full':'')}>{label}<input className="dpp-field" type={type} value={value ?? ''} onChange={e=>onChange(type==='number'?Number(e.target.value):e.target.value)} {...props}/></label>;}
function Check({label, value, onChange, disabled}) { return <label className="dpp-check"><input type="checkbox" checked={!!value} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>{label}</label>; }

export function groupDependencies(rows=[]) {
  const groups = new Map();
  for (const row of rows) {
    const job = row.job || '未关联任务';
    if (!groups.has(job)) groups.set(job, {job, rows:[], builds:new Map(), verified:0, different:0, pending:0});
    const group = groups.get(job), build = row.jenkins || {};
    group.rows.push(row);
    group.builds.set(JSON.stringify([build.status || '未知', build.number ?? null, build.url || '']), build);
    if (row.different) group.different++;
    else if (row.state === '已包含远端制品') group.verified++;
    else group.pending++;
  }
  return [...groups.values()].map(group => ({...group, builds:[...group.builds.values()]}));
}

export function DependencyGroups({rows, war}) {
  return <div className="dpp-dependency-groups">{groupDependencies(rows).map(group => {
    const url = group.builds.find(build => /^https?:\/\//.test(build.url || ''))?.url;
    return <section className="dpp-dependency-group" key={group.job} aria-label={'Jenkins 任务 '+group.job}>
      <header className="dpp-dependency-head">
        <strong>{url?<a href={url} target="_blank" rel="noreferrer">{group.job} ↗</a>:group.job}</strong>
        <span className="dpp-badge">{group.rows.length} 项依赖</span>
        <span className="dpp-job-build">构建 {group.builds.map(build => `${build.status || '未知'}${build.number != null?' #'+build.number:''}`).join(' / ')}</span>
        <span className="dpp-dependency-counts">
          {!!group.verified&&<span className="dpp-verified">已包含 {group.verified}</span>}
          {!!group.different&&<span className="dpp-different">有差异 {group.different}</span>}
          {!!group.pending&&<span className="dpp-muted">待核验 {group.pending}</span>}
        </span>
      </header>
      <div className="dpp-table-wrap"><table className="dpp-table"><thead><tr><th>产品依赖</th><th>版本</th><th>包内核验</th></tr></thead><tbody>{group.rows.map(row=><tr key={row.dependency} data-different={row.different}>
        <td className="dpp-dependency-name">{row.artifact}</td><td className="dpp-muted">{row.version}</td>
        <td><details><summary>{row.state}</summary>{'坐标：'+row.dependency+'\n仓库：'+(row.remote?.repository||'—')+'\n远端制品：'+(row.remote?.identity||'—')+'\n发布时间（UTC）：'+(row.remote?.updated||'—')+'\n实际包：'+(war?.path||'尚未核验')}</details></td>
      </tr>)}</tbody></table></div>
    </section>;
  })}</div>;
}

function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i) => part.startsWith('**') ? <strong key={i}>{part.slice(2,-2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1,-1)}</code> : part.replace(/\\([\\`*_{}\[\]()#+\-.!])/g,'$1'));
}
export function Markdown({text}) {
  const rows = String(text||'').split('\n'), result=[]; let code=null, list=[];
  function flush(){if(list.length){result.push(<ul key={'l'+result.length}>{list.map((x,i)=><li key={i}>{inline(x)}</li>)}</ul>);list=[];}}
  rows.forEach((line,i)=>{
    if(line.startsWith('```')){flush();if(code!==null){result.push(<pre key={i}>{code.join('\n')}</pre>);code=null;}else code=[];return;}
    if(code!==null){code.push(line);return;}
    const item=line.match(/^\s*[-*+]\s+(.+)/); if(item){list.push(item[1]);return;} flush();
    const heading=line.match(/^(#{1,6})\s+(.+)/); if(heading){result.push(React.createElement('h'+heading[1].length,{key:i},inline(heading[2])));return;}
    if(line.trim()) result.push(<p key={i}>{inline(line)}</p>);
  }); flush(); if(code!==null) result.push(<pre key="tail">{code.join('\n')}</pre>);
  return <div className="dpp-markdown">{result}</div>;
}

export function PackagePanel({ctx}) {
  const lease = useRef('package-'+(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)));
  const [state,setState]=useState(panelMemory), [error,setError]=useState(''), [busy,setBusy]=useState(''), [toast,setToast]=useState('');
  const [search,setSearch]=useState(''), [manual,setManual]=useState(''), [tab,setTab]=useState(rememberedTab);
  const [taskId,setTaskId]=useState(rememberedTaskId), [branch,setBranch]=useState(''), [raw,setRaw]=useState(false), [confirm,setConfirm]=useState(null);
  const [draft,setDraft]=useState(()=>draftFrom(panelMemory)), [dirty,setDirty]=useState(false), [showSettings,setShowSettings]=useState(false);
  const stateRef=useRef(panelMemory), busyRef=useRef(false), polling=useRef(false), alive=useRef(true), initialized=useRef(false), logRef=useRef(null), lastMonitor=useRef(0), lastStatePoll=useRef(0);
  const api=(op,data={},timeout)=>request(op,data,lease.current,timeout);
  const install=value=>{if(!alive.current)return;if(value?.tasks){const completed=finishedPackagingTask(stateRef.current,value);panelMemory=value;stateRef.current=value;setState(value);if(completed){setTaskId(completed.id);setTab('artifacts');}}};
  const jenkinsPolling=useRef(false);
  async function refreshJenkins(){
    if(!alive.current||!initialized.current||jenkinsPolling.current)return;
    jenkinsPolling.current=true;
    try{install(await api('jenkins'));}catch(e){if(alive.current)setState(old=>old?{...old,jenkinsLive:{...old.jenkinsLive,error:e.message,loading:false}}:old);}finally{jenkinsPolling.current=false;}
  }
  function resetDraft(value){setDraft(draftFrom(value));setDirty(false);}
  useEffect(()=>{rememberedTab=tab;rememberedTaskId=taskId;},[tab,taskId]);
  async function act(label,op,data={},options={}) {
    if(busyRef.current)return;
    busyRef.current=true;setBusy(label);setError('');setToast('');
    try{const value=await api(op,data,options.timeout);if(options.install!==false)install(value);if(options.reset&&value.config)resetDraft(value);return value;}
    catch(e){if(alive.current)setError(e.message);}
    finally{busyRef.current=false;if(alive.current)setBusy('');}
  }
  async function initialize(){
    let value=await act(panelMemory?'正在恢复项目状态':'正在识别工作区项目','scan',{}, {install:false});
    if(!alive.current||!value)return;
    const sessionId=ctx.uiWorkspace?.selection?.getSnapshot?.().sessionId;
    const cwd=ctx.sessions?.list?.getSnapshot?.().byId?.[sessionId]?.cwd;
    const project=chooseProject(value.projects,cwd,value.config.recent_projects,panelMemory?.selected?.path);
    if(!value.selected&&!value.activeTask&&project){
      const oldTarget=panelMemory?.selected?.target;
      const target=project.targets?.some(t=>t.path===oldTarget)?oldTarget:undefined;
      value=await act('正在恢复项目状态','select',{project:project.path,target},{install:false});
    }
    if(!alive.current||!value)return;
    initialized.current=true;install(value);resetDraft(value);void refreshJenkins();
  }
  useEffect(()=>{
    alive.current=true;
    const style=document.createElement('style');style.dataset.plugin='dsh-project-package/panel';style.textContent=CSS;document.head.appendChild(style);
    void initialize();
    void refreshJenkins();
    const jenkinsTimer=setInterval(()=>{if(!document.hidden)void refreshJenkins();},5000);
    const timer=setInterval(async()=>{
      if(busyRef.current||polling.current||!initialized.current||!stateRef.current)return;
      if(Date.now()-lastStatePoll.current<(stateRef.current.activeTask?400:1800))return;
      lastStatePoll.current=Date.now();
      polling.current=true;
      try{
        const next=await api('state');if(!alive.current)return;install(next);
        if(!next.activeTask && next.selected && Date.now()-lastMonitor.current>10000){
          lastMonitor.current=Date.now();install(await api('monitor'));
        }
      }catch(e){if(alive.current)setError(e.message);}finally{polling.current=false;}
    },400);
    return()=>{alive.current=false;clearInterval(timer);clearInterval(jenkinsTimer);style.remove();void fetch('/dsh-project-package/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'close',lease:lease.current}),keepalive:true}).catch(()=>{});};
  },[]);
  const tasks=state?.tasks||[], selected=state?.selected, git=state?.git;
  const task=tasks.find(t=>t.id===state?.activeTask)||tasks.find(t=>t.id===taskId)||tasks.find(t=>canonical(t.project)===canonical(selected?.path)&&['build','shell'].includes(t.kind))||tasks.find(t=>canonical(t.project)===canonical(selected?.path))||tasks[0];
  const active=!!state?.activeTask, disabled=!!busy||active||!initialized.current;
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[task?.logs?.length,tab]);
  function edit(group,name,value){setDraft(old=>({...old,[group]:{...old[group],[name]:value}}));setDirty(true);}
  async function save(){const result=await act('正在保存配置','settings',draft,{reset:true});if(result)setToast('配置已保存');return result;}
  async function start(kind,extra={}){
    if(dirty && !(await save()))return;
    const result=await act('正在启动任务','start',{kind,...extra});
    if(result){const started=result.tasks.find(t=>t.id===result.activeTask)||result.tasks[0];setTaskId(started?.id||'');setTab(started?.status==='succeeded'&&['build','shell'].includes(kind)?'artifacts':kind==='shell'?'shell':'logs');}
  }
  async function selectProject(path,target){const result=await act('正在读取项目','select',{project:path,target});if(result){setTaskId('');setBranch('');lastMonitor.current=0;}}
  async function copy(text){try{await navigator.clipboard.writeText(text);setToast('已复制');}catch{setError('复制失败，请使用原文视图手动复制');}}
  async function artifactAction(operation,kind){const result=await act(operation==='copyFile'?'正在复制文件':'正在打开目录',operation,{taskId:task.id,kind});if(result)setToast(operation==='copyFile'?'文件已复制，可直接粘贴':'已打开产物目录');}
  const projects=(state?.projects||[]).filter(p=>[p.artifact,p.path,p.workspace].join(' ').toLowerCase().includes(search.toLowerCase()));
  const monitor=state?.monitor||{};
  const tabItems=[['logs','构建日志'],['notes','版本说明'],['shell','加壳'],['artifacts','产物'],['monitor','Jenkins / 依赖更新']];
  return <section className="dpp" aria-label="项目打包看板" style={{position:'relative'}}>
    <header className="dpp-head"><h2>项目打包</h2><span className="dpp-badge">PackageTool 1.6.1</span><span className="dpp-subtitle">工作区项目 · 构建与交付</span><div className="dpp-head-actions"><JenkinsStatus data={state?.jenkinsLive} onRefresh={refreshJenkins} onSettings={()=>setShowSettings(true)}/><Button disabled={!!busy} onClick={()=>initialized.current?act('正在识别工作区项目','scan',{force:true}):initialize()}>↻ 重新识别</Button><Button disabled={!state} onClick={()=>setShowSettings(x=>!x)}>{showSettings?'收起配置':'配置'}</Button><Button aria-label="关闭打包看板" onClick={()=>ctx.layout.selectPanel(null)}>✕</Button></div></header>
    <div className="dpp-statusbar">{state?.environment.map(item=><span key={item.name}><i className={'dpp-dot'+(item.available?'':' bad')}/>{item.name}{item.available?' 就绪':' 未找到'}</span>)}<span>{state?`${state.projects.length} 个有效项目`:'首次打开时加载项目与引擎'}</span>{busy&&<span className="dpp-busy" role="status">{busy}…</span>}{toast&&<span className="dpp-toast" role="status">{toast}</span>}</div>
    {error&&<div className="dpp-notice dpp-error" role="alert">{error}<button className="dpp-tab" onClick={()=>setError('')}>关闭</button></div>}
    {state?.warnings?.map(w=><p className="dpp-notice" key={w}>{w}</p>)}
    <main className="dpp-content">
      {!state&&!busy&&<div className="dpp-empty">读取项目失败。<Button onClick={initialize}>重试</Button></div>}
      {state&&<>
        <div className="dpp-projectbar"><input className="dpp-field dpp-search" aria-label="筛选项目" placeholder="搜索项目名称或路径" value={search} onChange={e=>setSearch(e.target.value)}/><input className="dpp-field" aria-label="项目目录" placeholder="也可输入项目根目录" value={manual} onChange={e=>setManual(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!disabled&&manual)void selectProject(manual);}} list="dpp-recent"/><datalist id="dpp-recent">{state.config.recent_projects.map(p=><option key={p} value={p}/>)}</datalist><Button disabled={disabled||!manual} onClick={()=>selectProject(manual)}>读取目录</Button><Button disabled={disabled} onClick={async()=>{const value=await act('请选择项目目录','pick',{}, {timeout:125000});if(value?.path){setManual(value.path);await selectProject(value.path);}}}>浏览…</Button></div>
        <div className="dpp-projects">{projects.map(p=><button key={p.path} className={'dpp-project'+(canonical(selected?.path)===canonical(p.path)?' selected':'')} disabled={disabled} onClick={()=>selectProject(p.path)} title={p.path}><strong>{p.artifact}</strong><div className="dpp-project-meta"><span className="dpp-badge">{p.version||'版本未声明'}</span><span className="dpp-badge">{p.packaging.toUpperCase()}</span><span className="dpp-muted">{p.workspace||'项目'}</span></div><span className="dpp-path">{p.path}</span></button>)}</div>
        {!projects.length&&<div className="dpp-empty">{search?'没有匹配的项目':'工作区中暂未识别到业务项目（module + starter），可浏览或输入项目目录。'}</div>}
        {selected&&<section className="dpp-detail"><div className="dpp-detail-head"><h3>{selected.artifact}</h3><span className="dpp-badge">{selected.version}</span><div className="dpp-build-actions"><Check label="测试版本" value={draft?.shell.test_version} disabled={disabled} onChange={v=>edit('shell','test_version',v)}/><Button tone="dpp-primary" disabled={disabled||!selected.target||!!git?.error} onClick={()=>start('build')}>▶ 开始打包</Button><Button tone="dpp-danger" disabled={!active||!!busy||task?.status==='cancelling'} onClick={()=>act('正在终止','cancel')}>{task?.status==='cancelling'?'正在终止…':'■ 终止任务'}</Button></div></div><div className="dpp-detail-body"><span className="dpp-muted">产物模块</span><select className="dpp-field" aria-label="产物模块" disabled={disabled} value={selected.target||''} onChange={e=>selectProject(selected.path,e.target.value)}><option value="" disabled>请选择产物模块</option>{selected.targets.map(t=><option key={t.path} value={t.path}>{t.artifact} · {t.packaging.toUpperCase()}</option>)}</select><span className="dpp-path" style={{margin:0}}>{selected.path}</span></div><div className="dpp-git"><div className="dpp-git-info">{git?.error?<span className="dpp-error">{git.error}</span>:<><strong>⑂ {git?.branch||(state.gitLoading?'读取 Git 中…':'—')}</strong>{state.gitLoading&&<span className="dpp-muted"> · 更新中</span>}　{git?.upstream||'未设置上游'}<br/><span className="dpp-muted">领先 {git?.ahead||0} · 落后 {git?.behind||0} · 本地改动 {git?.changed_count||0}</span></>}</div><select className="dpp-field" aria-label="远端分支" disabled={disabled} value={branch} onChange={e=>setBranch(e.target.value)}><option value="">选择远端分支</option>{state.branches.map(b=><option key={b} value={b}>{b}</option>)}</select><Button disabled={disabled||!!git?.error} onClick={()=>start('fetch')}>刷新分支</Button><Button disabled={disabled||state.gitLoading||!branch||!!git?.dirty} onClick={()=>start('switch',{branch})}>切换分支</Button><Button disabled={disabled||state.gitLoading||!git?.upstream} onClick={()=>start('pull')}>拉取</Button><Button tone="dpp-danger" disabled={disabled||state.gitLoading||!git?.upstream} onClick={()=>setConfirm({kind:'reset'})}>重置到远端</Button></div></section>}
        {showSettings&&draft&&<section className="dpp-detail"><div className="dpp-detail-head"><h3>打包与关联配置</h3><span className="dpp-muted">沿用原软件配置；凭据留空保留</span><Button disabled={disabled||!dirty} onClick={save}>保存配置</Button>{dirty&&<span className="dpp-muted">有未保存修改</span>}</div><div className="dpp-pane"><div className="dpp-settings"><h4>版本说明服务</h4><Field label="服务地址" value={draft.release.url} disabled={disabled} onChange={v=>edit('release','url',v)}/><Field label="最近版本数（1～50）" type="number" min="1" max="50" value={draft.release.count} disabled={disabled} onChange={v=>edit('release','count',v)}/><h4>Jenkins 与 Maven 仓库</h4>{[['jenkins_url','Jenkins 地址'],['jenkins_user','Jenkins 用户名'],['jenkins_secret','Jenkins API Token（留空保留）'],['repository_id','Maven 仓库 ID（空白自动识别）'],['repository_url','仓库地址（空白沿用 settings）'],['repository_user','仓库用户名（空白沿用 settings）'],['repository_secret','仓库密码（留空保留）']].map(([name,label])=><Field key={name} label={label} type={name.endsWith('secret')?'password':'text'} value={draft.monitorOptions[name]} disabled={disabled} onChange={v=>edit('monitorOptions',name,v)} autoComplete="off"/>)}<label className="dpp-setting full">依赖关联 · 每行 groupId:artifactId:版本规则=Jenkins任务<textarea disabled={disabled} value={draft.monitorOptions.rules.join('\n')} onChange={e=>edit('monitorOptions','rules',e.target.value.split('\n'))}/></label><span className="dpp-muted">手工凭据使用 Windows 当前用户加密保存；沿用原软件的 FMS / WMS / Gaia 规则。</span></div></div></section>}
        <section className="dpp-workbench"><nav className="dpp-tabs" aria-label="打包详情">{tabItems.map(([id,label])=><button key={id} className={'dpp-tab'+(tab===id?' active':'')} onClick={()=>setTab(id)}>{label}{id==='monitor'&&monitor.events?.length?' ●':''}</button>)}{!!tasks.length&&<select className="dpp-field dpp-history" aria-label="任务记录" value={task?.id||""} disabled={active} onChange={e=>{setTaskId(e.target.value);}}>{tasks.map(record=><option key={record.id} value={record.id}>{record.name} · {LABELS[record.kind]} · {STATUS[record.status]} · {time(record.started)}</option>)}</select>}</nav><div className="dpp-pane">
          {tab==='logs'&&<><div className="dpp-toolbar"><span className="dpp-muted">{task?`${task.name} · ${LABELS[task.kind]} · ${STATUS[task.status]} · ${task.phase||""}`:'选择任务查看日志'}</span>{task&&<Button onClick={()=>copy(task.logs.map(l=>l.text).join('\n'))}>复制日志</Button>}</div><pre className="dpp-log" ref={logRef}>{task?.logs.map(l=>l.text).join('\n')||'开始打包后，日志会在这里实时显示。'}</pre></>}
          {tab==='notes'&&<><div className="dpp-toolbar"><Button disabled={!task?.markdown} onClick={()=>copy(task.markdown)}>复制 Markdown</Button><Button onClick={()=>setRaw(x=>!x)}>{raw?'预览':'查看原文'}</Button>{task?.artifacts.notes&&<Button onClick={()=>artifactAction('copyFile','notes')}>复制说明文件</Button>}</div>{raw?<textarea className="dpp-raw" readOnly value={task?.markdown||''}/>:task?.markdown?<Markdown text={task.markdown}/>:<div className="dpp-muted">构建时生成项目说明，完成后合并产品版本说明。</div>}</>}
          {tab==='shell'&&draft&&<><div className="dpp-toolbar"><Check label="启用加壳" value={draft.shell.enabled} disabled={disabled} onChange={v=>edit('shell','enabled',v)}/><Check label="打包成功后自动加壳" value={draft.shell.auto_shell} disabled={disabled||!draft.shell.enabled} onChange={v=>edit('shell','auto_shell',v)}/><Check label="测试版本（test- 前缀）" value={draft.shell.test_version} disabled={disabled} onChange={v=>edit('shell','test_version',v)}/><Button disabled={disabled||!dirty} onClick={save}>保存配置</Button><Button disabled={disabled||!selected||!draft.shell.enabled} onClick={()=>start('shell')}>执行加壳</Button></div><div className="dpp-settings">{[['upload_dir','上传共享目录'],['finish_dir','完成共享目录'],['trigger_url','加壳服务地址']].map(([name,label])=><Field key={name} label={label} full={name==='trigger_url'} value={draft.shell[name]} disabled={disabled} onChange={v=>edit('shell',name,v)}/>)}</div><pre className="dpp-log" style={{marginTop:14}}>{task?.logs.filter(l=>l.channel==='shell').map(l=>l.text).join('\n')||'加壳日志将显示在这里。'}</pre></>}
          {tab==='artifacts'&&<>{Object.entries(task?.artifacts||{}).map(([kind,file])=><div className="dpp-artifact" key={kind}><div><strong>{ARTIFACTS[kind]||kind}</strong><span className="dpp-path">{file}</span></div><Button disabled={!!busy} onClick={()=>artifactAction('copyFile',kind)}>复制文件</Button><Button disabled={!!busy} onClick={()=>artifactAction('reveal',kind)}>打开目录</Button></div>)}{!Object.keys(task?.artifacts||{}).length&&<span className="dpp-muted">任务完成后可在这里复制产物文件或打开所在目录。</span>}</>}
          {tab==='monitor'&&<><div className="dpp-toolbar"><Button disabled={disabled||!selected||state.monitorBusy} onClick={()=>act('正在刷新依赖状态','monitor',{force:true})}>刷新</Button><Button disabled={disabled||!selected||state.monitorBusy} onClick={()=>act('正在识别依赖','monitor',{force:true,resolve:true})}>重新识别依赖</Button><Button disabled={disabled||state.monitorBusy||!monitor.events?.length} onClick={()=>act('正在标记','acknowledge')}>已知晓</Button><Button onClick={()=>setShowSettings(true)}>关联配置</Button><span className="dpp-muted">{state.monitorBusy?'正在查询依赖与构建状态…':`${groupDependencies(monitor.rows).length} 个任务 · ${monitor.rows?.length||0} 项依赖 · ${monitor.rows?.filter(r=>r.different).length||0} 项与远端不同`}</span></div>{state.monitorError&&<p className="dpp-error">{state.monitorError}</p>}{monitor.notifications?.map(n=><p className="dpp-notice" key={n}>{n}</p>)}<DependencyGroups rows={monitor.rows} war={monitor.war}/>{!monitor.rows?.length&&<p className="dpp-muted">仅显示项目实际使用的 FMS / WMS / Gaia 依赖。首次识别可能需要 Maven 下载依赖解析插件。</p>}{!!monitor.unassociated?.length&&<details className="dpp-muted"><summary>未关联的内部依赖（{monitor.unassociated.length}）</summary><pre>{monitor.unassociated.join('\n')}</pre></details>}<p className="dpp-muted">构建成功与依赖已更新分别核验；关闭面板后停止监控。</p></>}
        </div></section>
      </>}
    </main>
    {confirm&&<div className="dpp-overlay"><section role="dialog" aria-modal="true" aria-labelledby="dpp-reset-title" className="dpp-dialog"><h3 id="dpp-reset-title">重置到远端？</h3><p>项目：{selected?.artifact}<br/>分支：{git?.branch}<br/>目标：{git?.upstream}</p><p>将先获取远端，再重置当前分支。未提交的已跟踪文件改动会丢失，并清理工具生成的未跟踪版本资源；其他未跟踪文件保留。</p><div className="dpp-toolbar"><Button autoFocus onClick={()=>setConfirm(null)}>取消</Button><Button tone="dpp-danger" onClick={()=>{setConfirm(null);void start('reset',{confirmed:true});}}>确认重置</Button></div></section></div>}
  </section>;
}
