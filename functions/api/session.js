import { authenticate, json } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const token = auth.authorization.slice('Bearer '.length);
  return json({ ok: true }, 200, {
    'Set-Cookie': 'eastudy_media_session=' + encodeURIComponent(token) + '; Path=/api/media; Max-Age=3600; HttpOnly; Secure; SameSite=Strict'
  });
}

export async function onRequestDelete() {
  return json({ ok: true }, 200, {
    'Set-Cookie': 'eastudy_media_session=; Path=/api/media; Max-Age=0; HttpOnly; Secure; SameSite=Strict'
  });
}
