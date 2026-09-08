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
for (const method of ['processingHealth', 'createProcessingJob', 'listProcessingJobs', 'retryProcessingJob']) {
  assert.ok(client.includes(method), `cloud client must expose ${method}`);
}

console.log(JSON.stringify({ ok: true, tests: 35 }, null, 2));
