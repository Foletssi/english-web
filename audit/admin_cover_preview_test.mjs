import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { onRequestGet, onRequestHead } from '../functions/api/processing/media/[[path]].js';
import { sealPlaybackTicket } from '../functions/_lib/playback-ticket.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const job='00000000-0000-4000-8000-000000000001';
const user='00000000-0000-4000-8000-000000000002';
const run='00000000-0000-4000-8000-000000000004';
const prefix=`videos/00000000-0000-4000-8000-000000000003/processed/${job}/runs/${run}/`;
const env={SUPABASE_URL:'https://project.test',SUPABASE_SERVICE_ROLE_KEY:'service',PLAYBACK_TICKET_KEY:Buffer.alloc(32,9).toString('base64url')};
let allowed=true,available=true,missing=false,cacheReads=0,objectReads=0;
const calls=[],cached=new Map();
globalThis.fetch=async(url,options)=>{
  const name=String(url).split('/').pop(),args=JSON.parse(options.body);
  calls.push({name,args});
  if(!available)throw Error('test authorization unavailable');
  // Unpublished covers cannot use the established published-content lane.
  const preview=name==='service_resolve_admin_cover_preview_v1';
  return new Response(JSON.stringify(preview
    ? {canPreview:allowed&&args.p_run_id===run,objectKey:prefix+args.p_path}
    : {canPlay:!args.p_path.startsWith('cover'),objectKey:prefix+args.p_path}),{headers:{'Content-Type':'application/json'}});
};
const bytes=new TextEncoder().encode('cover');
const object={body:bytes,size:bytes.length,etag:'cover-etag',writeHttpMetadata(h){h.set('Content-Type','image/webp')}};
env.VIDEO_BUCKET={get:async()=>{objectReads++;return missing?null:object},head:async()=>missing?null:object};
globalThis.caches={default:{match:async r=>{cacheReads++;return cached.get(r.url)?.clone()},put:async(r,v)=>cached.set(r.url,v)}};
const ticket=await sealPlaybackTicket({aud:'eastudy-catalog',sub:user,exp:Math.floor(Date.now()/1000)+300},env);
const cookie='eastudy_catalog='+encodeURIComponent(ticket);
function context(path='cover.webp',query=`?previewRun=${run}`,auth=cookie){
  return {request:new Request(`https://site.test/api/processing/media/${job}/${path}${query}`,{headers:{Cookie:auth}}),env,params:{path:[job,...path.split('/')]}};
}
for(const expected of ['MISS','HIT']){
  const response=await onRequestGet(context());
  assert.equal(response.status,200,'current-run confirmed cover must be available before publication');
  assert.equal(response.headers.get('X-Eastudy-Media-Cache'),expected);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(await response.text(),'cover');
  assert.deepEqual(calls.at(-1),{name:'service_resolve_admin_cover_preview_v1',args:{p_user_id:user,p_job_id:job,p_run_id:run,p_path:'cover.webp'}});
}
assert.equal(objectReads,1);
assert.equal((await onRequestHead(context())).status,200);
allowed=false;
const before=cacheReads;
assert.equal((await onRequestGet(context())).status,403);
assert.equal(cacheReads,before,'authorization must precede cache lookup');
allowed=true;
assert.equal((await onRequestGet(context('cover.webp',`?previewRun=${run.replace(/4$/,'5')}`))).status,403);
assert.equal((await onRequestGet(context('cover.webp',`?previewRun=${run}`,''))).status,401);
for(const path of ['540p/index.m3u8','voice/'+'a'.repeat(64)+'.mp3','cover-1280.webp'])assert.equal((await onRequestGet(context(path))).status,400);
for(const query of ['?previewRun=','?previewRun=invalid',`?previewRun=${run}&previewRun=${run}`])assert.equal((await onRequestGet(context('cover.webp',query))).status,400);
for(const path of ['cover-320.webp','cover-640.webp','cover-960.webp'])assert.equal((await onRequestGet(context(path))).status,200);
available=false;
assert.equal((await onRequestGet(context())).status,503);
available=true;
cached.clear();missing=true;
assert.equal((await onRequestGet(context())).status,404);
missing=false;
assert.equal((await onRequestGet(context('cover.webp',''))).status,403);
assert.equal(calls.at(-1).name,'service_resolve_playback_access_v2');
assert.equal((await onRequestGet(context('voice/'+'a'.repeat(64)+'.mp3',''))).status,200);
delete globalThis.caches;
console.log('Admin cover preview route contracts passed.');

