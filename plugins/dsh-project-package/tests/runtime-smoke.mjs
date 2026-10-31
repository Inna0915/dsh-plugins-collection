import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
const root=path.resolve('.task-temp');
const temporary=await mkdtemp(path.join(root,'runtime-smoke-'));
const old={LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP};
Object.assign(process.env,{LOCALAPPDATA:temporary,TEMP:temporary,TMP:temporary});
const runtime=createRuntime();
try{
  const project=path.join(temporary,'project');await mkdir(project);
  await writeFile(path.join(project,'pom.xml'),'<project><artifactId>fms-p275</artifactId><packaging>pom</packaging><modules><module>fms-project-module</module><module>fms-project-starter</module></modules></project>');
  for(const [name,packaging] of [['fms-project-module','jar'],['fms-project-starter','war']]){
    await mkdir(path.join(project,name));
    await writeFile(path.join(project,name,'pom.xml'),`<project><artifactId>${name}</artifactId><packaging>${packaging}</packaging></project>`);
  }
  assert.equal(runtime.status().engineStarts,0);
  runtime.touch('runtime-smoke-lease');
  const state=await runtime.call('scan',{workspaces:[{path:project,title:'Fixture'}]});
  assert.equal(state.projects[0].artifact,'fms-p275');
  assert.equal(runtime.status().engineStarts,1);
  await runtime.release('runtime-smoke-lease');
  const deadline=Date.now()+10000;
  while(runtime.status().enginePid && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(runtime.status().enginePid,null,'idle worker should exit after closing panel');
  console.log('Real Node → frozen engine bridge and lazy idle cleanup passed.');
}finally{
  await runtime.dispose();Object.assign(process.env,old);
  if(!path.resolve(temporary).startsWith(root+path.sep))throw new Error('Unexpected cleanup target');
  await rm(temporary,{recursive:true,force:true});
}
