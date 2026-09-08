import { json, readJson, requireAdmin, requireBucket } from '../../../_lib/auth.js';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'application/octet-stream']);

function extension(name) {
  const match = String(name || '').toLowerCase().match(/\.(mp4|mov|webm|m4v)$/);
  return match ? match[1] : 'mp4';
}

export async function onRequestPost({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  try {
    const input = await readJson(request);
    const size = Number(input.size) || 0;
    const type = String(input.type || 'application/octet-stream').toLowerCase();
    if (!size || size > MAX_BYTES) return json({ error: 'VIDEO_FILE_SIZE_INVALID' }, 400);
    if (!ALLOWED_TYPES.has(type)) return json({ error: 'VIDEO_FILE_TYPE_INVALID' }, 400);
    const key = 'videos/' + crypto.randomUUID() + '/source.' + extension(input.name);
    const upload = await env.VIDEO_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: type === 'application/octet-stream' ? 'video/mp4' : type },
      customMetadata: { expectedSize: String(size), uploadedBy: auth.user.id }
    });
    return json({ key, uploadId: upload.uploadId });
  } catch (error) {
    return json({ error: error.message || 'UPLOAD_INIT_FAILED' }, 400);
  }
}
