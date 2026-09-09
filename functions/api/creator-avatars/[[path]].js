import { authenticate, json, requireBucket } from '../../_lib/auth.js';

function nameFrom(value) {
  const name = Array.isArray(value) ? value.join('/') : String(value || '');
  return /^[0-9a-f-]{36}\.webp$/i.test(name) ? name : '';
}

export async function onRequestGet({ request, env, params }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const name = nameFrom(params.path);
  if (!name) return json({ error: 'CREATOR_AVATAR_PATH_INVALID' }, 400);
  const object = await env.VIDEO_BUCKET.get('creator-avatars/' + name);
  if (!object?.body) return json({ error: 'CREATOR_AVATAR_NOT_FOUND' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag || object.etag);
  return new Response(object.body, { headers });
}
