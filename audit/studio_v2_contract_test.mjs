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
  admin.includes('关闭网页也会继续处理'),
  !admin.includes('data-advance-job='),
];
checks.forEach((value,index)=>assert.ok(value,`Studio V2 contract check ${index+1} failed`));
console.log(`Studio V2 contract: ${checks.length}/${checks.length} checks passed.`);
