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
const second=studio.retry('job-1',1);resolveRetry({});await second;
assert.match(studio.recoveryMessage('job-1'),/已加入处理队列/);
assert.equal(refreshes,2,'retry reconciles through the current paged query');
window.EastudyAdminCloudBridge.refreshJobs=async()=>{throw new Error('offline')};
await studio.refreshJobs();
assert.match(studio.recoveryMessage('refresh'),/暂时无法读取/);
const third=studio.retry('job-2',2);resolveRetry({});await third;
assert.match(studio.recoveryMessage('job-2'),/请求已接受/,'sync failure cannot pretend retry was rejected');
console.log('Studio recovery: duplicate clicks, refresh, failure and accepted retry reconciliation passed.');

// Model a successful server commit whose response was lost, then resume the same upload.
const elements=new Map();
const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'Creator',dataset:{},classList:{add(){},remove(){}},textContent:'',disabled:false});return elements.get(selector)};
let uploads=0,creates=0,serverRevision=1,clientRevision=1,resolveUpload,existingJob=null;
const uploadWindow={
 ZoContent:{localOnly:false,listCreators:()=>[{id:'creator',name:'Creator'}],saveVideo:value=>value},
 EastudyCloudContent:{
  uploadVideo:()=>{uploads++;return new Promise(resolve=>{resolveUpload=resolve})},
  createProcessingJob:async(video,key,idempotency,revision)=>{
   creates++;if(revision!==serverRevision)return {error:new Error('CONTENT_REVISION_CONFLICT')};
   if(!existingJob){existingJob={id:'job-created',idempotency};serverRevision++;throw new Error('response lost')}
   assert.equal(existingJob.idempotency,idempotency);return {data:{job:existingJob,revision:serverRevision,snapshot:{}}};
  },
  pullAdmin:async()=>({revision:serverRevision}),
  processingHealth:async()=>({data:{ready:true}}),
 },
 EastudyAdminCloudBridge:{flush:async()=>{},revision:()=>clientRevision,importMutation:r=>{clientRevision=r.data.revision}},
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
resolveUpload({key:'source',url:'source.mp4',size:10});await pending;
assert.equal(upload.state.rows[0].submitted,undefined);
assert.equal(upload.state.submitting,false);
uploadWindow.EastudyStudioV2.open();
await upload.checkService();
assert.equal(upload.state.rows.length,1,'reopening preserves failed upload');
assert.equal(upload.state.rows[0].id,'same-key','reopening preserves idempotency key');
assert.ok(upload.state.rows[0].uploaded,'reopening preserves completed upload');
await upload.submitQueue(event);
assert.equal(uploads,1,'resume reuses uploaded source');
assert.equal(creates,3,'stale revision reconciles once using the same idempotency key');
assert.equal(upload.state.rows[0].submitted,true);
assert.equal(clientRevision,serverRevision);
console.log('Upload recovery: concurrent submit guarded; lost response reconciled without re-upload.');
