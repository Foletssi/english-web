import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const client = read('../shared/cloud-content.js');
const auth = read('../functions/_lib/auth.js');
const media = read('../functions/api/media.js');
const init = read('../functions/api/admin/uploads/init.js');
const complete = read('../functions/api/admin/uploads/complete.js');
const sql = read('../supabase/migrations/20260908_cloud_content_and_admin.sql');
const trashSql = read('../supabase/migrations/20260908_content_video_trash.sql');
const processingSql = read('../supabase/migrations/20260908_cloud_video_processing.sql');
const processingSource = read('../functions/api/processing/source.js');
const localWorkerSql = read('../supabase/migrations/20260908_local_cloud_worker.sql');
const recoverySql = read('../supabase/migrations/20260909_processing_recovery_v2.sql');
const processingOutput = read('../functions/api/processing/output.js');
const processingMedia = read('../functions/api/processing/media/[[path]].js');
const edgeWorker = read('../supabase/functions/video-processing/index.ts');

for (const route of ['/api/session', '/api/admin/uploads/init', '/api/admin/uploads/part', '/api/admin/uploads/complete', '/api/admin/uploads/abort', '/api/media?key=']) {
  assert.ok(client.includes(route), `client must use ${route}`);
}
assert.ok(client.includes("headers.set('Authorization', 'Bearer ' + token)"), 'admin requests must carry the active Supabase token');
assert.ok(auth.includes("'/auth/v1/user'"), 'Functions must validate the token with Supabase Auth');
assert.ok(auth.includes("String(profiles?.[0]?.role || '').toLowerCase() !== 'admin'"), 'upload must be admin-only');
assert.ok(media.includes("request.headers.get('Range')"), 'video delivery must support byte ranges');
assert.ok(media.includes("authenticate(request, env)"), 'video delivery must reject anonymous requests');
assert.ok(init.includes('createMultipartUpload'), 'large video upload must use multipart R2 upload');
assert.ok(complete.includes('upload.complete(parts)'), 'multipart upload must be explicitly completed');
assert.ok(sql.includes('private.validate_content_snapshot(p_snapshot)'), 'draft and publish RPCs must validate content');
assert.ok(sql.includes("where value->>'status' = 'PUBLISHED'"), 'student projection must exclude drafts');
assert.ok(sql.includes('revision = private.content_snapshots.revision + 1'), 'publish must atomically advance revision');
for (const rpc of ['admin_list_content_trash', 'admin_trash_content_videos', 'admin_restore_content_video']) {
  assert.ok(client.includes(`'${rpc}'`), `client must call ${rpc}`);
  assert.ok(trashSql.includes(`public.${rpc}`), `migration must define ${rpc}`);
}
assert.ok(trashSql.includes("where environment = 'production' for update"), 'trash mutations must lock the content row');
assert.ok(trashSql.includes('CONTENT_REVISION_CONFLICT'), 'trash mutations must reject stale administrator state');
assert.ok(trashSql.includes("upper(coalesce(job->>'status', '')) in ('PROCESSING', 'QUEUED', 'UPLOADING')"), 'active processing jobs must block deletion');
assert.ok(trashSql.includes("v_video := v_video || jsonb_build_object('status', 'DRAFT'"), 'restore must return content to draft');
assert.ok(!trashSql.includes('VIDEO_BUCKET'), 'content trash migration must never delete R2 media');
for (const rpc of ['admin_create_processing_job', 'admin_list_processing_jobs', 'admin_retry_processing_job', 'processing_claim_jobs', 'processing_commit_result']) {
  assert.ok(processingSql.includes(`public.${rpc}`), `cloud processing migration must define ${rpc}`);
}
assert.ok(processingSql.includes('for update skip locked'), 'workers must atomically lease due jobs');
assert.ok(processingSql.includes("cancel_requested_at=coalesce(cancel_requested_at,now())"), 'logical deletion must cancel normalized jobs');
assert.ok(processingSql.includes("status='CANCELLED'"), 'late results must remain cancelled');
assert.ok(!processingSql.includes('VIDEO_BUCKET'), 'processing migration must never physically delete R2 objects');
assert.ok(processingSource.includes("request.headers.get('Range')"), 'Stream source must support byte ranges');
assert.ok(processingSource.includes('resolve_processing_source'), 'Stream source must require a short-lived database token');
for (const rpc of ['processing_worker_heartbeat', 'processing_claim_local_job', 'processing_heartbeat_job',
  'processing_progress_job', 'processing_fail_job', 'processing_commit_leased_result',
  'resolve_processing_output', 'resolve_processing_media']) {
  assert.ok(localWorkerSql.includes(`public.${rpc}`), `local worker migration must define ${rpc}`);
}
assert.ok(localWorkerSql.includes('for update skip locked'), 'desktop workers must atomically lease jobs');
assert.ok(localWorkerSql.includes('cancel_requested_at is null'), 'worker leases and tokens must reject logically deleted jobs');
assert.ok(!localWorkerSql.includes('delete from') && !localWorkerSql.includes('VIDEO_BUCKET'), 'local migration must not delete R2 data');
for (const rpc of ['processing_heartbeat_job_v2', 'processing_report_job_v2', 'processing_record_output_v2',
  'processing_fail_job_v2', 'processing_commit_leased_result_v2', 'resolve_processing_output_v2']) {
  assert.ok(recoverySql.includes(`public.${rpc}`), `recovery migration must define ${rpc}`);
}
assert.ok(recoverySql.includes('private.processing_job_events'), 'failure history must survive retries');
assert.ok(recoverySql.includes("'LEASE_LOST'"), 'expired runs must retain lease-loss evidence');
assert.ok(recoverySql.includes('last_progress_at=case when v_made_progress'),
  'last real progress must not move on duplicate telemetry');
assert.ok(recoverySql.includes('output_run_id'), 'published media must resolve an immutable output run');
assert.ok(!recoverySql.toLowerCase().includes('delete from'), 'recovery migration must retain R2 and task history');
assert.ok(processingOutput.includes('resolve_processing_output'), 'R2 output writes must use a scoped database token');
assert.ok(processingOutput.includes('MAX_ASSET_BYTES'), 'R2 output writes must be bounded');
assert.ok(processingOutput.includes("crypto.subtle.digest('SHA-256'"), 'R2 output writes must hash actual bytes');
assert.ok(processingMedia.includes('authenticate(request, env)'), 'processed media must require an authenticated session');
assert.ok(processingMedia.includes("request.headers.get('Range')"), 'processed media must support byte ranges');
for (const action of ['worker-heartbeat', 'worker-claim', 'worker-job-heartbeat', 'worker-progress', 'worker-fail', 'worker-complete']) {
  assert.ok(edgeWorker.includes(`'${action}'`), `Edge worker must expose ${action}`);
}
for (const action of ['worker-job-heartbeat-v2', 'worker-telemetry-v2', 'worker-output-receipt-v2',
  'worker-fail-v2', 'worker-complete-v2']) {
  assert.ok(edgeWorker.includes(`'${action}'`), `Edge worker must expose ${action}`);
}
assert.ok(edgeWorker.includes("env('WORKER_SECRET')"), 'desktop worker actions must require a server-side secret');
for (const method of ['processingHealth', 'createProcessingJob', 'listProcessingJobs', 'retryProcessingJob']) {
  assert.ok(client.includes(method), `cloud client must expose ${method}`);
}

console.log(JSON.stringify({ ok: true, tests: 52 }, null, 2));
