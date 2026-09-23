import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const requests=[];
const context={
  window:{EastudyAuth:{client:()=>({auth:{getSession:async()=>({data:{session:{access_token:'admin-token'}}})}})}},
  Headers, URLSearchParams, setTimeout, clearTimeout,
  fetch:async (path, init={})=>{
    requests.push({path,init});
    if(path.includes('action=list'))return {ok:true,json:async()=>({rows:Array.from({length:60},(_,i)=>({id:'job-'+i,video_id:i+1,status:'REVIEW',stage:'REVIEW'})),total:60})};
    return {ok:true,json:async()=>({data:{id:'job-a'},ready:true})};
  }
};
vm.runInNewContext(readFileSync('shared/cloud-content.js','utf8'),context);
const cloud=context.window.EastudyCloudContent;
await cloud.processingHealth();
await cloud.createProcessingJob({id:42},'videos/source.mp4','request-a');
await cloud.reserveLocalProcessingJob({video:{id:42},source:{sourceId:'source-a'},requestId:'request-b'});
await cloud.getLocalProcessingInput('job-a');
await cloud.recoverLocalProcessingInput({jobId:'job-a',source:{sourceId:'source-a'}});
await cloud.retryProcessingJob('job-a');
await cloud.controlProcessingJob({id:'job-a',action:'cancel'});
const listing=await cloud.listProcessingJobs(2,50);
assert.equal(requests.length,8);
assert.equal(listing.rows.length,60,'reconciliation scans all available jobs, not just visible page');
assert.equal(listing.groups.length,10,'visible page retains its own pagination');
assert.equal(listing.groups[0].current.id,'job-50');
assert.equal(listing.total,60);
for(const {path,init} of requests){
  assert.match(path,/^\/api\/admin\/processing-control/);
  assert.equal(init.headers.get('Authorization'),'Bearer admin-token','every admin control request must authenticate');
}
assert.ok(requests.at(-1).path.endsWith('limit=500'));
assert.deepEqual(requests.filter(x=>x.init.method==='POST').map(x=>JSON.parse(x.init.body).action),
  ['create','create','recover','retry','cancel']);
console.log('PASS authenticated processing health, create, local input, recover, retry and cancel');