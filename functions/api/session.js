import { authenticate, json, readJson, requireAdmin } from '../_lib/auth.js';
import { sealPlaybackTicket } from '../_lib/playback-ticket.js';
import { serviceRpc, userRpc } from '../_lib/supabase-admin.js';

// Administrator-only readiness check. Never return credentials or ticket values.
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const checks = {
    mediaBucket: Boolean(env.VIDEO_BUCKET),
    authorizationCredential: Boolean(String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()),
    ticketEncryption: false
  };
  try {
    await sealPlaybackTicket({ aud: 'eastudy-readiness', exp: 0 }, env);
    checks.ticketEncryption = true;
  } catch { /* Configuration failure is reported without revealing its value. */ }
  const ready = Object.values(checks).every(Boolean);
  return json({ ready, checks }, ready ? 200 : 503);
}

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
    const exp = Math.floor(Date.now() / 1000) + maxAge;
    try {
      const ticket = await sealPlaybackTicket({ aud: 'eastudy-catalog', sub: auth.user.id, exp }, env);
      return json({ ok: true, access, expiresAt: exp }, 200, {
        'Set-Cookie': 'eastudy_catalog=' + encodeURIComponent(ticket) + '; Path=/api/processing/media/; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Strict'
      });
    } catch (error) {
      console.error('catalog ticket unavailable', error?.message || error);
      return json({ error: 'PLAYBACK_TICKET_UNAVAILABLE' }, 503);
    }
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'MEDIA_JOB_INVALID' }, 400);
  let playback;
  try {
    playback = await serviceRpc(env, 'service_resolve_playback_access_v2', {
      p_user_id: auth.user.id, p_job_id: jobId, p_path: 'master.m3u8'
    });
  } catch (error) {
    console.error('playback authorization unavailable', error?.code || error?.message || error);
    return json({ error: 'PLAYBACK_AUTH_UNAVAILABLE' }, 503);
  }
  if (playback?.canPlay !== true) return json({ error: playback?.reason || 'PLAYBACK_FORBIDDEN' }, 403);
  const objectKey = String(playback.objectKey || '');
  if (!/\/(?:540|720)p\/index\.m3u8$/.test(objectKey)) return json({ error: 'PLAYBACK_FORBIDDEN' }, 403);
  const entitlementExpiry=Date.parse(playback.expiresAt||'')/1000;
  const now = Math.floor(Date.now() / 1000),exp=playback.kind==='ADMIN'?now+300:Number.isFinite(entitlementExpiry)?Math.min(now+300,Math.floor(entitlementExpiry)):now;
  if(exp<=now)return json({error:'MEMBERSHIP_EXPIRED'},403);
  try {
    const ticket = await sealPlaybackTicket({ aud:'eastudy-playback',sub:auth.user.id,job:jobId,prefix:String(playback.prefix||''),exp },env);
    return json({ ok:true,expiresAt:exp },200,{
      'Set-Cookie':'eastudy_playback='+encodeURIComponent(ticket)+'; Path=/api/processing/media/'+jobId+'/; Max-Age='+(exp-now)+'; HttpOnly; Secure; SameSite=Strict'
    });
  } catch (error) {
    console.error('playback ticket unavailable', error?.message || error);
    return json({ error:'PLAYBACK_TICKET_UNAVAILABLE' },503);
  }
}

export async function onRequestDelete({ request }) {
  const input = await readJson(request).catch(() => ({}));
  const jobIds = [...new Set((Array.isArray(input.jobIds) ? input.jobIds : [])
    .map(String).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
  const headers = new Headers({ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  headers.append('Set-Cookie', 'eastudy_media_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  headers.append('Set-Cookie', 'eastudy_catalog=; Path=/api/processing/media/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  for (const jobId of jobIds) {
    headers.append('Set-Cookie', 'eastudy_media_session=; Path=/api/processing/media/' + jobId + '/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    headers.append('Set-Cookie', 'eastudy_playback=; Path=/api/processing/media/' + jobId + '/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  }
  return new Response(JSON.stringify({ ok:true,clearedPlaybackPaths:jobIds.length }), { status:200,headers });
}
