import { authenticate, json, readJson } from '../_lib/auth.js';
import { userRpc } from '../_lib/supabase-admin.js';

export async function onRequestPost({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const token = auth.authorization.slice('Bearer '.length);
  const input = await readJson(request).catch(() => ({}));
  const jobId = String(input.jobId || '');
  let access;
  try {
    access = await userRpc(env, token, 'get_my_learning_access_v2', {});
  } catch (error) {
    console.error('learning access unavailable', error?.code || error?.message || error);
    return json({ error: 'PLAYBACK_AUTH_UNAVAILABLE' }, 503);
  }
  if (access?.canPlay !== true) return json({ error: access?.reason || 'PLAYBACK_FORBIDDEN' }, 403);
  if (!jobId) {
    const expires = Date.parse(access.expiresAt || '') / 1000;
    const maxAge = access.kind === 'ADMIN' ? 300 : Math.max(1, Math.min(300, Math.floor(expires - Date.now() / 1000)));
    return json({ ok: true, access }, 200, {
      'Set-Cookie': 'eastudy_media_session=' + encodeURIComponent(token) + '; Path=/api; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Strict'
    });
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'MEDIA_JOB_INVALID' }, 400);
  let playback;
  try {
    const object = await userRpc(env, token, 'resolve_processing_media', { p_job_id: jobId, p_path: '720p/index.m3u8' });
    playback = { ...access, canPlay: Boolean(object?.object_key), objectKey: object?.object_key || '' };
  } catch (error) {
    console.error('playback authorization unavailable', error?.code || error?.message || error);
    return json({ error: 'PLAYBACK_AUTH_UNAVAILABLE' }, 503);
  }
  if (playback?.canPlay !== true) return json({ error: playback?.reason || 'PLAYBACK_FORBIDDEN' }, 403);
  const objectKey = String(playback.objectKey || '');
  if (!objectKey.endsWith('/720p/index.m3u8')) return json({ error: 'PLAYBACK_FORBIDDEN' }, 403);
  const entitlementExpiry=Date.parse(playback.expiresAt||'')/1000;
  const now = Math.floor(Date.now() / 1000),exp=playback.kind==='ADMIN'?now+300:Number.isFinite(entitlementExpiry)?Math.min(now+300,Math.floor(entitlementExpiry)):now;
  if(exp<=now)return json({error:'MEMBERSHIP_EXPIRED'},403);
  return json({ ok:true,expiresAt:exp },200,{
    'Set-Cookie':'eastudy_media_session='+encodeURIComponent(token)+'; Path=/api/processing/media/'+jobId+'/; Max-Age='+(exp-now)+'; HttpOnly; Secure; SameSite=Strict'
  });
}

export async function onRequestDelete({ request }) {
  const input = await readJson(request).catch(() => ({}));
  const jobIds = [...new Set((Array.isArray(input.jobIds) ? input.jobIds : [])
    .map(String).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
  const headers = new Headers({ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  headers.append('Set-Cookie', 'eastudy_media_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  for (const jobId of jobIds) {
    headers.append('Set-Cookie', 'eastudy_media_session=; Path=/api/processing/media/' + jobId + '/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    headers.append('Set-Cookie', 'eastudy_playback=; Path=/api/processing/media/' + jobId + '/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  }
  return new Response(JSON.stringify({ ok:true,clearedPlaybackPaths:jobIds.length }), { status:200,headers });
}
