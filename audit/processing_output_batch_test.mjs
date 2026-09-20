import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequestPost } from '../functions/api/processing/output.js';

// Memory-only R2/RPC fixture. Never connects to production or deletes media.
const job = '00000000-0000-4000-8000-000000000001';
const run = '00000000-0000-4000-8000-000000000002';
const endpoint = `https://fixture/api/processing/output?job=${job}&run=${run}&token=${'x'.repeat(64)}`;
const digest = data => createHash('sha256').update(data).digest('hex');
const objectKey = path => `videos/fixture/processed/${job}/${path}`;
function item(text, bytes = Buffer.from(text)) {
  return { path: `voice/${digest(Buffer.from(text))}.mp3`, size: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') };
}
function request(items, options = {}) {
  const body = options.body ?? JSON.stringify({ items });
  return new Request(options.url || endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(options.length ?? Buffer.byteLength(body)) }, body
  });
}
function fixture(options = {}) {
  const objects = new Map(), receipts = new Map(), uploads = [], calls = [];
  let sequence = 0, activeParts = 0, maxActiveParts = 0;
  const bucket = {
    async head(key) { calls.push({ name: 'head', key }); return objects.get(key) || null; },
    async createMultipartUpload(key, metadata) {
      calls.push({ name: 'create', key });
      const uploadId = `upload-${++sequence}`;
      let bytes, active = true;
      const upload = {
        uploadId,
        async uploadPart(partNumber, data) {
          calls.push({ name: 'part', key });
          assert.ok(active); assert.equal(partNumber, 1);
          activeParts += 1; maxActiveParts = Math.max(maxActiveParts, activeParts);
          try {
            await new Promise(resolve => setTimeout(resolve, 5));
            if (key === objectKey(options.failPartPath)) throw new Error('R2 write failed');
            bytes = Buffer.from(data);
            return { partNumber, etag: `part-${uploadId}` };
          } finally { activeParts -= 1; }
        },
        async complete() {
          calls.push({ name: 'complete', key }); assert.ok(active); active = false;
          const stored = { size: bytes.length, etag: `etag-${uploadId}`, customMetadata: metadata.customMetadata };
          objects.set(key, stored); return stored;
        },
        async abort() { calls.push({ name: 'abort', key }); active = false; }
      };
      uploads.push(upload); return upload;
    }
  };
  globalThis.fetch = async (url, init) => {
    const name = String(url).split('/').at(-1), input = JSON.parse(init.body);
    calls.push({ name, input });
    assert.ok(init.signal, 'each RPC has a deadline');
    assert.equal(input.p_run_id ?? run, run, 'current-run authorization must be retained');
    if (name === 'resolve_processing_outputs_v3') {
      assert.equal(input.p_job_id, job); assert.equal(input.p_token, 'x'.repeat(64));
      return Response.json({ outputs: input.p_paths.map(path => ({ path, object_key: objectKey(path) })) });
    }
    if (name === 'begin_processing_output_writes_v3') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-service');
      const writes = input.p_items.map(item => {
        const write_id = `write-${item.uploadId}`;
        receipts.set(write_id, item);
        return { path: item.path, object_key: objectKey(item.path), write_id };
      });
      return Response.json({ writes });
    }
    if (name === 'finish_processing_output_writes_v3') {
      for (const id of input.p_write_ids) receipts.delete(id);
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected RPC ${name}`);
  };
  return { objects, receipts, uploads, calls, maxActiveParts: () => maxActiveParts,
    env: { VIDEO_BUCKET: bucket, SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service' } };
}
async function rejectsBeforeStorage(items, label, options = {}) {
  const f = fixture();
  const response = await onRequestPost({ request: request(items, options), env: f.env });
  assert.ok(response.status >= 400 && response.status < 500, `${label}: rejects invalid batch`);
  assert.equal(f.uploads.length, 0, `${label}: no multipart upload allocated`);
  assert.equal(f.objects.size, 0, `${label}: no object stored`);
}

const originalFetch = globalThis.fetch;
try {
  const good = item('laundry'), other = item('gonna');
  await rejectsBeforeStorage([], 'empty batch');
  await rejectsBeforeStorage(Array.from({ length: 33 }, (_, n) => item(`word-${n}`)), 'count limit');
  await rejectsBeforeStorage([good, good], 'duplicate paths');
  for (const path of ['../voice/x.mp3', `voice/../${'a'.repeat(64)}.mp3`, `540p/${'a'.repeat(64)}.mp3`, `voice/${'a'.repeat(63)}.mp3`, `voice/${'a'.repeat(64)}.mp3/extra`]) {
    await rejectsBeforeStorage([good, { ...other, path }], `unsafe path ${path}`);
  }
  await rejectsBeforeStorage([good, { ...other, size: other.size + 1 }], 'size mismatch');
  await rejectsBeforeStorage([good, { ...other, sha256: '0'.repeat(64) }], 'digest mismatch');
  for (const data of ['!!!!', 'AA=A', 'bGF1bmRyeQ== junk']) {
    await rejectsBeforeStorage([good, { ...other, data }], 'invalid base64');
  }
  await rejectsBeforeStorage([item('large', Buffer.alloc(1024 * 1024 + 1))], 'per-file raw limit');
  await rejectsBeforeStorage([item('one', Buffer.alloc(1024 * 1024)), item('two', Buffer.alloc(1024 * 1024)), other], 'aggregate raw limit');
  await rejectsBeforeStorage([good], 'declared body limit', { length: 3 * 1024 * 1024 + 1 });
  await rejectsBeforeStorage([good], 'actual body limit despite false length', { body: ' '.repeat(3 * 1024 * 1024 + 1), length: 1 });
  await rejectsBeforeStorage([good], 'missing current run', { url: endpoint.replace(`&run=${run}`, '') });

  let f = fixture();
  let response = await onRequestPost({ request: request([good, other]), env: f.env });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.ok, true); assert.equal(payload.results.length, 2);
  for (const expected of [good, other]) {
    const result = payload.results.find(entry => entry.path === expected.path);
    assert.equal(result.ok, true); assert.equal(result.size, expected.size); assert.equal(result.sha256, expected.sha256);
    assert.ok(result.etag); assert.ok(f.objects.has(objectKey(expected.path)));
  }
  assert.equal(f.receipts.size, 0, 'success clears exact durable write receipts');
  assert.equal(f.calls.filter(call => call.name === 'begin_processing_output_writes_v3').length, 1, 'batch retains deletion fencing');
  assert.equal(f.maxActiveParts(), 2, 'one batch writes at most two R2 objects concurrently');

  f = fixture();
  const existing = { size: good.size, etag: 'existing-etag', customMetadata: { sha256: good.sha256 } };
  f.objects.set(objectKey(good.path), existing);
  response = await onRequestPost({ request: request([good]), env: f.env });
  payload = await response.json();
  assert.equal(payload.ok, true); assert.equal(payload.results[0].ok, true);
  assert.equal(payload.results[0].etag, 'existing-etag'); assert.equal(f.uploads.length, 0);
  assert.ok(f.calls.some(call => call.name === 'resolve_processing_outputs_v3'), 'reuse still checks current-run authorization');

  for (const conflict of [{ ...existing, customMetadata: { sha256: '0'.repeat(64) } }, { ...existing, size: good.size + 1 }]) {
    f = fixture(); f.objects.set(objectKey(good.path), conflict);
    response = await onRequestPost({ request: request([good]), env: f.env });
    payload = await response.json();
    assert.equal(payload.ok, true); assert.equal(payload.results[0].ok, false);
    assert.equal(payload.results[0].error, 'OUTPUT_RECEIPT_CONFLICT');
    assert.equal(f.uploads.length, 0); assert.equal(f.objects.get(objectKey(good.path)), conflict);
  }

  // One failed R2 write does not discard the independently completed receipt.
  f = fixture({ failPartPath: other.path });
  response = await onRequestPost({ request: request([good, other]), env: f.env });
  assert.equal(response.status, 200); payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.results.find(result => result.path === good.path).ok, true);
  assert.equal(payload.results.find(result => result.path === other.path).ok, false);
  assert.ok(payload.results.find(result => result.path === other.path).error);
  assert.ok(f.objects.has(objectKey(good.path))); assert.ok(!f.objects.has(objectKey(other.path)));
  assert.equal(f.receipts.size, 0);
  assert.ok(f.calls.some(call => call.name === 'part' && call.key === objectKey(other.path)), 'failed item reached its isolated R2 write');
  assert.ok(f.calls.some(call => call.name === 'abort' && call.key === objectKey(other.path)), 'failed write aborts exact multipart upload');

  // Retry reconciles a successful item and never sends its bytes again.
  const firstGoodWrites = f.calls.filter(call => call.name === 'part' && call.key === objectKey(good.path)).length;
  await onRequestPost({ request: request([good, other]), env: f.env });
  assert.equal(f.calls.filter(call => call.name === 'part' && call.key === objectKey(good.path)).length, firstGoodWrites);
  console.log('Output batch: limits, validate-before-write, current-run reuse, conflicts, fenced partial failure and safe retry passed.');
} finally {
  globalThis.fetch = originalFetch;
}
