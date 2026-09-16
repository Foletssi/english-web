import assert from 'node:assert/strict';
import { onRequestPut } from '../functions/api/processing/output.js';
import { runDeletionWorker } from '../functions/api/admin/video-deletions/[[path]].js';

// In-memory R2 and RPCs only. Never connects to production or deletes real media.
const job = '00000000-0000-4000-8000-000000000001';
const key = `videos/fixture/processed/${job}/540p/segment_00001.ts`;
const lease = { id: 'delete-fixture', token: 'lease-fixture', sourceKeys: [], outputPrefixes: [`videos/fixture/processed/${job}/`] };
const request = () => new Request(`https://fixture/api/processing/output?job=${job}&token=${'x'.repeat(64)}&path=540p/segment_00001.ts`, {
  method: 'PUT', headers: { 'content-length': '3' }, body: new Uint8Array([1, 2, 3])
});

function fixture(options = {}) {
  const receipts = new Map(), uploads = new Map(), objects = new Map(), staged = new Set(), calls = [];
  let seq = 0, deletionConfirmed = false, ackFailures = options.ackFailures || 0;
  const bucket = {
    async createMultipartUpload(objectKey) {
      const uploadId = 'upload-' + ++seq;
      const upload = {
        uploadId, active: true,
        async uploadPart() {
          calls.push('part');
          if (options.beforePart) await options.beforePart();
          if (!upload.active) throw new Error('NoSuchUpload');
          return { partNumber: 1, etag: 'part-etag' };
        },
        async complete() {
          calls.push('complete');
          if (!upload.active) throw new Error('NoSuchUpload');
          objects.set(objectKey, 3); upload.active = false;
          return { etag: 'completed-etag', size: 3 };
        },
        async abort() {
          calls.push('abort');
          if (options.abortFails) throw new Error('R2 offline');
          upload.active = false;
        }
      };
      uploads.set(uploadId, upload);
      return upload;
    },
    resumeMultipartUpload(objectKey, id) { assert.equal(objectKey, key); return uploads.get(id); },
    async head(objectKey) { return objects.has(objectKey) ? { size: objects.get(objectKey) } : null; },
    async list({ prefix }) { calls.push('inventory'); return { objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })) }; },
    async delete(keys) { calls.push('delete'); for (const k of keys) objects.delete(k); }
  };
  globalThis.fetch = async (url, init) => {
    const name = String(url).split('/').at(-1), input = JSON.parse(init.body);
    calls.push(name); assert.ok(init.signal, 'RPCs must have a bounded deadline');
    let result = { ok: true };
    if (name.startsWith('resolve_processing_output')) result = [{ object_key: key }];
    if (name === 'begin_processing_output_write') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-service');
      if (options.rejectBegin || deletionConfirmed) return Response.json({ message: 'VIDEO_PERMANENT_DELETION_STARTED' }, { status: 400 });
      result = { object_key: key, write_id: 'write-' + seq };
      receipts.set(result.write_id, { id: result.write_id, objectKey: key, uploadId: input.p_upload_id });
      if (options.loseBeginResponse) throw new Error('response lost');
    }
    if (name === 'finish_processing_output_write') {
      if (ackFailures-- > 0) return Response.json({ message: 'database unavailable' }, { status: 503 });
      receipts.delete(input.p_write_id);
    }
    if (name === 'deletion_claim_job') { deletionConfirmed = true; result = lease; }
    if (name === 'deletion_pending_output_writes') result = [...receipts.values()];
    if (name === 'deletion_assert_lease' && receipts.size) return Response.json({ message: 'DELETION_OUTPUT_WRITES_PENDING' }, { status: 400 });
    if (name === 'deletion_stage_items') for (const item of input.p_items) staged.add(item.objectKey);
    if (name === 'deletion_next_items') result = [...staged].map(objectKey => ({ objectKey, objectBytes: 3 }));
    if (name === 'deletion_ack_items') for (const k of input.p_object_keys) staged.delete(k);
    if (name === 'deletion_finalize_job') { assert.equal(receipts.size, 0); result = { state: 'DONE' }; }
    return Response.json(result);
  };
  return { env: { VIDEO_BUCKET: bucket, SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', VIDEO_DELETION_ENABLED: 'true' }, receipts, uploads, objects, calls };
}

let f = fixture({ ackFailures: 2 });
let response = await onRequestPut({ request: request(), env: f.env });
assert.equal(response.status, 200);
assert.equal(f.receipts.size, 0);
assert.equal(f.calls.filter(x => x === 'finish_processing_output_write').length, 3);
assert.ok(!JSON.stringify(await response.json()).includes('write-'), 'server receipt must never leak');

// A committed output whose confirmation was lost is recovered before inventory.
f = fixture({ ackFailures: 3 });
assert.equal((await onRequestPut({ request: request(), env: f.env })).status, 503);
assert.equal(f.receipts.size, 1); assert.equal(f.objects.size, 1);
assert.equal((await runDeletionWorker(f.env)).state, 'DONE');
assert.equal(f.receipts.size, 0); assert.equal(f.objects.size, 0);
assert.ok(f.calls.indexOf('abort') < f.calls.indexOf('inventory'));

// Begin committed but its response vanished; abort/recovery are idempotent.
f = fixture({ loseBeginResponse: true });
assert.equal((await onRequestPut({ request: request(), env: f.env })).status, 503);
assert.ok(!f.calls.includes('part'));
assert.equal(f.receipts.size, 1);
assert.equal((await runDeletionWorker(f.env)).state, 'DONE');
assert.equal(f.receipts.size, 0);

// Deletion wins while the output route is suspended before uploading bytes.
let releasePart, reachedPart;
const partReached = new Promise(resolve => { reachedPart = resolve; });
const partGate = new Promise(resolve => { releasePart = resolve; });
f = fixture({ beforePart: async () => { reachedPart(); await partGate; } });
const output = onRequestPut({ request: request(), env: f.env });
await partReached;
assert.equal((await runDeletionWorker(f.env)).state, 'DONE');
releasePart();
assert.equal((await output).status, 503);
assert.equal(f.objects.size, 0, 'late output must not recreate a deleted object');

// An uncertain abort never permits inventory, deletion or finalization.
f = fixture({ ackFailures: 3, abortFails: true });
await onRequestPut({ request: request(), env: f.env });
await assert.rejects(runDeletionWorker(f.env), /R2 offline/);
assert.equal(f.receipts.size, 1);
assert.ok(!f.calls.includes('inventory')); assert.ok(!f.calls.includes('delete'));

f = fixture({ rejectBegin: true });
assert.equal((await onRequestPut({ request: request(), env: f.env })).status, 503);
assert.ok(!f.calls.includes('part')); assert.ok(f.calls.includes('abort'));
console.log('Output recovery: completion, lost responses, abort fencing, replay and failed abort isolation passed.');
