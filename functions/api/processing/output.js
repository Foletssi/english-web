import { json, requireBucket } from '../../_lib/auth.js';
import { adminConfig, serviceRpc } from '../../_lib/supabase-admin.js';

const SUPABASE_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_74G1tE79krJiq5P6DWHhZQ_QZkk6tdy';
const MAX_ASSET_BYTES = 15 * 1024 * 1024;

function contentType(path) {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl; charset=utf-8';
  if (path.endsWith('.ts')) return 'video/mp2t';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

export async function onRequestPut({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const url = new URL(request.url);
  const job = url.searchParams.get('job') || '';
  const token = url.searchParams.get('token') || '';
  const run = url.searchParams.get('run') || '';
  const path = url.searchParams.get('path') || '';
  const size = Number(request.headers.get('Content-Length')) || 0;
  if (!/^[0-9a-f-]{36}$/i.test(job) || token.length < 32 || token.length > 256 ||
      (run && !/^[0-9a-f-]{36}$/i.test(run)) || !path || size < 1 || size > MAX_ASSET_BYTES) {
    return json({ error: size > MAX_ASSET_BYTES ? 'OUTPUT_TOO_LARGE' : 'OUTPUT_TOKEN_INVALID' }, size > MAX_ASSET_BYTES ? 413 : 401);
  }
  const data = await request.arrayBuffer();
  if (data.byteLength !== size || data.byteLength > MAX_ASSET_BYTES) {
    return json({ error: 'OUTPUT_SIZE_MISMATCH' }, 400);
  }
  // Resolve before allocating storage; the service RPC rechecks under the
  // deletion confirmation lock before any bytes may be committed.
  try { adminConfig(env); } catch { return json({ error: 'OUTPUT_SERVICE_UNAVAILABLE' }, 503); }
  const resolver = run ? 'resolve_processing_output_v2' : 'resolve_processing_output';
  const body = { p_job_id: job, p_token: token, p_path: path, ...(run ? { p_run_id: run } : {}) };
  let response;
  try { response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + resolver, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }); } catch { return json({ error: 'OUTPUT_AUTH_UNAVAILABLE' }, 503); }
  if (!response.ok) return json({ error: 'OUTPUT_AUTH_FAILED' }, 502);
  const rows = await response.json().catch(() => null);
  const key = rows?.[0]?.object_key;
  if (!key) return json({ error: 'OUTPUT_NOT_ALLOWED' }, 403);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return storeAsset(env, key, body, data, sha256);
}

async function storeAsset(env, key, body, data, sha256) {
  const { p_job_id: job, p_path: path, p_run_id: run } = body;
  let upload, receipt, stored;
  try {
    upload = await env.VIDEO_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: contentType(path), cacheControl: path.endsWith('.m3u8') ? 'private, max-age=60' : 'private, max-age=31536000, immutable' },
      customMetadata: { processingJobId: job, sha256 }
    });
    receipt = await serviceRpc(env, 'begin_processing_output_write', {
      ...body, p_run_id: run || null, p_upload_id: upload.uploadId
    });
    if (receipt?.object_key !== key || !receipt?.write_id) throw new Error('OUTPUT_NOT_ALLOWED');
    const part = await upload.uploadPart(1, data);
    stored = await upload.complete([part]);
  } catch {
    // Aborting this exact multipart upload fences even a delayed complete.
    // If abort cannot be verified, retain the receipt for the deletion worker.
    if (upload) {
      try {
        await upload.abort();
        if (receipt?.write_id) await acknowledge(env, receipt.write_id);
      } catch { /* Durable receipt remains recoverable by upload ID. */ }
    }
    return json({ error: 'OUTPUT_UPLOAD_RETRY' }, 503);
  }
  if (!await acknowledge(env, receipt.write_id)) return json({ error: 'OUTPUT_ACK_PENDING' }, 503);
  return json({ ok: true, path, etag: stored.etag, size: stored.size, sha256 });
}

async function acknowledge(env, writeId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await serviceRpc(env, 'finish_processing_output_write', { p_write_id: writeId });
      return true;
    } catch { /* Idempotent; an uncertain response is safe to retry. */ }
  }
  return false;
}

