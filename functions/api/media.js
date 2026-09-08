import { authenticate, json, requireBucket } from '../_lib/auth.js';

function validKey(key) {
  return /^videos\/[0-9a-f-]{36}\/[a-z0-9._-]+$/.test(key);
}

function rangeFromHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function onRequestGet({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!validKey(key)) return json({ error: 'INVALID_MEDIA_KEY' }, 400);
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const requested = request.headers.get('Range');
  const range = requested ? rangeFromHeader(requested, head.size) : null;
  if (requested && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size } });
  const object = await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object?.body) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('ETag', object.httpEtag || object.etag);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
