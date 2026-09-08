import { json, requireBucket } from '../../_lib/auth.js';

const SUPABASE_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_74G1tE79krJiq5P6DWHhZQ_QZkk6tdy';
const MAX_ASSET_BYTES = 15 * 1024 * 1024;

function contentType(path) {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl; charset=utf-8';
  if (path.endsWith('.ts')) return 'video/mp2t';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

export async function onRequestPut({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const url = new URL(request.url);
  const job = url.searchParams.get('job') || '';
  const token = url.searchParams.get('token') || '';
  const path = url.searchParams.get('path') || '';
  const size = Number(request.headers.get('Content-Length')) || 0;
  if (!/^[0-9a-f-]{36}$/i.test(job) || token.length < 32 || token.length > 256 || !path || size > MAX_ASSET_BYTES) {
    return json({ error: size > MAX_ASSET_BYTES ? 'OUTPUT_TOO_LARGE' : 'OUTPUT_TOKEN_INVALID' }, size > MAX_ASSET_BYTES ? 413 : 401);
  }
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/resolve_processing_output', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job_id: job, p_token: token, p_path: path })
  });
  if (!response.ok) return json({ error: 'OUTPUT_AUTH_FAILED' }, 502);
  const rows = await response.json();
  const key = rows?.[0]?.object_key;
  if (!key) return json({ error: 'OUTPUT_NOT_ALLOWED' }, 403);
  const stored = await env.VIDEO_BUCKET.put(key, request.body, {
    httpMetadata: { contentType: contentType(path), cacheControl: path.endsWith('.m3u8') ? 'private, max-age=60' : 'private, max-age=31536000, immutable' },
    customMetadata: { processingJobId: job }
  });
  return json({ ok: true, path, etag: stored.etag, size: stored.size });
}
