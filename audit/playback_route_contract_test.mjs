import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { onRequestPost as createSession, onRequestGet as checkReadiness } from '../functions/api/session.js';
import { onRequestGet as readMedia } from '../functions/api/processing/media/[[path]].js';
import { openPlaybackTicket } from '../functions/_lib/playback-ticket.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const jobId='00000000-0000-4000-8000-000000000001';
const userId='00000000-0000-4000-8000-000000000002';
const prefix=`videos/00000000-0000-4000-8000-000000000003/processed/${jobId}/runs/00000000-0000-4000-8000-000000000004/`;
const env={SUPABASE_URL:'https://project.test',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service',PLAYBACK_TICKET_KEY:Buffer.alloc(32,9).toString('base64url')};
let upstreamCalls=0,serviceAvailable=true,isAdmin=true,currentLabel="720p";
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async (url, options={})=>{
  upstreamCalls+=1;
  const value=String(url);
  if(value.includes('/auth/v1/user'))return json({id:userId});
  if(value.includes('/rpc/is_admin'))return json(isAdmin);
  if(value.includes('/get_my_learning_access_v2'))return json([{canPlay:true,canEnterLearning:true,kind:'LEARNER',reason:'OK',expiresAt:'2099-01-01T00:00:00Z'}]);
  if(value.includes('/service_resolve_playback_access_v2')){
    if(!serviceAvailable)throw new Error('service unavailable');
    const requested=JSON.parse(options.body).p_path;
    const path=requested==='master.m3u8'?currentLabel+'/index.m3u8':requested;
    return json([{canPlay:true,canEnterLearning:true,kind:'LEARNER',reason:'OK',expiresAt:'2099-01-01T00:00:00Z',objectKey:prefix+path,prefix}]);
  }
  throw new Error('unexpected '+url);
};

const readinessRequest = () => new Request('https://site.test/api/session', {headers:{Authorization:'Bearer administrator-token'}});
const anonymousReadiness = await checkReadiness({request:new Request('https://site.test/api/session'),env});
assert.equal(anonymousReadiness.status,401,'configuration must not be public');
isAdmin=false;
assert.equal((await checkReadiness({request:readinessRequest(),env})).status,403,'learners must not inspect configuration');
isAdmin=true;
const missingReadiness=await checkReadiness({request:readinessRequest(),env:{SUPABASE_URL:env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:'public'}});
assert.equal(missingReadiness.status,503);
assert.deepEqual(await missingReadiness.json(),{ready:false,checks:{mediaBucket:false,authorizationCredential:false,ticketEncryption:false}});
const invalidReadiness=await checkReadiness({request:readinessRequest(),env:{...env,VIDEO_BUCKET:{},PLAYBACK_TICKET_KEY:'invalid'}});
assert.equal(invalidReadiness.status,503);
const goodReadiness=await checkReadiness({request:readinessRequest(),env:{...env,VIDEO_BUCKET:{}}});
assert.equal(goodReadiness.status,200);
assert.deepEqual(await goodReadiness.json(),{ready:true,checks:{mediaBucket:true,authorizationCredential:true,ticketEncryption:true}});

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
const mediaEnv={...env,VIDEO_BUCKET:{head:async key=>key===prefix+currentLabel+'/index.m3u8'?object:null,get:async key=>key===prefix+currentLabel+'/index.m3u8'?object:null}};
const callsBeforeMedia=upstreamCalls;
const mediaResponse=await readMedia({request:new Request(`https://site.test/api/processing/media/${jobId}/720p/index.m3u8`,{headers:{Cookie:`eastudy_playback=${encodeURIComponent(ticket)}`}}),env:mediaEnv,params:{path:[jobId,'720p','index.m3u8']}});
assert.equal(mediaResponse.status,200);
assert.equal(await mediaResponse.text(),'#EXTM3U\n');
assert.equal(upstreamCalls,callsBeforeMedia+1,'HLS reads must recheck current entitlement without repeating full Auth');

serviceAvailable=false;
const unavailable=await readMedia({request:new Request(`https://site.test/api/processing/media/${jobId}/720p/index.m3u8`,{headers:{Cookie:`eastudy_playback=${encodeURIComponent(ticket)}`}}),env:mediaEnv,params:{path:[jobId,'720p','index.m3u8']}});
assert.equal(unavailable.status,503,'entitlement service failures must not be reported as an invalid login session');
serviceAvailable=true;

const wrongJob='00000000-0000-4000-8000-000000000009';
const rejected=await readMedia({request:new Request(`https://site.test/api/processing/media/${wrongJob}/720p/index.m3u8`,{headers:{Cookie:`eastudy_playback=${encodeURIComponent(ticket)}`}}),env:mediaEnv,params:{path:[wrongJob,'720p','index.m3u8']}});
assert.equal(rejected.status,403);

currentLabel='540p';
const newSession=await createSession({request:new Request('https://site.test/api/session',{method:'POST',headers:{Authorization:'Bearer real-user-token','Content-Type':'application/json'},body:JSON.stringify({jobId})}),env});
assert.equal(newSession.status,200,'540P gets a playback ticket');
const newCookie=newSession.headers.get('set-cookie').split(';')[0];
for(const method of ['GET','HEAD']){
  const response=await readMedia({request:new Request(`https://site.test/api/processing/media/${jobId}/540p/index.m3u8`,{method,headers:{Cookie:newCookie}}),env:mediaEnv,params:{path:[jobId,'540p','index.m3u8']}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
}
const anonymous=await readMedia({request:new Request(`https://site.test/api/processing/media/${jobId}/540p/index.m3u8`),env:mediaEnv,params:{path:[jobId,'540p','index.m3u8']}});
assert.equal(anonymous.status,401);
console.log('Playback session and media route contract passed.');
