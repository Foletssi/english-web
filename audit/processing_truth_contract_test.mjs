import fs from 'node:fs';
import assert from 'node:assert/strict';

const cloud=fs.readFileSync('shared/cloud-content.js','utf8');
const admin=fs.readFileSync('admin/assets/admin.js','utf8');
const studio=fs.readFileSync('admin/assets/studio-v2.js','utf8');
const worker=fs.readFileSync('services/cloud-worker/worker.py','utf8');
const sql=fs.readFileSync('supabase/migrations/20260910170000_processing_truth_and_recovery_v3.sql','utf8');

const checks=[
  cloud.includes("LOCAL_DOWNLOAD: 'download'")&&cloud.includes("LOCAL_UPLOAD: 'output'"),
  !cloud.includes("['QUEUED', 'RUNNING', 'WAITING'].includes(job.status) ? 'PROCESSING'"),
  admin.includes("QUEUED:'排队中'")&&admin.includes("RUNNING:'运行中'"),
  admin.includes("value===null||value===undefined||value===''"),
  admin.includes("code:'NODE_OFFLINE'")&&admin.includes("code:'CONTACT_LOST'")&&admin.includes("code:'SYNC_UNKNOWN'"),
  admin.includes("path.startsWith('/pipeline/jobs/')")&&admin.includes("path==='/dashboard'"),
  studio.includes("processingHealth()")&&studio.includes("health:healthResult?.data||null"),
  worker.includes("JOB_LEASE_LOST_OR_CANCELLED")&&worker.includes("cancelled.is_set()"),
  sql.includes('automatic_recovery_count')&&sql.includes('max_automatic_recoveries'),
  sql.includes("'leaseUntil',j.lease_until")&&sql.includes("'nextRunAt',j.next_run_at"),
  !/delete\s+from\s+.*r2/i.test(sql)&&!sql.includes('delete_object'),
];
checks.forEach((value,index)=>assert.ok(value,`Processing truth contract check ${index+1} failed`));
console.log(`Processing truth contract: ${checks.length}/${checks.length} checks passed.`);
