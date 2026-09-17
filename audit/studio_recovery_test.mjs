import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync('admin/assets/studio-v2.js','utf8');
let retries=0,refreshes=0,resolveRetry;
const window={
 ZoContent:{localOnly:false},
 EastudyCloudContent:{retryProcessingJob:()=>{retries++;return new Promise(resolve=>{resolveRetry=resolve})}},
 EastudyAdminCloudBridge:{refreshJobs:async()=>{refreshes++;return []}},
 dispatchEvent(){},
};
vm.runInNewContext(code,{window,document:{readyState:'loading',addEventListener(){}},
 CustomEvent:class{},setTimeout:()=>0,clearTimeout});
const studio=window.EastudyStudioV2;
const first=studio.retry('job-1',1);
await studio.retry('job-1',1);
assert.equal(retries,1,'concurrent clicks submit only once');
assert.equal(studio.isRetrying('job-1'),true);
resolveRetry({error:new Error('network')});await first;
assert.match(studio.recoveryMessage('job-1'),/请先刷新状态/);
assert.equal(studio.isRetrying('job-1'),false);
await studio.refreshJobs();
assert.equal(refreshes,1);
assert.equal(retries,1,'refresh must never submit a retry');
assert.match(studio.recoveryMessage('refresh'),/刷新不会重启任务/);
const second=studio.retry('job-1',1);resolveRetry({});await second;
assert.match(studio.recoveryMessage('job-1'),/已加入处理队列/);
assert.equal(refreshes,2,'retry reconciles through the current paged query');
window.EastudyAdminCloudBridge.refreshJobs=async()=>{throw new Error('offline')};
await studio.refreshJobs();
assert.match(studio.recoveryMessage('refresh'),/暂时无法读取/);
const third=studio.retry('job-2',2);resolveRetry({});await third;
assert.match(studio.recoveryMessage('job-2'),/请求已接受/,'sync failure cannot pretend retry was rejected');
console.log('Studio recovery: duplicate clicks, refresh, failure and accepted retry reconciliation passed.');

// A failed local intake keeps the original File and delegates same-job resume to the intake client.
const elements=new Map();
const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'Creator',dataset:{},classList:{add(){},remove(){}},textContent:'',disabled:false});return elements.get(selector)};
let uploads=0,resolveUpload,submittedFiles=[];
const uploadWindow={
 ZoContent:{localOnly:false,listCreators:()=>[{id:'creator',name:'Creator'}],saveVideo:value=>value},
 EastudyCloudContent:{
  localProcessingCapability:async()=>({data:{enabled:true}}),
  processingHealth:async()=>({data:{ready:true}}),
 },
 EastudyLocalProcessing:{capability:async()=>({}),submit:input=>{uploads++;submittedFiles.push(input.file);return new Promise((resolve,reject)=>{resolveUpload={resolve,reject}})}},
 EastudyAdminCloudBridge:{},
 dispatchEvent(){},
};
vm.runInNewContext(code.replace('global.EastudyStudioV2={','global.__uploadTest={state,submitQueue,checkService};global.EastudyStudioV2={'),{
 window:uploadWindow,document:{readyState:'loading',addEventListener(){},querySelector:element},location:{},
 CustomEvent:class{},setTimeout:()=>0,clearTimeout,
});
const upload=uploadWindow.__uploadTest;
upload.state.serviceReady=true;
upload.state.rows=[{id:'same-key',video:{name:'new.mp4',size:10},title:'New'}];
const event={preventDefault(){}};
const pending=upload.submitQueue(event);
await upload.checkService();await upload.submitQueue(event);
assert.equal(uploads,1,'checking connection cannot allow a concurrent upload');
assert.equal(element('#studioV2Submit').disabled,true);
resolveUpload.reject(new Error('response lost'));await pending;
assert.equal(upload.state.rows[0].submitted,undefined);
assert.equal(upload.state.submitting,false);
uploadWindow.EastudyStudioV2.open();
await upload.checkService();
assert.equal(upload.state.rows.length,1,'reopening preserves failed upload');
assert.equal(upload.state.rows[0].id,'same-key','reopening preserves idempotency key');
const resumed=upload.submitQueue(event);
assert.equal(uploads,2,'resume delegates to the persistent local intake client');
assert.equal(submittedFiles[0],submittedFiles[1],'retry uses the same selected original');
resolveUpload.resolve({job:{id:'job-created',video_id:1}});await resumed;
assert.equal(upload.state.rows[0].submitted,true);
console.log('Local upload recovery: concurrent submit guarded; selected original retained for intake resume.');