const adminSource=readFileSync(new URL('../admin/assets/admin.js',import.meta.url),'utf8');
function declaration(name,multiline=false){
  const start=adminSource.indexOf(`function ${name}(`);
  assert.ok(start>=0,`admin must implement ${name}`);
  const end=multiline?adminSource.indexOf('\n}',start)+2:adminSource.indexOf('\n',start);
  return adminSource.slice(start,end);
}
const sandbox={AdminAuth:{context:{user:{id:user}}},Cloud:{},images:[]};
sandbox.$$=()=>sandbox.images;
vm.createContext(sandbox);
vm.runInContext(['asset','escapeHtml'].map(n=>declaration(n)).concat(['jobCoverImage','bindCoverPreviews'].map(n=>declaration(n,true))).join('\n'),sandbox);
const preview=`/api/processing/media/${job}/cover-320.webp?previewRun=${run}`;
const coverJob={id:job,runId:run,previewCover:preview,cover:'assets/images/job.webp'};
const html=sandbox.jobCoverImage(coverJob,{cover:'assets/images/home_video_1.png'});
assert.ok(html.includes(`src="${preview}"`));
assert.ok(html.includes('data-cover-fallback="../assets/images/home_video_1.png"'));
for(const invalid of [undefined,'https://other.test'+preview,preview+'&extra=1',preview.replace(run,user),preview.replace(job,user),preview.replace('cover-320.webp','voice/a.mp3')]){
  const markup=sandbox.jobCoverImage({...coverJob,previewCover:invalid},{});
  assert.ok(!markup.includes('data-cover-preview'));
  assert.ok(markup.includes('src="../assets/images/job.webp"'));
}
assert.match(adminSource,/\$\{jobCoverImage\(j,v\)\}/,'job cards must use preview helper');
assert.match(adminSource,/function bindViewActions\(\)\{\s*bindCoverPreviews\(\)/);
function image(complete=false){return {dataset:{coverPreview:preview,coverFallback:'fallback.webp'},src:preview,isConnected:true,complete,naturalWidth:0,onerror:null}}
function mount(img){sandbox.images=[img];sandbox.bindCoverPreviews();return img}
let renewals=0;
sandbox.Cloud.syncMediaSession=async(scope,options)=>{renewals++;assert.equal(scope,'admin');assert.equal(options.force,true);assert.equal(options.mediaUrl,undefined);return {}};
let img=mount(image());
await img.onerror();
assert.equal(renewals,1);assert.equal(img.src,preview);
await img.onerror();
assert.equal(renewals,1);assert.equal(img.src,'fallback.webp');assert.equal(img.onerror,null);
let release;
sandbox.Cloud.syncMediaSession=()=>{renewals++;return new Promise(resolve=>{release=resolve})};
img=mount(image());
const pending=img.onerror();
await img.onerror();
assert.equal(renewals,2,'duplicate errors must not start another renewal');
release({});await pending;
for(const state of ['detached','account-change','stale']){
  sandbox.AdminAuth.context={user:{id:user}};
  img=mount(image());
  const retry=img.onerror();
  img.src='unchanged';
  if(state==='detached')img.isConnected=false;
  if(state==='account-change')sandbox.AdminAuth.context={user:{id:job}};
  release(state==='stale'?{stale:true}:{});await retry;
  assert.equal(img.src,state==='stale'?'fallback.webp':'unchanged');
  assert.equal(img.onerror,null);
}
sandbox.AdminAuth.context={user:{id:user}};
sandbox.Cloud.syncMediaSession=async()=>{throw Error('expired')};
img=mount(image());await img.onerror();assert.equal(img.src,'fallback.webp');
img=mount(image(true));await new Promise(resolve=>setImmediate(resolve));
assert.equal(img.src,'fallback.webp','already-failed images must also recover');
sandbox.AdminAuth.context=null;
img=mount(image());await img.onerror();assert.equal(img.onerror,null);

const sql=readFileSync(new URL('../supabase/migrations/20260919020000_admin_cover_preview.sql',import.meta.url),'utf8');
for(const fence of ["auth.role() is distinct from 'service_role'","v_access->>'kind' is distinct from 'ADMIN'","v_access->>'canPlay'",'j.run_id=p_run_id','r.run_id=j.run_id','r.confirmed_at is not null','r.sha256','r.etag','processingJobId','learningRepairJobId','content_video_trash','video_deletion_jobs'])assert.ok(sql.includes(fence),`missing SQL fence: ${fence}`);
assert.match(sql,/grant execute on function public\.service_resolve_admin_cover_preview_v1\(uuid,uuid,uuid,text\) to service_role/);
assert.ok(!sql.includes('create or replace function public.service_resolve_playback_access'),'published playback must not be replaced');
assert.match(sql,/processing_job_admin_summary_before_cover_20260919\(p_job,p_video\)\|\|jsonb_build_object/);
console.log('Admin cover UI and SQL source contracts passed (SQL not executed).');
