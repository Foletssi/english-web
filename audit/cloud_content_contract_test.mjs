import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const client = read('../shared/cloud-content.js');
const auth = read('../functions/_lib/auth.js');
const media = read('../functions/api/media.js');
const init = read('../functions/api/admin/uploads/init.js');
const complete = read('../functions/api/admin/uploads/complete.js');
const sql = read('../supabase/migrations/20260908101008_cloud_content_and_admin.sql');
const trashSql = read('../supabase/migrations/20260908183106_content_video_trash.sql');
const deletionSql = read('../supabase/migrations/20260911173000_durable_video_deletion_v1.sql');
const processingSql = read('../supabase/migrations/20260908224149_cloud_video_processing.sql');
const processingSource = read('../functions/api/processing/source.js');
const localWorkerSql = read('../supabase/migrations/20260909000631_local_cloud_worker.sql');
const recoverySql = read('../supabase/migrations/20260909131802_processing_recovery_v2.sql');
const integritySql = read('../supabase/migrations/20260909150000_content_integrity_and_job_views.sql');
const jobTitleSql = read('../supabase/migrations/20260909151000_processing_job_trash_titles.sql');
const requeueSql = read('../supabase/migrations/20260909221000_requeue_repaired_video_job.sql');
const learningPublishSql = read('../supabase/migrations/20260910193000_learning_publish_integrity_v4.sql');
const learningReextractSql = read('../supabase/migrations/20260911170000_learning_reextract_v5.sql');
const processingOutput = read('../functions/api/processing/output.js');
const processingMedia = read('../functions/api/processing/media/[[path]].js');
const edgeWorker = read('../supabase/functions/video-processing/index.ts');
const avatarUpload = read('../functions/api/admin/creator-avatars.js');
const avatarRead = read('../functions/api/creator-avatars/[[path]].js');

