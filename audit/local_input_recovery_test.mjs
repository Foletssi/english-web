import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const sourceCode=fs.readFileSync('admin/assets/local-processing-client.js','utf8');
const saved=new Map(),calls=[];
let enabled=false,newReservations=0,recoveries=0,failNext=false,serverHash='a'.repeat(64);
const reservation={job:{id:'existing-job',video_id:'42'},inputSource:{sourceId:'same-source'},intakeTicket:'ephemeral'};
const window={
 EastudyAuth:{client:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'admin'}}}})}})},
 EastudyCloudContent:{
  localProcessingCapability:async()=>({data:{enabled}}),
  recoverLocalProcessingInput:async input=>{
   recoveries++;calls.push(input);
   if(input.source.sha256!==serverHash)return {error:new Error('SOURCE_DECLARATION_CONFLICT')};
   if(failNext){failNext=false;throw new Error('response lost')}
   return {data:reservation};
  },
 },
 EastudyAdminCloudBridge:{reserveLocal:async()=>{newReservations++;return {data:reservation}}},
};
class HashWorker{postMessage(){queueMicrotask(()=>this.onmessage({data:{sha256:'a'.repeat(64)}}))}terminate(){}}
const fetch=async url=>({ok:true,json:async()=>url.endsWith('/capability')?{protocolVersion:1,ready:true,workerId:'worker-1',challenge:'challenge'}:{state:'READY'}});
vm.runInNewContext(sourceCode,{window,document:{currentScript:{src:'https://test/admin/assets/local-processing-client.js'}},
 URL,Worker:HashWorker,crypto:webcrypto,location:{origin:'https://test'},AbortController,fetch,setTimeout,clearTimeout,
 localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
});
const file={name:'original.mp4',size:100};
await assert.rejects(window.EastudyLocalProcessing.submit({file,video:{}}),/正在更新/);
assert.equal(newReservations,0,'disabled flag cannot create new task');
await window.EastudyLocalProcessing.submit({file,recoveryJobId:'existing-job'});
assert.equal(recoveries,1,'existing task can recover with new intake flag disabled');
assert.equal(calls[0].jobId,'existing-job');
assert.equal(calls[0].workerId,'worker-1');
assert.equal(newReservations,0,'recovery must not reserve another task');
assert.equal(JSON.parse([...saved.values()][0]).jobId,'existing-job','durable receipt survives completion');
failNext=true;
await assert.rejects(window.EastudyLocalProcessing.submit({file,recoveryJobId:'existing-job'}),/response lost/);
await window.EastudyLocalProcessing.submit({file,recoveryJobId:'existing-job'});
assert.ok(calls.every(call=>call.jobId==='existing-job'));
serverHash='b'.repeat(64);
await assert.rejects(window.EastudyLocalProcessing.submit({file,recoveryJobId:'existing-job'}),error=>error.code==='SOURCE_DECLARATION_CONFLICT'&&/原任务不一致/.test(error.message));
assert.equal(newReservations,0,'wrong file cannot fall back to new task');
assert.ok([...saved.values()].every(value=>!value.includes('ephemeral')),'intake tickets are never persisted');
console.log('Local input recovery: feature gate, same-job reselect, lost response, SHA mismatch and ticket privacy passed.');
