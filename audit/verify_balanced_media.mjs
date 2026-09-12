// Explicit production smoke test; credentials are supplied only in process environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const box = {window:{}};
vm.runInNewContext(fs.readFileSync('shared/supabase-config.js','utf8'),box);
const cfg=box.window.EASTUDY_SUPABASE_CONFIG, site='https://english-web-lce.pages.dev';
const {EASTUDY_TEST_ACCOUNT:account,EASTUDY_TEST_PASSWORD:password}=process.env;
if(!account||!password)throw new Error('Test account credentials required');
async function checked(url,init={}){
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw new Error(`HTTP ${response.status} at ${new URL(url).pathname}`);
 return response;
}
const login=await checked(cfg.url+'/functions/v1/learner-auth',{
 method:'POST',headers:{apikey:cfg.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({account,password})});
const {session}=await login.json();
assert.ok(session?.access_token,'Login must return a real session');
const headers={apikey:cfg.publishableKey,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'};
try{
 const catalogTicket=await checked(site+'/api/session',{method:'POST',headers,body:'{}'});
 const catalogCookies=catalogTicket.headers.getSetCookie().map(value=>value.split(';')[0]);
 const catalog=await (await checked(cfg.url+'/rest/v1/rpc/get_published_content',{method:'POST',headers,body:'{}'})).json();
 const snapshot=(Array.isArray(catalog)?catalog[0]:catalog).snapshot;
 const results=[];
 const tickets=[];
 for(const id of [1788926081632,1789024924932]){
  const video=snapshot.videos.find(row=>Number(row.id)===id);
  assert.ok(video);assert.equal(video.status,'PUBLISHED');assert.equal(video.mediaEncodingProfile,'balanced-720-v3');
  assert.deepEqual(video.playback.variants.map(row=>row.label),['720p']);
  const response=await checked(site+'/api/session',{method:'POST',headers,body:JSON.stringify({jobId:video.processingJobId})});
  const cookies=[...catalogCookies,...response.headers.getSetCookie().map(value=>value.split(';')[0])].join('; ');
  const url=new URL(video.playback.masterUrl,site);
  const manifest=await (await checked(url,{headers:{Cookie:cookies}})).text();
  assert.ok(manifest.includes('#EASTUDY-PROFILE:balanced-720-v3-'));
  assert.ok(manifest.includes('-a96-medium-seg4'));assert.ok(manifest.includes('#EXT-X-ENDLIST'));
  const names=manifest.split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
  const segments=[];
  for(const index of [0,Math.floor(names.length/2),names.length-1]){
   assert.match(names[index],/^segment_[0-9]{5}\.ts$/);
   const bytes=new Uint8Array(await (await checked(new URL(names[index],url),{headers:{Cookie:cookies}})).arrayBuffer());
   assert.ok(bytes.length>188);assert.equal(bytes[0],0x47);assert.equal(bytes.length%188,0);
   segments.push({index,bytes:bytes.length});
  }
  await checked(new URL(video.cover,site),{headers:{Cookie:cookies}});
  const anonymous=await fetch(url,{signal:AbortSignal.timeout(45000)});assert.equal(anonymous.status,401);
  results.push({id,title:video.titleZh||video.title,job:video.processingJobId,bytes:video.playbackBytes,segments:names.length,samples:segments});
  tickets.push({url,cookies});
 }
 const crossed=await fetch(tickets[1].url,{headers:{Cookie:tickets[0].cookies},signal:AbortSignal.timeout(45000)});
 assert.equal(crossed.status,403);
 console.log(JSON.stringify({ok:true,results,anonymousDenied:true,crossVideoDenied:true},null,2));
}finally{
 await checked(cfg.url+'/auth/v1/logout?scope=local',{method:'POST',headers});
}
