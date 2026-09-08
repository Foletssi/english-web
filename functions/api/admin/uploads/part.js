import { json, requireAdmin, requireBucket } from '../../../_lib/auth.js';

function validKey(key) {
  return /^videos\/[0-9a-f-]{36}\/source\.(mp4|mov|webm|m4v)$/.test(key);
}

export async function onRequestPut({ request, env }) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('part'));
  if (!validKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return json({ error: 'INVALID_UPLOAD_PART' }, 400);
  }
  try {
    const upload = env.VIDEO_BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    return json({ error: error.message || 'UPLOAD_PART_FAILED' }, 400);
  }
}
