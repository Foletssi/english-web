import { json, requireBucket } from '../../_lib/auth.js';
import { resolveOutput, recordReceipts } from '../../_lib/r2-processing.js';
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
function contentType(path) { if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl; charset=utf-8'; if (path.endsWith('.ts')) return 'video/mp2t'; if (path.endsWith('.webp')) return 'image/webp'; if (path.endsWith('.mp3')) return 'audio/mpeg'; return 'application/octet-stream'; }
async function digest(data) { const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data)); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function ids(url) { return { jobId: url.searchParams.get('job') || '', runId: url.searchParams.get('run') || '', token: url.searchParams.get('token') || '' }; }
async function putAsset(env, args, data, path, sha256) {
  const resolved = await resolveOutput(env.VIDEO_BUCKET, { ...args, path });
  const existing = await env.VIDEO_BUCKET.head(resolved.objectKey);
  if (existing && Number(existing.size) === data.byteLength && existing.customMetadata?.sha256 === sha256) return { ok: true, path, size: existing.size, sha256, etag: existing.etag, reused: true };
  await env.VIDEO_BUCKET.put(resolved.objectKey, data, { httpMetadata: { contentType: contentType(path), cacheControl: path.endsWith('.m3u8') ? 'private, max-age=60' : 'private, max-age=31536000, immutable' }, customMetadata: { processingJobId: args.jobId, runId: args.runId, sha256 } });
  const object = await env.VIDEO_BUCKET.head(resolved.objectKey);
  return { ok: true, path, size: object?.size || data.byteLength, sha256, etag: object?.etag || null };
}
async function authArgs(url) { const { jobId, runId, token } = ids(url); if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(runId) || token.length < 32 || token.length > 256) throw new Error('OUTPUT_TOKEN_INVALID'); return { jobId, runId, token, workerId: null }; }
export async function onRequestPut({ request, env }) {
  const bucketError = requireBucket(env); if (bucketError) return bucketError;
  const url = new URL(request.url); const path = url.searchParams.get('path') || ''; const size = Number(request.headers.get('Content-Length')) || 0;
  if (size < 1 || size > MAX_ASSET_BYTES) return json({ error: size > MAX_ASSET_BYTES ? 'OUTPUT_TOO_LARGE' : 'OUTPUT_TOKEN_INVALID' }, size > MAX_ASSET_BYTES ? 413 : 401);
  const data = await request.arrayBuffer(); if (data.byteLength !== size) return json({ error: 'OUTPUT_SIZE_MISMATCH' }, 400);
  try { const args = await authArgs(url); const sha256 = await digest(data); const result = await putAsset(env, args, data, path, sha256); await recordReceipts(env.VIDEO_BUCKET, { ...args, receipts: [result] }); return json(result); }
  catch (error) { const code = error?.message || 'OUTPUT_UPLOAD_RETRY'; const status = /TOKEN|LEASE|MISMATCH/.test(code) ? 401 : /NOT_FOUND/.test(code) ? 404 : 503; return json({ error: code }, status); }
}
export async function onRequestPost({ request, env }) {
  const bucketError = requireBucket(env); if (bucketError) return bucketError;
  const url = new URL(request.url); let body;
  try { if ((Number(request.headers.get('Content-Length')) || 0) > 3 * 1024 * 1024) throw new Error('OUTPUT_TOO_LARGE'); body = await request.json(); if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 32) throw new Error('OUTPUT_BATCH_INVALID'); }
  catch (error) { return json({ error: error?.message || 'OUTPUT_BATCH_INVALID' }, error?.message === 'OUTPUT_TOO_LARGE' ? 413 : 400); }
  try {
    const args = await authArgs(url); const results = [];
    for (const item of body.items) {
      if (!item || !/^voice\/[a-f0-9]{64}\.mp3$/.test(item.path) || !Number.isInteger(item.size) || item.size < 1 || item.size > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.data !== 'string') throw new Error('OUTPUT_BATCH_INVALID');
      const binary = atob(item.data); if (binary.length !== item.size) throw new Error('OUTPUT_BATCH_INVALID'); const data = Uint8Array.from(binary, value => value.charCodeAt(0));
      if (await digest(data) !== item.sha256) throw new Error('OUTPUT_BATCH_INVALID'); results.push(await putAsset(env, args, data, item.path, item.sha256));
    }
    await recordReceipts(env.VIDEO_BUCKET, { ...args, receipts: results }); return json({ ok: true, results });
  } catch (error) { const code = error?.message || 'OUTPUT_UPLOAD_RETRY'; const status = /TOKEN|LEASE|MISMATCH/.test(code) ? 401 : /INVALID/.test(code) ? 400 : 503; return json({ error: code }, status); }
}
export async function onRequestGet({ request, env }) {
  const bucketError = requireBucket(env); if (bucketError) return bucketError;
  const url = new URL(request.url); const path = url.searchParams.get('path') || '';
  try { const args = await authArgs(url); const resolved = await resolveOutput(env.VIDEO_BUCKET, { ...args, path }); const object = await env.VIDEO_BUCKET.head(resolved.objectKey); if (!object) return json({ ok: true, found: false }); return json({ ok: true, found: true, path, size: object.size, etag: object.etag, sha256: object.customMetadata?.sha256 || null }); }
  catch (error) { const code = error?.message || 'OUTPUT_STATUS_UNAVAILABLE'; return json({ error: code }, /TOKEN|LEASE/.test(code) ? 401 : 503); }
}
