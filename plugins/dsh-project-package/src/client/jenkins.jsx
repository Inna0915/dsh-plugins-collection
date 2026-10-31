import React from 'react';

const RESULTS = {SUCCESS:['成功','success'], FAILURE:['失败','failure'], BUILDING:['构建中','building'],
  UNSTABLE:['不稳定','unstable'], ABORTED:['已终止','unknown'], NOT_BUILT:['未构建','unknown'], DISABLED:['已禁用','unknown']};
export function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return seconds + ' 秒';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
  return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分';
}
function age(timestamp, now) {
  if (!timestamp) return '时间未知';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? minutes + ' 分钟前' : minutes < 1440 ? Math.floor(minutes / 60) + ' 小时前' : Math.floor(minutes / 1440) + ' 天前';
}

export function JenkinsStatus({data={}, onRefresh, onSettings}) {
  const [open,setOpen] = React.useState(false), [position,setPosition] = React.useState({});
  const root = React.useRef(null), button = React.useRef(null), pinned = React.useRef(false), closeTimer = React.useRef(null);
  const clearClose = () => clearTimeout(closeTimer.current);
  const close = () => {clearClose();pinned.current=false;setOpen(false);};
  const preview = () => {clearClose();setOpen(true);};
  const scheduleClose = () => {clearClose();if(!pinned.current)closeTimer.current=setTimeout(()=>setOpen(false),180);};
  React.useEffect(()=>()=>clearTimeout(closeTimer.current),[]);
  React.useLayoutEffect(()=>{
    if(!open)return;
    const owner = root.current.closest('.dpp');
    const reposition = () => {
      const bounds = owner.getBoundingClientRect(), anchor = button.current.getBoundingClientRect();
      const width = Math.min(420, bounds.width - 24), top = anchor.bottom - bounds.top + 8;
      setPosition({width,top,left:Math.max(12, Math.min(anchor.right-bounds.left-width,bounds.width-width-12)),maxHeight:Math.max(120,bounds.height-top-12)});
    };
    reposition();
    const outside = event => {if(!root.current.contains(event.target))close();};
    const escape = event => {if(event.key==='Escape'){event.stopPropagation();close();button.current.focus();}};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    window.addEventListener('resize',reposition);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
    observer?.observe(owner);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',reposition);observer?.disconnect();};
  },[open]);
  const running = data.runningCount || 0, builds = data.builds || [], now = Date.now();
  const signal = data.error ? 'failure' : !data.fetchedAt ? 'unknown' : running ? 'building' : 'success';
  return <div className="dpp-jenkins" ref={root} onMouseEnter={preview} onMouseLeave={scheduleClose}>
    <button className="dpp-btn dpp-jenkins-button" ref={button} type="button" aria-label="Jenkins 实时构建" aria-haspopup="dialog" aria-expanded={open} aria-controls="dpp-jenkins-popup"
      onClick={()=>{clearClose();if(pinned.current){close();}else{pinned.current=true;setOpen(true);}}}>
      <i className={'dpp-jenkins-dot '+signal}/><span>Jenkins</span>{running>0&&!data.error&&<span className="dpp-jenkins-count">{running}</span>}
    </button>
    {open&&<section className="dpp-jenkins-panel" id="dpp-jenkins-popup" role="dialog" aria-label="Jenkins 实时构建状态" style={position} onMouseEnter={clearClose} onMouseLeave={scheduleClose}>
      <header className="dpp-jenkins-header"><div><strong>Jenkins 构建</strong><span>{data.fetchedAt?new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour12:false})+' 更新':'正在连接…'}{data.loading&&data.fetchedAt?' · 刷新中':''}</span></div>
        <button type="button" className="dpp-tab" aria-label="刷新 Jenkins" disabled={data.loading} onClick={onRefresh}>↻</button>
        <button type="button" className="dpp-tab" aria-label="Jenkins 连接配置" onClick={()=>{close();onSettings();}}>⚙</button>
      </header>
      {data.error&&<div className="dpp-jenkins-error" role="alert">{data.error}</div>}
      <div className="dpp-jenkins-summary">{data.error?'连接中断，以下为上次读取的状态':!data.fetchedAt?'正在读取构建状态…':running?`${running} 个任务正在构建`:'当前没有正在构建的任务'}</div>
      <div className="dpp-jenkins-builds">{builds.map(build=>{
        const [label,tone] = RESULTS[build.result] || ['未知','unknown'];
        const elapsed = build.building ? Math.max(0, now-build.timestamp) : build.duration;
        const progress = build.building && build.estimatedDuration > 0 ? Math.min(95,Math.max(1,elapsed/build.estimatedDuration*100)) : null;
        const content = <><i className={'dpp-jenkins-dot '+tone}/><div className="dpp-jenkins-build-main"><div><strong>{build.jobName}</strong><span>#{build.number??'—'}</span></div><small title={build.timestamp?new Date(build.timestamp).toLocaleString('zh-CN'):''}>{age(build.timestamp,now)} · {build.building?'已运行 ':'用时 '}{duration(elapsed)}</small>{progress!==null&&<span className="dpp-jenkins-progress" aria-label="预计构建进度"><i style={{width:progress+'%'}}/></span>}</div><span className={'dpp-jenkins-result '+tone}>{label}</span></>;
        return /^https?:\/\//.test(build.url||'')?<a className="dpp-jenkins-build" href={build.url} target="_blank" rel="noreferrer" key={build.jobName}>{content}</a>:<div className="dpp-jenkins-build" key={build.jobName}>{content}</div>;
      })}{!!data.fetchedAt&&!builds.length&&!data.error&&<p className="dpp-jenkins-empty">暂无构建记录</p>}</div>
      <footer>每 5 秒刷新 · 显示最近 {builds.length} 项{data.totalCount>builds.length?' / 共 '+data.totalCount+' 项':''}</footer>
    </section>}
  </div>;
}
