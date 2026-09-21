import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const studio=readFileSync('admin/assets/studio-v2.js','utf8');
const sql=readFileSync('supabase/migrations/20260921135000_processing_video_content_read.sql','utf8');
assert.match(sql,/admin_get_processing_video_content_v1/);
assert.match(sql,/public\.is_admin\(\)/);
assert.match(sql,/c\.draft->'sentences'->p_video_id/);
assert.doesNotMatch(sql,/c\.published/);

const rows=[
 {id:'job-a',videoId:1,status:'REVIEW',runId:'run-a',updatedAt:'done-a'},
 {id:'job-b',videoId:2,status:'REVIEW',runId:'run-b',updatedAt:'done-b'}
];
const targeted=[];let full=0;
const window={ZoContent:{localOnly:false},location:{hash:'#/videos'},navigator:{onLine:true},
 EastudyAdminCloudBridge:{isAuthenticated:()=>true,refreshJobs:async()=>rows,
  refreshVideoContent:async id=>{targeted.push(String(id));return true},
  refreshContent:async()=>{full++;return true}},dispatchEvent(){}};
vm.runInNewContext(studio.replace("if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();",''),{
 window,document:{hidden:false,readyState:'complete',addEventListener(){},querySelector(){return null}},CustomEvent:class{},setTimeout:()=>0,clearTimeout});
await window.EastudyStudioV2.syncJobs();
assert.deepEqual(targeted.sort(),['1','2']);
assert.equal(full,0,'terminal jobs should not reload the multi-megabyte global snapshot');
await window.EastudyStudioV2.syncJobs();
assert.equal(targeted.length,2,'unchanged terminal jobs are not fetched repeatedly');
await window.EastudyStudioV2.refreshJobs();
assert.equal(full,1,'manual refresh still has a full-snapshot recovery path');
console.log('PASS terminal jobs use bounded per-video content refresh with full refresh fallback');
