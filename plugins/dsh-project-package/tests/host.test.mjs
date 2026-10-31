import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createRuntime} from '../src/runtime.js';
import {apply} from '../src/plugin.js';

function fakeProcess() {
  const child=new EventEmitter();child.pid=12345;child.exitCode=null;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin={write(text,callback){const input=JSON.parse(text);if(input.operation==='shutdown'){child.exitCode=0;queueMicrotask(()=>child.emit('close',0));}else queueMicrotask(()=>child.stdout.write(JSON.stringify({id:input.id,ok:true,value:{activeTask:null,operation:input.operation}})+'\n'));callback?.();}};
  child.kill=()=>{child.exitCode=1;child.emit('close',1);};
  queueMicrotask(()=>child.stdout.write('{"type":"ready"}\n'));
  return child;
}
test('runtime construction is cold; first call starts one worker, disposal closes it',async()=>{
  let starts=0;const runtime=createRuntime({spawnProcess(){starts++;return fakeProcess();}});
  assert.equal(starts,0);assert.equal(runtime.status().enginePid,null);
  runtime.touch('test-lease-123');
  assert.equal((await runtime.call('state')).operation,'state');
  await runtime.call('state');assert.equal(starts,1);
  await runtime.dispose();assert.equal(runtime.status().enginePid,null);
});
test('plugin apply registers routes without loading an engine; cross-site writes rejected',async()=>{
  const routes=new Map(), cleanups=[];
  const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')cleanups.push(dispose);},
    webServer:{register(route){routes.set(route.path,route.handler);return()=>routes.delete(route.path);}},get(){throw new Error('cold startup must not inspect workspaces');}};
  apply(ctx);
  assert.equal(routes.size,2);
  const req=new PassThrough();req.method='POST';req.headers={'content-type':'application/json',origin:'https://evil.invalid',host:'localhost:3000','sec-fetch-site':'cross-site'};
  let response;
  const res={headersSent:false,writeHead(code){this.code=code;this.headersSent=true;},end(text){response=JSON.parse(text);}};
  const finished=routes.get('/dsh-project-package/api')(req,res);req.end('{}');await finished;
  assert.equal(res.code,400);assert.match(response.error,/跨站/);
  for(const cleanup of cleanups.reverse())await cleanup();
});
