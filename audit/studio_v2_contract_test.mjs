import fs from 'node:fs';
import assert from 'node:assert/strict';

const html=fs.readFileSync('admin/index.html','utf8');
const js=fs.readFileSync('admin/assets/studio-v2.js','utf8');
const admin=fs.readFileSync('admin/assets/admin.js','utf8');
const checks=[
  html.includes('id="studioV2Videos"')&&html.includes(' multiple'),
  js.includes('data-row-cover'),
  js.includes('titleFrom(video.name)'),
  js.includes('Math.min(2,state.rows.length)'),
  js.includes('completePipeline'),
  js.includes('Client.retryJob'),
  js.includes('EastudyLocalProcessing.submit')&&js.includes('localProcessingCapability')&&js.includes('processingHealth'),
  !admin.includes('data-advance-job='),
  js.includes('runCloudPoll')&&((js.match(/listProcessingJobs/g)||[]).length===1),
  js.includes('开始处理')&&js.includes('只上传成品')&&js.includes('data-recover-local-input'),
  admin.includes('本步骤预计剩余')&&admin.includes('最近真实进展'),
  admin.includes('return Store.localOnly?Store.listJobs():CloudState.jobs'),
  admin.includes("path.startsWith('/videos/')"),
];
checks.forEach((value,index)=>assert.ok(value,`Studio V2 contract check ${index+1} failed`));
console.log(`Studio V2 contract: ${checks.length}/${checks.length} checks passed.`);