for (const route of ['/api/session', '/api/admin/uploads/init', '/api/admin/uploads/part', '/api/admin/uploads/complete', '/api/admin/uploads/abort', '/api/media?key=']) {
  assert.ok(client.includes(route), `client must use ${route}`);
}
assert.ok(client.includes("headers.set('Authorization', 'Bearer ' + token)"), 'admin requests must carry the active Supabase token');
assert.ok(auth.includes("'/auth/v1/user'"), 'Functions must validate the token with Supabase Auth');
assert.ok(auth.includes("'/rest/v1/rpc/is_admin'"), 'upload must use the authoritative active-admin decision');
assert.ok(media.includes("request.headers.get('Range')"), 'video delivery must support byte ranges');
assert.ok(media.includes("requireAdmin(request, env)"), 'original video delivery must reject learners and anonymous requests');
assert.ok(init.includes('createMultipartUpload'), 'large video upload must use multipart R2 upload');
assert.ok(complete.includes('upload.complete(parts)'), 'multipart upload must be explicitly completed');
assert.ok(sql.includes('private.validate_content_snapshot(p_snapshot)'), 'draft and publish RPCs must validate content');
assert.ok(sql.includes("where value->>'status' = 'PUBLISHED'"), 'student projection must exclude drafts');
assert.ok(sql.includes('revision = private.content_snapshots.revision + 1'), 'publish must atomically advance revision');
for (const rpc of ['admin_list_content_trash_v2', 'admin_trash_content_videos', 'admin_restore_content_video']) {
  assert.ok(client.includes(`'${rpc}'`), `client must call ${rpc}`);
  assert.ok((rpc.endsWith('_v2') ? deletionSql : trashSql).includes(`public.${rpc}`), `migration must define ${rpc}`);
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
assert.ok(integritySql.includes('VIDEO_REMOVAL_REQUIRES_EXPLICIT_TRASH'), 'ordinary snapshot saves must reject implicit video deletion');
assert.ok(integritySql.includes('CONTENT_EXPECTED_REVISION_REQUIRED'), 'legacy unversioned snapshot writes must be disabled');
assert.ok(integritySql.includes("'videoState'"), 'job list must expose the video relationship state');
assert.ok(integritySql.includes("video_id in ('1788926081632', '1788957611645')"), 'repair must refuse to bypass an active trash record');
assert.ok(!integritySql.toLowerCase().includes('delete from') && !integritySql.includes('VIDEO_BUCKET'), 'integrity repair must not physically delete media');
assert.ok(jobTitleSql.includes("trash.payload->'draft'->'video'"), 'deleted job titles must come from the retained trash payload');
assert.ok(requeueSql.includes("not like '%VIDEO_NOT_FOUND%'"), 'only the catalog-loss failure may be automatically requeued');
assert.ok(requeueSql.includes('REPAIRED_VIDEO_NOT_ACTIVE') && requeueSql.includes('REPAIRED_VIDEO_IN_TRASH'), 'requeue must require an active restored catalog row');
assert.ok(!requeueSql.toLowerCase().includes('delete from') && !requeueSql.includes('VIDEO_BUCKET'), 'requeue must retain media and task history');
assert.ok(processingOutput.includes('begin_processing_output_write'), 'R2 output writes must reserve an authorized database-scoped object');
const outputFenceSql = read('../supabase/migrations/20260917121000_processing_ownership_and_output_fence.sql');
assert.ok(outputFenceSql.includes('public.resolve_processing_output_v2(p_job_id,p_run_id,p_token,p_path)'), 'reservation must preserve run-scoped token authorization');
assert.ok(processingOutput.includes('MAX_ASSET_BYTES'), 'R2 output writes must be bounded');
assert.ok(processingOutput.includes("crypto.subtle.digest('SHA-256'"), 'R2 output writes must hash actual bytes');
assert.ok(processingMedia.includes("openPlaybackTicket(cookieValue(request,'eastudy_playback')"), 'processed media must require an opaque job-scoped playback ticket');
assert.ok(!processingMedia.includes('authenticate(request, env)'), 'HLS requests must not repeat full Supabase authentication per segment');
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
assert.ok(client.includes("'/api/admin/creator-avatars'"),'cloud client must upload compressed creator avatars through the admin route');
assert.ok(client.includes('uploadCreatorAvatar'),'cloud client must expose creator avatar upload');
assert.ok(avatarUpload.includes("requireAdmin(request, env)"),'creator avatar upload must require administrator authorization');
assert.ok(avatarUpload.includes("'RIFF'")&&avatarUpload.includes("'WEBP'"),'creator avatar upload must validate actual WebP signatures');
assert.ok(avatarRead.includes('authenticate(request, env)'),'creator avatar delivery must require an authenticated session');
assert.ok(!avatarUpload.toLowerCase().includes('.delete('),'creator avatar changes must not physically delete R2 objects');
assert.ok(client.includes("'admin_set_video_publication_v4'"), 'cloud client must call admin_set_video_publication_v4');
assert.ok(learningPublishSql.includes('public.admin_set_video_publication_v4'), 'learning publication migration must define admin_set_video_publication_v4');
assert.ok(client.includes("'admin_create_learning_repair_job_v5'"), 'cloud client must call admin_create_learning_repair_job_v5');
assert.ok(client.includes("p_mode:String(mode||'fill_missing')"), 'cloud client must pass the selected learning repair mode');
assert.ok(learningReextractSql.includes('public.admin_create_learning_repair_job_v5'), 'v5 migration must define learning repair creation');
assert.ok(learningReextractSql.includes("p_mode not in ('fill_missing','reextract')"), 'v5 migration must restrict learning repair modes');
assert.ok(learningPublishSql.includes('private.video_publish_issues_v4(c.draft,p_video_id)'), 'one-video publish must run the server-side learning preflight');
assert.ok(learningPublishSql.includes("where value->>'id'<>p_video_id"), 'archive must remove only the selected published video');
assert.ok(learningPublishSql.includes("coalesce(v_published->'sentences','{}'::jsonb)-p_video_id"), 'archive must remove only the selected published subtitle projection');
assert.ok(learningPublishSql.includes('LEARNING_SOURCE_CHANGED'), 'repair commit must reject stale source text');
assert.ok(!learningPublishSql.toLowerCase().includes('delete from') && !learningPublishSql.includes('VIDEO_BUCKET'), 'learning repair must never physically delete media');
assert.ok(!learningReextractSql.toLowerCase().includes('delete from') && !learningReextractSql.includes('VIDEO_BUCKET'), 'v5 learning re-extraction must never physically delete media');
assert.ok(edgeWorker.includes("'worker-complete-learning-v5'"), 'Edge worker must expose v5 text-only learning repair completion');
for (const method of ['setVideoPublication', 'createLearningRepair']) assert.ok(client.includes(method), `cloud client must expose ${method}`);

console.log(JSON.stringify({ ok: true, tests: 78 }, null, 2));
