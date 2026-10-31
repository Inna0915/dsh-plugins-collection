import React from 'react';
import {createRoot} from 'react-dom/client';
import {PackagePanel} from '../src/client/panel.jsx';
const projects=[
  {path:'D:/dev/code/fms-p275/fms-p275',artifact:'fms-p275',version:'1.6.0-SNAPSHOT',packaging:'pom',workspace:'FMS · P275',targets:[{path:'D:/dev/code/fms-p275/fms-p275/fms-project-starter',artifact:'fms-project-starter',packaging:'war'}]},
  {path:'D:/dev/code/wms-p277',artifact:'wms-p277',version:'2.3.0-SNAPSHOT',packaging:'pom',workspace:'WMS · P277',targets:[{path:'D:/dev/code/wms-p277/wms-project-starter',artifact:'wms-project-starter',packaging:'war'}]},
  {path:'D:/dev/code/fms-p281',artifact:'fms-p281',version:'1.0.0-SNAPSHOT',packaging:'pom',workspace:'FMS · P281',targets:[{path:'D:/dev/code/fms-p281/fms-project-starter',artifact:'fms-project-starter',packaging:'war'}]},
];
const state={projects,warnings:[],selected:{...projects[0],target:projects[0].targets[0].path},
  git:{root:projects[0].path,branch:'feature/package-plus',upstream:'origin/feature/package-plus',ahead:0,behind:2,changed_count:0,dirty:false},branches:['origin/main','origin/feature/package-plus'],
  environment:[{name:'git',available:true},{name:'mvn',available:true},{name:'java',available:true},{name:'打包引擎',available:true}],
  config:{recent_projects:projects.map(p=>p.path),release:{url:'http://release.example.test/release',count:5},shell:{enabled:true,auto_shell:true,test_version:false,upload_dir:'\\\\server\\package\\work',finish_dir:'\\\\server\\package\\finish',trigger_url:'http://package.example.test/encrypt'}},
  monitorOptions:{jenkins_url:'http://jenkins.example.test',jenkins_user:'',jenkins_secret:'',repository_id:'',repository_url:'',repository_user:'',repository_secret:'',rules:['com.cyzn.fms:fms-warehouse:*=fms','com.ykeey.gaia:gaia-boot:*=gaia']},
  tasks:[{id:'success',kind:'build',project:projects[0].path,name:'fms-p275',status:'succeeded',phase:'已完成 · 加壳包与说明已生成',started:1793145000,ended:1793145180,branch:'feature/package-plus',logs:[{channel:'build',text:'[INFO] 项目版本说明已生成'},{channel:'build',text:'[INFO] Building fms-project-starter 1.6.0-SNAPSHOT'},{channel:'build',text:'[INFO] BUILD SUCCESS'},{channel:'shell',text:'[SUCCESS] 加壳完成，产物已保存至 target 目录'}],markdown:'# 版本说明\n\n## project 1.6.0\n\n### 新增功能\n- **项目打包看板**：自动识别工作区项目\n- feat(project): 支持原生界面与按需加载\n\n### 问题修复\n- fix(project): 任务取消后清理子进程',artifacts:{war:'D:/dev/code/fms-p275/fms-p275/fms-project-starter/target/fms-p275.war',protected:'D:/dev/code/fms-p275/fms-p275/fms-project-starter/target/fms-p275-1.6.0-202610281210.protect.war',notes:'D:/dev/code/fms-p275/fms-p275/fms-project-starter/target/fms-p275-1.6.0-202610281210.md'}},
    {id:'fail',kind:'build',project:projects[1].path,name:'wms-p277',status:'failed',phase:'Maven 构建失败，请查看日志',started:1793135000,logs:[{channel:'error',text:'依赖仓库连接超时'}],artifacts:{},branch:'develop'}],activeTask:null,
  monitor:{rows:[{dependency:'com.cyzn.fms:fms-warehouse:1.6.0',artifact:'fms-warehouse',version:'1.6.0-SNAPSHOT',job:'fms',jenkins:{status:'成功',number:218,url:'http://jenkins.example.test/job/fms'},state:'已包含远端制品',different:false,remote:{identity:'1.6.0-20261028.101500-6'}},{dependency:'com.ykeey.gaia:gaia-boot:1.0',artifact:'gaia-boot',version:'1.0-SNAPSHOT',job:'gaia',jenkins:{status:'成功',number:85},state:'有新 SNAPSHOT，尚未打入',different:true,remote:{identity:'1.0-20261028.111500-3'}}],events:['event'],notifications:[],unassociated:[]},monitorBusy:false,monitorError:''};
