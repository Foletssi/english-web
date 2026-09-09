import { json, requireAdmin, requireBucket } from '../../_lib/auth.js';

const MAX_BYTES = 512 * 1024;

function isWebp(bytes) {
  return bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
}

export async function onRequestPost({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const declared = Number(request.headers.get('Content-Length')) || 0;
  if (declared > MAX_BYTES || request.headers.get('Content-Type') !== 'image/webp') {
    return json({ error: 'CREATOR_AVATAR_INVALID' }, 400);
  }
  const body = await request.arrayBuffer();
  const bytes = new Uint8Array(body);
  if (!bytes.length || bytes.length > MAX_BYTES || !isWebp(bytes)) {
    return json({ error: 'CREATOR_AVATAR_INVALID' }, 400);
  }
  const name = crypto.randomUUID() + '.webp';
  const key = 'creator-avatars/' + name;
  await env.VIDEO_BUCKET.put(key, body, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: { uploadedBy: auth.user.id, usage: 'creator-avatar' }
  });
  return json({ key, url: '/api/creator-avatars/' + name, size: bytes.length });
}
