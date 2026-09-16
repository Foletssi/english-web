import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('shared/cloud-content.js','utf8');
let fireTimeout,cleared=0,mode='hang';
const window={};
vm.runInNewContext(source,{window,AbortController,console,
 setTimeout(callback,delay){assert.equal(delay,8000);fireTimeout=callback;return 7},
 clearTimeout(id){assert.equal(id,7);cleared++},
 fetch:async(_url,{signal})=>{
  if(mode==='ok')return {ok:true,json:async()=>({ready:true})};
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 }});
const pending=window.EastudyCloudContent.processingHealth();
fireTimeout();
const failed=await pending;
assert.equal(failed.data,null);
assert.match(failed.error.message,/aborted/);
assert.equal(cleared,1,'timeout path releases timer');
mode='ok';
assert.equal((await window.EastudyCloudContent.processingHealth()).data.ready,true);
assert.equal(cleared,2,'successful health check releases timer');
console.log('Processing health: hanging fetch terminates and subsequent check recovers.');
