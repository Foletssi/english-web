import { json, requireBucket } from '../../../_lib/auth.js';
import { cookieValue, openPlaybackTicket } from '../../../_lib/playback-ticket.js';
import { serviceRpc } from '../../../_lib/supabase-admin.js';

function joinedPath(value) {
  return Array.isArray(value) ? value.join('/') : String(value || '');
}

function rangeFromHeader(value, size) {
  const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function handle({ request, env, params, waitUntil }, headOnly) {
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const raw = joinedPath(params.path);
  const slash = raw.indexOf('/');
  const job = slash < 0 ? '' : raw.slice(0, slash);
  const path = slash < 0 ? '' : raw.slice(slash + 1);
  if (!/^[0-9a-f-]{36}$/i.test(job) || !path) return json({ error: 'MEDIA_PATH_INVALID' }, 400);
  const playbackAsset=/^720p\/(?:index\.m3u8|segment_[0-9]{5}\.ts)$/.test(path);
  let key='';
  if(playbackAsset){
    let ticket;
    try {
      ticket=await openPlaybackTicket(cookieValue(request,'eastudy_playback'),env);
    } catch {
      return json({error:'PLAYBACK_SESSION_REQUIRED'},401);
    }
    if(ticket.job!==job||typeof ticket.sub!=='string'||!ticket.sub||typeof ticket.prefix!=='string'||!ticket.prefix.startsWith('videos/')||ticket.prefix.includes('..'))return json({error:'PLAYBACK_FORBIDDEN'},403);
    try {
      const access=await serviceRpc(env,'service_resolve_playback_access_v2',{p_user_id:ticket.sub,p_job_id:job,p_path:path});
      if(access?.canPlay!==true)return json({error:access?.reason||'PLAYBACK_FORBIDDEN'},403);
      key=String(access.objectKey||'');
      if(key!==ticket.prefix+path)return json({error:'PLAYBACK_FORBIDDEN'},403);
    } catch (error) {
      console.error('playback authorization unavailable',error?.message||error);
      return json({error:'PLAYBACK_AUTH_UNAVAILABLE'},503);
    }
  }else{
    if(path!=='cover.webp')return json({error:'MEDIA_PATH_INVALID'},400);
    try {
      const ticket=await openPlaybackTicket(cookieValue(request,'eastudy_catalog'),env,'eastudy-catalog');
      const access=await serviceRpc(env,'service_resolve_playback_access_v2',{p_user_id:ticket.sub,p_job_id:job,p_path:path});
      if(access?.canPlay!==true)return json({error:access?.reason||'PLAYBACK_FORBIDDEN'},403);
      key=String(access.objectKey||'');
    } catch (error) {
      console.error('cover authorization unavailable',error?.message||error);
      return json({error:'PLAYBACK_AUTH_UNAVAILABLE'},503);
    }
  }
  if (!key) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const requested = request.headers.get('Range');
  if(playbackAsset&&!headOnly&&!requested&&typeof caches!=='undefined'){
    const cache= caches.default,cacheUrl=new URL(request.url);cacheUrl.pathname='/__eastudy_media_cache__/'+key;cacheUrl.search='';
    const cacheKey=new Request(cacheUrl.toString(),{method:'GET'});
    let cached=await cache.match(cacheKey);
    if(!cached){
      const object=await env.VIDEO_BUCKET.get(key);
      if(!object?.body)return json({error:'MEDIA_NOT_FOUND'},404);
      const headers=new Headers();object.writeHttpMetadata(headers);headers.set('Accept-Ranges','bytes');headers.set('ETag',object.httpEtag||object.etag);headers.set('Content-Length',String(object.size));headers.set('Cache-Control',path.endsWith('.m3u8')?'public, max-age=300':'public, max-age=31536000, immutable');
      cached=new Response(object.body,{status:200,headers});
      const cacheWrite=cache.put(cacheKey,cached.clone());
      if(typeof waitUntil==='function')waitUntil(cacheWrite);
      else await cacheWrite;
    }
    const outgoing=new Response(cached.body,cached);outgoing.headers.set('Cache-Control','private, no-store');outgoing.headers.set('X-Content-Type-Options','nosniff');return outgoing;
  }
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const range = requested ? rangeFromHeader(requested, head.size) : null;
  if (requested && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size } });
  const object = headOnly ? head : await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', path.endsWith('.m3u8') ? 'private, max-age=60' : 'private, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag || object.etag);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  return new Response(headOnly ? null : object.body, { status: range ? 206 : 200, headers });
}

export const onRequestGet = (context) => handle(context, false);
export const onRequestHead = (context) => handle(context, true);
