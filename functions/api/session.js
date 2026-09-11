import { authenticate, json, readJson } from '../_lib/auth.js';
import { sealPlaybackTicket } from '../_lib/playback-ticket.js';

export async function onRequestPost({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const token = auth.authorization.slice('Bearer '.length);
  const input = await readJson(request).catch(() => ({}));
  const jobId = String(input.jobId || '');
  if (!jobId) return json({ ok: true }, 200, {
    'Set-Cookie': 'eastudy_media_session=' + encodeURIComponent(token) + '; Path=/api; Max-Age=3600; HttpOnly; Secure; SameSite=Strict'
  });
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'MEDIA_JOB_INVALID' }, 400);
  const resolved = await fetch(auth.url + '/rest/v1/rpc/resolve_processing_media', {
    method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job_id: jobId, p_path: '720p/index.m3u8' })
  });
  if (!resolved.ok) return json({ error: 'PLAYBACK_AUTH_FAILED' }, 502);
  const objectKey = (await resolved.json())?.[0]?.object_key || '';
  if (!objectKey.endsWith('/720p/index.m3u8')) return json({ error: 'PLAYBACK_FORBIDDEN' }, 403);
  const entitlementResponse=await fetch(auth.url+'/rest/v1/membership_entitlements?user_id=eq.'+encodeURIComponent(auth.user.id)+'&product_id=eq.eastudy_pro&select=expires_at,revoked_at',{headers:{...auth.headers,Accept:'application/json'}});
  const entitlementRows=entitlementResponse.ok?await entitlementResponse.json():[];
  const entitlementExpiry=Date.parse(entitlementRows?.[0]?.expires_at||'')/1000;
  const now = Math.floor(Date.now() / 1000),exp=Number.isFinite(entitlementExpiry)?Math.min(now+300,Math.floor(entitlementExpiry)):now+300,prefix=objectKey.slice(0,-'720p/index.m3u8'.length);
  if(exp<=now)return json({error:'MEMBERSHIP_EXPIRED'},403);
  let ticket;
  try {
    ticket = await sealPlaybackTicket({ aud:'eastudy-playback',sub:auth.user.id,job:jobId,prefix,exp },env);
  } catch (error) {
    console.error('playback ticket signing unavailable', error?.message || error);
    return json({ error:'PLAYBACK_TICKET_UNAVAILABLE' },503);
  }
  return json({ ok:true,expiresAt:exp },200,{
    'Set-Cookie':'eastudy_playback='+encodeURIComponent(ticket)+'; Path=/api/processing/media/'+jobId+'/; Max-Age='+(exp-now)+'; HttpOnly; Secure; SameSite=Strict'
  });
}

export async function onRequestDelete({ request }) {
  const input = await readJson(request).catch(() => ({}));
  const jobIds = [...new Set((Array.isArray(input.jobIds) ? input.jobIds : [])
    .map(String).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
  const headers = new Headers({ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  headers.append('Set-Cookie', 'eastudy_media_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  for (const jobId of jobIds) {
    headers.append('Set-Cookie', 'eastudy_playback=; Path=/api/processing/media/' + jobId + '/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  }
  return new Response(JSON.stringify({ ok:true,clearedPlaybackPaths:jobIds.length }), { status:200,headers });
}
