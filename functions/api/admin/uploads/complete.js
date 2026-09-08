import { json, readJson, requireAdmin, requireBucket } from '../../../_lib/auth.js';

function validKey(key) {
  return /^videos\/[0-9a-f-]{36}\/source\.(mp4|mov|webm|m4v)$/.test(key);
}

export async function onRequestPost({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  try {
    const input = await readJson(request, 512 * 1024);
    if (!validKey(input.key) || !input.uploadId || !Array.isArray(input.parts) || !input.parts.length) {
      return json({ error: 'INVALID_UPLOAD_COMPLETION' }, 400);
    }
    const parts = input.parts.map(part => ({ partNumber: Number(part.partNumber), etag: String(part.etag || '') }));
    if (parts.some(part => !Number.isInteger(part.partNumber) || part.partNumber < 1 || !part.etag)) {
      return json({ error: 'INVALID_UPLOAD_COMPLETION' }, 400);
    }
    const upload = env.VIDEO_BUCKET.resumeMultipartUpload(input.key, input.uploadId);
    const object = await upload.complete(parts);
    const expected = Number(object.customMetadata?.expectedSize) || 0;
    if (expected && object.size !== expected) {
      await env.VIDEO_BUCKET.delete(input.key);
      return json({ error: 'UPLOADED_SIZE_MISMATCH' }, 400);
    }
    return json({ key: object.key, size: object.size, etag: object.httpEtag || object.etag });
  } catch (error) {
    return json({ error: error.message || 'UPLOAD_COMPLETE_FAILED' }, 400);
  }
}
