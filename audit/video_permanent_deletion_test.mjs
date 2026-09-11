import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const file = 'functions/api/admin/video-deletions/[[path]].js';
const source = fs.readFileSync(file, 'utf8')
  .replace(/^import .*?;\r?\n/, '')
  .replaceAll('export async function ', 'async function ')
  .concat('\nglobalThis.__runDeletionWorker=runDeletionWorker;');

const objects = new Map([
  ['videos/upload-a/source.mp4', 1000],
  ['videos/upload-a/processed/job-a/runs/run-a/720p/index.m3u8', 120],
  ['videos/upload-a/processed/job-a/runs/run-a/720p/segment_00000.ts', 880],
  ['videos/shared/source.mp4', 5000]
]);
const calls = [];
const staged = new Map();
const lease = {
  id: '00000000-0000-0000-0000-000000000001',
  token: '00000000-0000-0000-0000-000000000002',
  sourceKeys: ['videos/upload-a/source.mp4'],
  outputPrefixes: ['videos/upload-a/processed/job-a/']
};
const fetch = async (url,init={}) => {
  const name = String(url).split('/').at(-1);
  calls.push(name);
  const body=JSON.parse(init.body||'{}');
  if(name==='deletion_stage_items')for(const item of body.p_items||[])staged.set(item.objectKey,item.objectBytes);
  if(name==='deletion_ack_items')for(const key of body.p_object_keys||[])staged.delete(key);
  const value = name === 'deletion_claim_job' ? lease
    : name === 'deletion_next_items' ? [...staged].slice(0,body.p_limit||200).map(([objectKey,objectBytes])=>({objectKey,objectBytes}))
    : { ok: true, state: name === 'deletion_finalize_job' ? 'DONE' : undefined };
  return { ok: true, async json(){ return value; } };
};
const bucket = {
  async head(key){ const size=objects.get(key); return size == null ? null : { size }; },
  async list({prefix,limit}){ return { objects:[...objects].filter(([key])=>key.startsWith(prefix)).slice(0,limit).map(([key,size])=>({key,size})) }; },
  async delete(keys){ for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key); }
};
const context = vm.createContext({ console, fetch, URL, setTimeout, clearTimeout,
  authenticate(){}, json(){}, readJson(){}, requireBucket(env){return env.VIDEO_BUCKET?null:{};} });
vm.runInContext(source, context, { filename: file });
const result = await context.__runDeletionWorker({
  VIDEO_BUCKET: bucket, SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key'
  ,VIDEO_DELETION_ENABLED: 'true'
});
assert.equal(result.state, 'DONE');
assert.deepEqual([...objects.keys()], ['videos/shared/source.mp4']);
assert.ok(calls.includes('deletion_stage_items'));
assert.ok(calls.includes('deletion_ack_items'));
assert.ok(calls.includes('deletion_assert_lease'));
assert.equal(calls.at(-1), 'deletion_finalize_job');

const migration = fs.readFileSync('supabase/migrations/20260911173000_durable_video_deletion_v1.sql', 'utf8');
for (const required of ['admin_plan_permanent_video_delete','admin_confirm_permanent_video_delete','deletion_claim_job','deletion_finalize_job','content_video_trash','admin_list_content_trash_v2','VIDEO_PERMANENT_DELETION_STARTED','video_deletion_items','deletion_ack_items','DELETION_INVENTORY_INCOMPLETE']) assert.ok(migration.includes(required));
assert.ok(!/create\s+or\s+replace\s+function\s+public\.admin_list_content_trash\(\)/i.test(migration), 'legacy trash RPC return type must not be replaced');
assert.ok(!/set\s+state='NEEDS_ATTENTION',last_error_code='PLAN_EXPIRED'/i.test(migration), 'expired unconfirmed plans must be refreshed in place');
assert.match(migration, /d\.confirmed_at\s+is\s+not\s+null[\s\S]+VIDEO_PERMANENT_DELETION_STARTED/i, 'confirmed deletion must fence restore');
assert.ok(!/delete\s+from\s+public\.processing_jobs\s*;/i.test(migration), 'job deletion must always be scoped');
assert.ok(migration.includes("ref.video->>'mediaKey'=target.object_key"), 'active snapshot references must preserve shared source objects');
assert.ok(migration.includes("other_trash.payload#>>'{draft,video,mediaKey}'=target.object_key"), 'restorable trash references must preserve shared source objects');
console.log('Permanent deletion: exact R2 keys, shared source preservation and durable finalize contract passed.');
