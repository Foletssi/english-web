import { json, requireBucket } from '../../_lib/auth.js';

const SUPABASE_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_74G1tE79krJiq5P6DWHhZQ_QZkk6tdy';

function rangeFromHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function handle({ request, env }, headOnly = false) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const url = new URL(request.url);
  const job = url.searchParams.get('job') || '';
  const token = url.searchParams.get('token') || '';
  if (!/^[0-9a-f-]{36}$/i.test(job) || token.length < 32 || token.length > 256) {
    return json({ error: 'SOURCE_TOKEN_INVALID' }, 401);
  }
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/resolve_processing_source', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job_id: job, p_token: token })
  });
  if (!response.ok) return json({ error: 'SOURCE_AUTH_FAILED' }, 502);
  const rows = await response.json();
  const key = rows?.[0]?.source_key;
  if (!key) return json({ error: 'SOURCE_NOT_FOUND' }, 404);
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const etag = head.httpEtag || `"${head.etag}"`;
  const requested = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  const useRange = Boolean(requested && (!ifRange || ifRange === etag));
  const range = useRange ? rangeFromHeader(requested, head.size) : null;
  if (useRange && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size, ETag: etag } });
  const object = headOnly ? head : await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  if (!headOnly && object.etag !== head.etag) return json({ error: 'SOURCE_CHANGED_RETRY' }, 409);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', etag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Disposition', 'inline; filename="source' + (key.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4') + '"');
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(headOnly ? null : object.body, { status: range ? 206 : 200, headers });
}

export const onRequestGet = (context) => handle(context, false);
export const onRequestHead = (context) => handle(context, true);
