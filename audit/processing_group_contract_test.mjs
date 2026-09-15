import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const migration=fs.readFileSync('supabase/migrations/20260912190000_functional_module_contracts_v3.sql','utf8');
const client=fs.readFileSync('shared/cloud-content.js','utf8');
const admin=fs.readFileSync('admin/assets/admin.js','utf8');
assert.ok(migration.includes('admin_list_processing_video_groups_v1'));
assert.ok(migration.indexOf('distinct on (video_id)') < migration.indexOf('offset (v_page-1)*v_size'));
assert.ok(migration.indexOf('offset (v_page-1)*v_size') < migration.indexOf("'records',coalesce"));
assert.match(migration,/where\s+\w+\.video_id\s*=\s*p\.video_id/);
assert.ok(migration.includes("content_video_trash"));
assert.ok(migration.includes('admin_list_processing_video_history_v1'));
assert.ok(migration.includes('admin_get_processing_job_v1'));
assert.ok(migration.includes('processing_job_admin_summary_v1'));
assert.equal(/jsonb_agg\s*\(\s*to_jsonb/i.test(migration),false,'history must not expose complete processing rows');
assert.ok(migration.includes('limit 5'));
assert.ok(client.includes("api.rpc('admin_list_processing_video_groups_v1'"));
assert.ok(client.includes("api.rpc('admin_get_processing_job_v1'"));
assert.ok(admin.includes('CloudState.videoGroups=result.groups'));
assert.ok(admin.includes('const groups=pipelineVideoGroups()'));
assert.ok(admin.includes('ProcessingView.page-1')&&admin.includes('ProcessingView.page+1'));
assert.ok(admin.includes('await Cloud.getProcessingJob(id)'));
console.log('Processing queue video-first pagination contract passed.');
let response;
const window={EastudyAuth:{client:()=>({rpc:async()=>({data:response,error:null})})}};
vm.runInNewContext(client,{window});
const valid={active:1,failed:2,review:3,completed:0,cancelled:0,total:6};
for(const [summary,accepted] of [[valid,true],[undefined,false],[{...valid,total:5},false],[{...valid,active:'1'},false],[{...valid,active:-1,total:4},false]]){
  response={items:[],summary,total:6,page:2,pageSize:1};
  const result=await window.EastudyCloudContent.listProcessingJobs(2,1);
  assert.equal(Boolean(result.summary),accepted,'invalid or missing totals must remain unknown');
  if(accepted)assert.equal(result.summary.total,6,'global counts survive an empty page');
}
console.log('Global processing summary response validation passed.');
