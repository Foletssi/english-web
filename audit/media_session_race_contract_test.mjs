import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const jobId='00000000-0000-4000-8000-000000000001';
let finishPost,deleteSeen=false,clearFinished=false;
const fetch=async(path,init={})=>{
  if(init.method==='POST')return new Promise(resolve=>{finishPost=()=>resolve(new Response(JSON.stringify({expiresAt:Math.floor(Date.now()/1000)+300}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':'eastudy_playback=late'}}))});
  if(init.method==='DELETE'){deleteSeen=true;return new Response('{}',{status:200})}
  throw new Error('unexpected request '+path);
};
const api={auth:{getSession:async()=>({data:{session:{access_token:'token',expires_at:Math.floor(Date.now()/1000)+300,user:{id:'user-1'}}},error:null})}};
const window={EastudyAuth:{client:()=>api},setTimeout,clearTimeout,dispatchEvent(){}};
const context=vm.createContext({window,fetch,console,setTimeout,clearTimeout,Headers,Response,CustomEvent:class{},Date});
vm.runInContext(fs.readFileSync('shared/cloud-content.js','utf8'),context);
const syncing=window.EastudyCloudContent.syncMediaSession('student',{mediaUrl:`/api/processing/media/${jobId}/720p/index.m3u8`});
await new Promise(resolve=>setTimeout(resolve,0));
const clearing=window.EastudyCloudContent.clearMediaSession().then(()=>{clearFinished=true});
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(clearFinished,false,'logout cleanup must wait for an in-flight Set-Cookie response');
finishPost();
await Promise.all([syncing,clearing]);
assert.equal(deleteSeen,true,'late ticket must be cleared after the pending response settles');
assert.equal(clearFinished,true);
console.log('Media session logout race contract passed.');
