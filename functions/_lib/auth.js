const DEFAULT_SUPABASE_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_74G1tE79krJiq5P6DWHhZQ_QZkk6tdy';

function config(env) {
  return {
    url: env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    key: env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_KEY
  };
}

export function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

export async function readJson(request, maxBytes = 32 * 1024) {
  const declared = Number(request.headers.get('Content-Length')) || 0;
  if (declared > maxBytes) throw new Error('REQUEST_TOO_LARGE');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('REQUEST_TOO_LARGE');
  return JSON.parse(text || '{}');
}

export async function authenticate(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const cookieToken = cookie.match(/(?:^|;\s*)eastudy_media_session=([^;]+)/)?.[1];
  const authorization = request.headers.get('Authorization') || (cookieToken ? 'Bearer ' + decodeURIComponent(cookieToken) : '');
  if (!authorization.startsWith('Bearer ')) return { error: json({ error: 'AUTHENTICATION_REQUIRED' }, 401) };
  const { url, key } = config(env);
  const headers = { apikey: key, Authorization: authorization };
  const userResponse = await fetch(url + '/auth/v1/user', { headers });
  if (!userResponse.ok) return { error: json({ error: 'INVALID_SESSION' }, 401) };
  const user = await userResponse.json();
  return { user, authorization, headers, url };
}

export async function requireAdmin(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth;
  const profileResponse = await fetch(auth.url + '/rest/v1/profiles?id=eq.' + encodeURIComponent(auth.user.id) + '&select=role', {
    headers: { ...auth.headers, Accept: 'application/json' }
  });
  if (!profileResponse.ok) return { error: json({ error: 'PROFILE_LOOKUP_FAILED' }, 502) };
  const profiles = await profileResponse.json();
  if (String(profiles?.[0]?.role || '').toLowerCase() !== 'admin') return { error: json({ error: 'ADMIN_REQUIRED' }, 403) };
  return auth;
}

export function requireBucket(env) {
  if (!env.VIDEO_BUCKET) return json({ error: 'R2_VIDEO_BUCKET_NOT_BOUND' }, 503);
  return null;
}
