import { json, requireBucket } from '../../_lib/auth.js';
import { resolveSource } from '../../_lib/r2-processing.js';

function rangeFromHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
async function handle({ request, env }, headOnly = false) {
  const bucketError = requireBucket(env); if (bucketError) return bucketError;
  const url = new URL(request.url); const job = url.searchParams.get('job') || ''; const token = url.searchParams.get('token') || '';
  if (!/^[0-9a-f-]{36}$/i.test(job) || token.length < 32 || token.length > 256) return json({ error: 'SOURCE_TOKEN_INVALID' }, 401);
  const asset = url.searchParams.get('asset') || 'source'; if (!['source', 'cover'].includes(asset)) return json({ error: 'SOURCE_ASSET_INVALID' }, 400);
  let resolved; try { resolved = await resolveSource(env.VIDEO_BUCKET, { jobId: job, token, workerId: null }); } catch (error) { const code = error?.message || 'SOURCE_AUTH_UNAVAILABLE'; const status = /NOT_FOUND/.test(code) ? 404 : /TOKEN|LEASE/.test(code) ? 401 : 503; return json({ error: code === 'SOURCE_NOT_FOUND' ? code : 'SOURCE_AUTH_FAILED' }, status); }
  const key = asset === 'cover' ? (resolved.job.input?.cover_key || resolved.job.source_key) : resolved.objectKey;
  if (!key) return json({ error: 'SOURCE_NOT_FOUND' }, 404);
  const head = await env.VIDEO_BUCKET.head(key); if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const etag = head.httpEtag || `"${head.etag}"`; const requested = request.headers.get('Range'); const ifRange = request.headers.get('If-Range');
  const useRange = Boolean(requested && (!ifRange || ifRange === etag)); const range = useRange ? rangeFromHeader(requested, head.size) : null;
  if (useRange && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size, ETag: etag } });
  const object = headOnly ? head : await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return json({ error: 'MEDIA_NOT_FOUND' }, 404); if (!headOnly && object.etag !== head.etag) return json({ error: 'SOURCE_CHANGED_RETRY' }, 409);
  const headers = new Headers(); object.writeHttpMetadata(headers); headers.set('ETag', etag); headers.set('Accept-Ranges', 'bytes'); headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size)); headers.set('Cache-Control', 'private, no-store'); headers.set('Content-Disposition', 'inline; filename="source' + (key.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4') + '"'); if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(headOnly ? null : object.body, { status: range ? 206 : 200, headers });
}
export const onRequestGet = context => handle(context, false);
export const onRequestHead = context => handle(context, true);
