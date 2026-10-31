import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react';

const {window}=parseHTML('<html><head></head><body><div id="root"></div></body></html>');
globalThis.window=window;globalThis.document=window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function load(code, shell=false){let exports;const context={React,console,setTimeout,clearTimeout,setInterval,clearInterval,AbortSignal,fetch:(...args)=>globalThis.fetch(...args),document:window.document,globalThis:{},window:{__ModuleLoader__:{load({factory}){exports=factory(name=>{if(name==='react')return React;throw new Error(name);});}}}};context.globalThis=context;vm.runInNewContext(code,context);return shell?exports:context.__dshProjectPackagePanelFactory(()=>React);}
const shell=load(await readFile(new URL('../dist/client.js',import.meta.url),'utf8'),true);
const panel=load(await readFile(new URL('../dist/panel.js',import.meta.url),'utf8'));
test('entry is directly above kanban and registers no scan/timer/panel script',()=>{
  const entries=[];let selected;const cleanup=[];
  const ctx={effect(fn){cleanup.push(fn());},slots:{inject(name,fn){return fn();},register(options,render){entries.push({options,render});return()=>{};}},layout:{selectPanel(id){selected=id;}}};
  shell.apply(ctx);
  const entry=entries.find(x=>x.options.name==='sidebar.footer.action');assert.equal(entry.options.order,-5);
  assert.equal(window.document.querySelectorAll('script').length,0);
  const button=entry.render({wide:true});button.props.onClick();assert.equal(selected,'dsh-project-package');
  cleanup.forEach(fn=>fn?.());
});
test('current project selection prefers exact path then owning reactor',()=>{
  const projects=[{path:'D:\\repo'},{path:'D:\\other'}];
  assert.equal(panel.chooseProject(projects,'D:/repo/module').path,'D:\\repo');
  assert.equal(panel.chooseProject(projects,'D:/other').path,'D:\\other');
  assert.equal(panel.chooseProject(projects,'D:/unrelated',[],'D:/other').path,'D:\\other');
});
test('artifacts switch only after the entire build or shell task succeeds',()=>{
  const previous={activeTask:'build-1'};
  const next={activeTask:'build-1',tasks:[{id:'build-1',kind:'build',status:'running',phase:'自动加壳中',artifacts:{war:'a.war'}}]};
  assert.equal(panel.finishedPackagingTask(previous,next),null);
  next.activeTask=null;
  for(const status of ['failed','cancelled','interrupted']){next.tasks[0].status=status;assert.equal(panel.finishedPackagingTask(previous,next),null);}
  next.tasks[0].status='succeeded';
  assert.equal(panel.finishedPackagingTask(previous,next).id,'build-1');
  assert.equal(panel.finishedPackagingTask(next,next),null,'completed history must not repeatedly change tabs');
  next.tasks[0].kind='fetch';assert.equal(panel.finishedPackagingTask(previous,next),null);
  next.tasks[0].kind='shell';assert.equal(panel.finishedPackagingTask(previous,next).id,'build-1');
});
test('markdown is rendered as text, never executable HTML',async()=>{
  const root=createRoot(window.document.getElementById('root'));
  await act(async()=>root.render(React.createElement(panel.Markdown,{text:'# Title\n\n- **bold**\n<script>alert(1)</script>'})));
  assert.equal(document.querySelector('h1').textContent,'Title');assert.equal(document.querySelector('strong').textContent,'bold');assert.equal(document.querySelector('script'),null);
  await act(async()=>root.unmount());
});
test('panel loads workspace projects on mount; close releases lazy engine lease',async()=>{
  const calls=[];const fixture={projects:[],warnings:[],selected:null,git:null,branches:[],environment:[],config:{recent_projects:[],release:{url:'http://localhost',count:5},shell:{enabled:false,auto_shell:false,test_version:false}},monitorOptions:{rules:[]},tasks:[],activeTask:null,monitor:{},monitorBusy:false};
  globalThis.fetch=async(url,options)=>{const input=JSON.parse(options.body);calls.push(input.operation);return{ok:true,json:async()=>({ok:true,value:fixture})};};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  await act(async()=>{root.render(React.createElement(panel.PackagePanel,{ctx:{layout:{selectPanel(){}},sessions:{list:{getSnapshot:()=>({byId:{}})}}}}));await new Promise(resolve=>setTimeout(resolve,10));});
  assert.ok(calls.includes('scan'));assert.match(host.textContent,/暂未识别到业务项目/);assert.match(host.textContent,/Jenkins/);
  assert.ok(calls.includes('jenkins'));assert.equal(host.querySelector('.dpp-lanes'),null);
  await act(async()=>root.unmount());assert.ok(calls.includes('close'));host.remove();
});
test('noncontiguous Jenkins jobs merge; unknown verification does not count as included',async()=>{
  const row=(job,artifact,state,different=false)=>({job,artifact,dependency:artifact,version:'1.0-SNAPSHOT',state,different,jenkins:{status:'成功',number:24,url:'https://jenkins.test/job/'+job}});
  const rows=[row('gaia','gaia-module','已包含远端制品'),row('fms','fms-common','待打包核验'),row('gaia','gaia-service','等待远端核验'),row('gaia','gaia-boot','与远端不同',true)];
  const groups=panel.groupDependencies(rows);
  assert.equal(groups.length,2);assert.equal(groups[0].rows.length,3);assert.equal(groups[0].builds.length,1);
  assert.deepEqual([groups[0].verified,groups[0].different,groups[0].pending],[1,1,1]);
  const root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(panel.DependencyGroups,{rows,war:{path:'actual.war'}})));
  assert.equal(document.querySelectorAll('.dpp-dependency-group').length,2);
  assert.equal(document.querySelectorAll('a[href="https://jenkins.test/job/gaia"]').length,1);
  assert.equal(document.querySelectorAll('tbody tr').length,4);
  assert.equal(document.querySelectorAll('tr[data-different="true"]').length,1);
  assert.match(document.querySelector('details').textContent,/actual.war/);
  await act(async()=>root.unmount());
});
test('reopening displays cached project cards while fresh engine state is pending',async()=>{
  const project={path:'D:/cached/fms-p275',artifact:'cached-fms-p275',packaging:'pom',targets:[]};
  const fixture={projects:[project],warnings:[],selected:null,git:null,branches:[],environment:[],config:{recent_projects:[],release:{url:'http://localhost',count:5},shell:{}},monitorOptions:{rules:[]},tasks:[],activeTask:null,monitor:{},monitorBusy:false};
  globalThis.fetch=async()=>({ok:true,json:async()=>({ok:true,value:fixture})});
  const host=document.createElement('div');document.body.appendChild(host);
  let root=createRoot(host);
  const ctx={layout:{selectPanel(){}},sessions:{list:{getSnapshot:()=>({byId:{}})}}};
  await act(async()=>{root.render(React.createElement(panel.PackagePanel,{ctx}));await new Promise(resolve=>setTimeout(resolve,10));});
  await act(async()=>root.unmount());
  let release;const pending=new Promise(resolve=>release=resolve);
  globalThis.fetch=async(_url,options)=>{if(JSON.parse(options.body).operation==='scan')await pending;return{ok:true,json:async()=>({ok:true,value:fixture})};};
  root=createRoot(host);
  try{
    await act(async()=>root.render(React.createElement(panel.PackagePanel,{ctx})));
    assert.match(host.querySelector('.dpp-projects').textContent,/cached-fms-p275/);
    assert.equal(host.querySelector('.dpp-project').disabled,true,'cached cards wait for engine readiness before mutating');
    await act(async()=>{release();await pending;});
  }finally{release();await act(async()=>root.unmount());host.remove();}
});
