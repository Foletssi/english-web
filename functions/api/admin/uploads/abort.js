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
    const input = await readJson(request);
    if (!validKey(input.key) || !input.uploadId) return json({ error: 'INVALID_UPLOAD_ABORT' }, 400);
    await env.VIDEO_BUCKET.resumeMultipartUpload(input.key, input.uploadId).abort();
    return json({ ok: true });
  } catch (error) {
    return json({ error: error.message || 'UPLOAD_ABORT_FAILED' }, 400);
  }
}
