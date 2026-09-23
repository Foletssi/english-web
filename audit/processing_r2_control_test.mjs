import assert from 'node:assert/strict';
import { createOrImportJob, claimJob, updateJob, recordReceipts, controlAssetKey, listJobSummaries, readJob } from '../functions/_lib/r2-processing.js';
class Obj { constructor(text, etag){this.value=text;this.etag=etag;} async text(){return this.value;} }
class Bucket { constructor(){this.store=new Map();this.seq=0;this.getCalls=0;} async get(key){this.getCalls++;const item=this.store.get(key);return item?new Obj(item.body,item.etag):null;} async put(key,body,options={}){const old=this.store.get(key);if(options.onlyIf?.etagMatches && (!old||!options.onlyIf.etagMatches.includes(old.etag)))return null;const etag='etag-'+(++this.seq);this.store.set(key,{body:String(body),etag});return {etag};} }
const bucket=new Bucket(); const jobId='11111111-1111-4111-8111-111111111111';
await createOrImportJob(bucket,{id:jobId,video_id:'178995639092849',input:{kind:'local',sourceId:'s1'}});
const first=await claimJob(bucket,{workerId:'worker-a',capabilities:{localInputV1:true},localOnly:true}); assert.ok(first.job?.run_id); assert.ok(first.token);
const second=await claimJob(bucket,{workerId:'worker-b',capabilities:{localInputV1:true},localOnly:true}); assert.equal(second.job,null,'lease prevents duplicate claim');
await updateJob(bucket,jobId,first.job.run_id,first.token,'worker-a',{stage:'ASR',progress:57,work:{resumePosition:{stage:'ASR',progress:57}}});
await recordReceipts(bucket,{jobId,runId:first.job.run_id,token:first.token,workerId:'worker-a',receipts:[{path:'voice/a.mp3',size:3,sha256:'a'.repeat(64),etag:'e1'}]});
const done=await updateJob(bucket,jobId,first.job.run_id,first.token,'worker-a',{status:'REVIEW',stage:'REVIEW',progress:100,output_run_id:first.job.run_id});
const beforeList=bucket.getCalls||0;
const summaries=await listJobSummaries(bucket,500);
assert.equal(summaries.length,1);
assert.equal((bucket.getCalls||0)-beforeList,1,'list reads only the compact index, not large job results');
assert.equal(summaries[0].output_run_id,done.run_id);
assert.equal(summaries[0].receipt_count,1);
assert.equal(summaries[0].result,undefined,'list must not return full teaching content');
assert.equal((await readJob(bucket,jobId)).id,jobId,'detail remains available by job ID');assert.equal(done.status,'REVIEW'); assert.equal(done.output_run_id,done.run_id); assert.equal(done.receipt_count,1); assert.match(controlAssetKey(jobId,done.run_id,'voice/a.mp3'),new RegExp(jobId));
assert.throws(()=>controlAssetKey(jobId,done.run_id,'../bad'), error => error.message === 'OUTPUT_PATH_INVALID');
for (const file of ['../functions/api/processing/source.js','../functions/api/processing/output.js','../functions/api/processing/control.js']) { const text=await (await import('node:fs/promises')).readFile(new URL(file,import.meta.url),'utf8'); assert.equal(text.includes('supabase.co/rest/v1/rpc'),false,`${file} still depends on processing Supabase RPC`); }
console.log('PASS R2 processing control lifecycle, lease fencing, receipts and clean-break route checks');

