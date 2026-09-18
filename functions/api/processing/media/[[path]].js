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
  const started=performance.now();
  const bucketError = requireBucket(env);
  if (bucketError) return bucketError;
  const raw = joinedPath(params.path);
  const slash = raw.indexOf('/');
  const job = slash < 0 ? '' : raw.slice(0, slash);
  const path = slash < 0 ? '' : raw.slice(slash + 1);
  if (!/^[0-9a-f-]{36}$/i.test(job) || !path) return json({ error: 'MEDIA_PATH_INVALID' }, 400);
  const query=new URL(request.url).searchParams;
  const preview=query.has('previewRun'),previewRun=query.get('previewRun');
  if(preview&&(query.getAll('previewRun').length!==1||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewRun||'')||!/^cover(?:-(?:320|640|960))?\.webp$/.test(path)))return json({error:'MEDIA_PATH_INVALID'},400);
  const playbackAsset=/^(?:540|720)p\/(?:index\.m3u8|segment_[0-9]{5}\.ts)$/.test(path);
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
    if(!/^cover(?:-(?:320|640|960))?\.webp$/.test(path)&&!/^voice\/[a-f0-9]{64}\.mp3$/.test(path))return json({error:'MEDIA_PATH_INVALID'},400);
    let ticket;
    try {
      ticket=await openPlaybackTicket(cookieValue(request,'eastudy_catalog'),env,'eastudy-catalog');
    } catch (error) {
      if(error?.message==='PLAYBACK_TICKET_KEY_INVALID')return json({error:'PLAYBACK_AUTH_UNAVAILABLE'},503);
      return json({error:'PLAYBACK_SESSION_REQUIRED'},401);
    }
    if(typeof ticket.sub!=='string'||!ticket.sub)return json({error:'PLAYBACK_FORBIDDEN'},403);
    try {
      const access=preview
        ? await serviceRpc(env,'service_resolve_admin_cover_preview_v1',{p_user_id:ticket.sub,p_job_id:job,p_run_id:previewRun,p_path:path})
        : await serviceRpc(env,'service_resolve_playback_access_v2',{p_user_id:ticket.sub,p_job_id:job,p_path:path});
      if((preview?access?.canPreview:access?.canPlay)!==true)return json({error:access?.reason||'PLAYBACK_FORBIDDEN'},403);
      key=String(access.objectKey||'');
    } catch (error) {
      console.error('catalog media authorization unavailable',error?.message||error);
      return json({error:'PLAYBACK_AUTH_UNAVAILABLE'},503);
    }
  }
  if (!key) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const authorized=performance.now();
  const timing=(headers,cacheStatus)=>{headers.set('Server-Timing',`authorization;dur=${(authorized-started).toFixed(1)},delivery;dur=${(performance.now()-authorized).toFixed(1)}`);headers.set('X-Eastudy-Media-Cache',cacheStatus)};
  const requested = request.headers.get('Range');
  const voiceAsset=/^voice\/[a-f0-9]{64}\.mp3$/.test(path);
  // Pronunciation files are small, immutable registered assets. Keep one full
  // edge object so mobile byte probes and subsequent ranges share the same hit.
  // Entitlement resolution above still runs before every cache read.
  if(!headOnly&&(!requested||voiceAsset)&&typeof caches!=='undefined'){
    const cache= caches.default,cacheUrl=new URL(request.url);cacheUrl.pathname='/__eastudy_media_cache__/'+key;cacheUrl.search='';
    const cacheKey=new Request(cacheUrl.toString(),{method:'GET'});
    let cached;
    try { cached=await cache.match(cacheKey); } catch { /* Cache outages fall back to the authorized origin. */ }
    const hit=Boolean(cached);
    if(!cached){
      const object=await env.VIDEO_BUCKET.get(key);
      if(!object?.body)return json({error:'MEDIA_NOT_FOUND'},404);
      const headers=new Headers();object.writeHttpMetadata(headers);headers.set('Accept-Ranges','bytes');headers.set('ETag',object.httpEtag||object.etag);headers.set('Content-Length',String(object.size));headers.set('Cache-Control',path.endsWith('.m3u8')?'public, max-age=300':'public, max-age=31536000, immutable');
      cached=new Response(object.body,{status:200,headers});
      const cacheWrite=cache.put(cacheKey,cached.clone()).catch(()=>{});
      if(typeof waitUntil==='function')waitUntil(cacheWrite);
      else await cacheWrite;
    }
    let outgoing;
    if(requested){
      const size=Number(cached.headers.get('Content-Length'));
      // Match the registered voice asset limit; never buffer video segments.
      if(!Number.isSafeInteger(size)||size<1||size>1048576)return json({error:'VOICE_ASSET_INVALID'},502);
      const range=rangeFromHeader(requested,size);
      if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`,'Cache-Control':'private, no-store'}});
      const bytes=await cached.arrayBuffer(),headers=new Headers(cached.headers);
      if(bytes.byteLength!==size)return json({error:'VOICE_ASSET_INVALID'},502);
      headers.set('Content-Range',`bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length',String(range.end-range.start+1));
      outgoing=new Response(bytes.slice(range.start,range.end+1),{status:206,headers});
    }else outgoing=new Response(cached.body,cached);
    outgoing.headers.set('Cache-Control','private, no-store');outgoing.headers.set('X-Content-Type-Options','nosniff');timing(outgoing.headers,hit?'HIT':'MISS');return outgoing;
  }
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const range = requested ? rangeFromHeader(requested, head.size) : null;
  if (requested && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + head.size } });
  const object = headOnly ? head : await env.VIDEO_BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('ETag', object.httpEtag || object.etag);
  headers.set('Content-Length', String(range ? range.end - range.start + 1 : head.size));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
  headers.set('X-Content-Type-Options','nosniff');timing(headers,'BYPASS');
  return new Response(headOnly ? null : object.body, { status: range ? 206 : 200, headers });
}

export const onRequestGet = (context) => handle(context, false);
export const onRequestHead = (context) => handle(context, true);
