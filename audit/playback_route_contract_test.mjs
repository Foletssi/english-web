import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { onRequestPost as createSession } from '../functions/api/session.js';
import { onRequestGet as readMedia } from '../functions/api/processing/media/[[path]].js';
import { openPlaybackTicket } from '../functions/_lib/playback-ticket.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const jobId='00000000-0000-4000-8000-000000000001';
const userId='00000000-0000-4000-8000-000000000002';
const prefix=`videos/00000000-0000-4000-8000-000000000003/processed/${jobId}/runs/00000000-0000-4000-8000-000000000004/`;
const env={SUPABASE_URL:'https://project.test',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service',PLAYBACK_TICKET_KEY:Buffer.alloc(32,9).toString('base64url')};
let upstreamCalls=0;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async url=>{
  upstreamCalls+=1;
  const value=String(url);
  if(value.includes('/auth/v1/user'))return json({id:userId});
  if(value.includes('/get_my_learning_access_v2'))return json([{canPlay:true,canEnterLearning:true,kind:'LEARNER',reason:'OK',expiresAt:'2099-01-01T00:00:00Z'}]);
  if(value.includes('/service_resolve_playback_access_v2'))return json([{canPlay:true,canEnterLearning:true,kind:'LEARNER',reason:'OK',expiresAt:'2099-01-01T00:00:00Z',objectKey:prefix+'720p/index.m3u8',prefix}]);
  throw new Error('unexpected '+url);
};

const sessionResponse=await createSession({request:new Request('https://site.test/api/session',{method:'POST',headers:{Authorization:'Bearer real-user-token','Content-Type':'application/json'},body:JSON.stringify({jobId})}),env});
assert.equal(sessionResponse.status,200);
const setCookie=sessionResponse.headers.get('set-cookie')||'';
assert.match(setCookie,/eastudy_playback=/);
assert.ok(!setCookie.includes('real-user-token'),'the Supabase access token must never be copied into a media cookie');
const encoded=/eastudy_playback=([^;]+)/.exec(setCookie)?.[1];
const ticket=decodeURIComponent(encoded||'');
const payload=await openPlaybackTicket(ticket,env);
assert.deepEqual({sub:payload.sub,job:payload.job,prefix:payload.prefix},{sub:userId,job:jobId,prefix});

const body=new TextEncoder().encode('#EXTM3U\n');
const object={body,size:body.length,etag:'etag',httpEtag:'"etag"',writeHttpMetadata(headers){headers.set('Content-Type','application/vnd.apple.mpegurl')}};
const mediaEnv={...env,VIDEO_BUCKET:{head:async key=>key===prefix+'720p/index.m3u8'?object:null,get:async key=>key===prefix+'720p/index.m3u8'?object:null}};
const callsBeforeMedia=upstreamCalls;
const mediaResponse=await readMedia({request:new Request(`https://site.test/api/processing/media/${jobId}/720p/index.m3u8`,{headers:{Cookie:`eastudy_playback=${encodeURIComponent(ticket)}`}}),env:mediaEnv,params:{path:[jobId,'720p','index.m3u8']}});
assert.equal(mediaResponse.status,200);
assert.equal(await mediaResponse.text(),'#EXTM3U\n');
assert.equal(upstreamCalls,callsBeforeMedia,'HLS reads must validate the short ticket without repeating Auth/RPC calls');

const wrongJob='00000000-0000-4000-8000-000000000009';
const rejected=await readMedia({request:new Request(`https://site.test/api/processing/media/${wrongJob}/720p/index.m3u8`,{headers:{Cookie:`eastudy_playback=${encodeURIComponent(ticket)}`}}),env:mediaEnv,params:{path:[wrongJob,'720p','index.m3u8']}});
assert.equal(rejected.status,403);

console.log('Playback session and media route contract passed.');