state.monitor.rows = [
  ['fms','fms-platform'],['fms','fms-warehouse'],['fms','fms-common'],['fms-front','fms-front'],
  ['gaia','gaia-module'],['gaia','gaia-service'],['gaia','gaia-boot'],['gaia-front','gaia-front'],
  ['gaia','gaia-service-api'],['gaia','gaia-service-redis'],
].map(([job,artifact])=>({job,artifact,dependency:'com.example:'+artifact+':1.0',version:job.startsWith('fms')?'8.27.2-SNAPSHOT':'8.56.0-SNAPSHOT',
  jenkins:{status:'成功',number:job.startsWith('fms')?65:24,url:'http://jenkins.example.test/job/'+job},
  state:artifact==='gaia-service-api'?'有新 SNAPSHOT，尚未打入':artifact==='gaia-service-redis'?'等待远端核验':'已包含远端制品',
  different:artifact==='gaia-service-api',remote:{identity:'1.0-20261028.101500-6'}}));
state.jenkinsLive={builds:[
  {jobName:'wms-platform',number:3702,result:'BUILDING',building:true,timestamp:Date.now()-90000,duration:0,estimatedDuration:180000,url:'https://jenkins.example.test/job/wms-platform/3702'},
  ...['wcs','wms-10','wms-front','gaia-front','fms','ykeey-wms-standard','wms'].map((jobName,i)=>({jobName,number:60+i,result:'SUCCESS',building:false,timestamp:Date.now()-(i+1)*3600000,duration:315000-i*30000,url:'https://jenkins.example.test/job/'+jobName})),
],runningCount:1,totalCount:28,fetchedAt:Date.now(),error:'',loading:false};
window.__fixtureState=state;
window.__fixtureCalls=[];
window.fetch=async(_url,options)=>{
 const input=JSON.parse(options.body);window.__fixtureCalls.push(input);
 if(input.operation==='start'&&window.__startError)return{ok:false,json:async()=>({ok:false,error:window.__startError})};
 if(input.operation==='select'){const project=projects.find(p=>p.path===input.data.project);state.selected={...project,target:input.data.target||project.targets[0].path};}
 if(input.operation==='settings'){Object.assign(state.config,{release:input.data.release,shell:input.data.shell});state.monitorOptions=input.data.monitorOptions;}
 if(input.operation==='start'){state.activeTask='new-'+state.tasks.length;state.tasks.unshift({id:state.activeTask,kind:input.data.kind,project:state.selected.path,name:state.selected.artifact,status:'running',phase:'Maven 构建中',started:Date.now()/1000,logs:[{channel:'build',text:'[INFO] Fixture build started'}],artifacts:{}});}
 if(input.operation==='cancel'){state.tasks[0].status='cancelled';state.tasks[0].phase='已取消';state.activeTask=null;}
 return{ok:true,json:async()=>({ok:true,value:JSON.parse(JSON.stringify(state))})};
};
let root;
const ctx={layout:{selectPanel:()=>root.unmount()},sessions:{list:{getSnapshot:()=>({byId:{}})}}};
window.__mountPanel=()=>{root=createRoot(document.getElementById('root'));root.render(<PackagePanel ctx={ctx}/>);};
window.__mountPanel();
