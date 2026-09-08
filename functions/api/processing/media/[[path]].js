import { authenticate, json, requireBucket } from '../../../_lib/auth.js';

function joinedPath(value) {
  return Array.isArray(value) ? value.join('/') : String(value || '');
}

function rangeFromHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function handle({ request, env, params }, headOnly) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const raw = joinedPath(params.path);
  const slash = raw.indexOf('/');
  const job = slash < 0 ? '' : raw.slice(0, slash);
  const path = slash < 0 ? '' : raw.slice(slash + 1);
  if (!/^[0-9a-f-]{36}$/i.test(job) || !path) return json({ error: 'MEDIA_PATH_INVALID' }, 400);
  const response = await fetch(auth.url + '/rest/v1/rpc/resolve_processing_media', {
    method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job_id: job, p_path: path })
  });
  if (!response.ok) return json({ error: 'MEDIA_AUTH_FAILED' }, 502);
  const rows = await response.json();
  const key = rows?.[0]?.object_key;
  if (!key) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const requested = request.headers.get('Range');
  const range = requested ? rangeFromHeader(requested, head.size) : null;
  if (requested && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size } });
  const object = headOnly ? head : await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', path.endsWith('.m3u8') ? 'private, max-age=60' : 'private, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag || object.etag);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(headOnly ? null : object.body, { status: range ? 206 : 200, headers });
}

export const onRequestGet = (context) => handle(context, false);
export const onRequestHead = (context) => handle(context, true);
