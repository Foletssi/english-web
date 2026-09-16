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