// Bounded memory-only envelope: no archive object or destructive cleanup.
export async function onRequestPost({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const url = new URL(request.url);
  const job = url.searchParams.get('job') || '', run = url.searchParams.get('run') || '';
  const token = url.searchParams.get('token') || '';
  if (!/^[0-9a-f-]{36}$/i.test(job) || !/^[0-9a-f-]{36}$/i.test(run) ||
      token.length < 32 || token.length > 256) return json({ error: 'OUTPUT_TOKEN_INVALID' }, 401);
  const maxBody = 3 * 1024 * 1024;
  if (Number(request.headers.get('Content-Length')) > maxBody) return json({ error: 'OUTPUT_TOO_LARGE' }, 413);
  // Stream with a hard cap even when Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  const chunks = []; let length = 0, items;
  try {
    if (!reader) throw new Error('empty body');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBody) { await reader.cancel(); return json({ error: 'OUTPUT_TOO_LARGE' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    items = JSON.parse(new TextDecoder().decode(bytes)).items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 4) throw new Error('count');
    const paths = new Set(); let total = 0;
    // Validate the entire envelope before allocating any storage.
    for (const item of items) {
      if (!item || !/^voice\/[a-f0-9]{64}\.mp3$/.test(item.path) || paths.has(item.path) ||
          !Number.isInteger(item.size) || item.size < 1 || item.size > 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.data !== 'string') throw new Error('item');
      paths.add(item.path); total += item.size;
      if (total > 2 * 1024 * 1024) throw new Error('total');
      const binary = atob(item.data);
      if (btoa(binary) !== item.data || binary.length !== item.size) throw new Error('base64');
      item.bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', item.bytes));
      if ([...digest].map(b => b.toString(16).padStart(2, '0')).join('') !== item.sha256) throw new Error('digest');
    }
  } catch { return json({ error: 'OUTPUT_BATCH_INVALID' }, 400); }
  try { adminConfig(env); } catch { return json({ error: 'OUTPUT_SERVICE_UNAVAILABLE' }, 503); }
  const results = [];
  for (const item of items) {
    const body = { p_job_id: job, p_run_id: run, p_token: token, p_path: item.path };
    try {
      const resolved = await serviceRpc(env, 'resolve_processing_output_v2', body);
      if (!resolved?.object_key) { results.push({ ok: false, path: item.path, error: 'OUTPUT_NOT_ALLOWED' }); continue; }
      const existing = await env.VIDEO_BUCKET.head(resolved.object_key);
      if (existing) {
        results.push(existing.size === item.size && existing.customMetadata?.sha256 === item.sha256
          ? { ok: true, path: item.path, size: item.size, sha256: item.sha256, etag: existing.etag }
          : { ok: false, path: item.path, error: 'OUTPUT_RECEIPT_CONFLICT' });
        continue;
      }
      const response = await storeAsset(env, resolved.object_key, body, item.bytes, item.sha256);
      const result = await response.json();
      results.push({ ...result, ok: response.ok && result.ok === true, path: item.path });
    } catch { results.push({ ok: false, path: item.path, error: 'OUTPUT_STATUS_UNAVAILABLE' }); }
  }
  return json({ ok: true, results });
}

// The current run's resolver derives the object key; callers never supply R2 keys.
export async function onRequestGet({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const url = new URL(request.url);
  const job = url.searchParams.get('job') || '', run = url.searchParams.get('run') || '';
  const token = url.searchParams.get('token') || '', path = url.searchParams.get('path') || '';
  if (!/^[0-9a-f-]{36}$/i.test(job) || !/^[0-9a-f-]{36}$/i.test(run) ||
      token.length < 32 || token.length > 256 || !path) return json({ error: 'OUTPUT_TOKEN_INVALID' }, 401);
  try {
    const resolved = await serviceRpc(env, 'resolve_processing_output_v2', {
      p_job_id: job, p_run_id: run, p_token: token, p_path: path
    });
    const key = resolved?.object_key;
    if (!key) return json({ error: 'OUTPUT_NOT_ALLOWED' }, 403);
    const object = await env.VIDEO_BUCKET.head(key);
    if (!object || !/^[a-f0-9]{64}$/.test(object.customMetadata?.sha256 || '')) return json({ ok: true, found: false });
    return json({ ok: true, found: true, path, size: object.size, etag: object.etag, sha256: object.customMetadata.sha256 });
  } catch { return json({ error: 'OUTPUT_STATUS_UNAVAILABLE' }, 503); }
}
