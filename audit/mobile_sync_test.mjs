import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../shared/cloud-content.js',import.meta.url),'utf8');
let owner='a',revision=1,calls=0,fail=false,release;
const cache=new Map(),snapshot={videos:[{id:'v1'}]};
const api={auth:{getSession:async()=>({data:{session:owner?{user:{id:owner}}:null}})},rpc:async(name,args)=>{
 assert.equal(name,'get_published_content_if_changed_v1');calls++;
 if(release)await new Promise(resolve=>release=resolve);
 return fail?{error:Error('VIP_EXPIRED')}:{data:[{snapshot:args.p_known_revision===revision?null:snapshot,revision,published_at:'now'}]};
}};
const window={EastudyAuth:{client:()=>api},localStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v),removeItem:k=>cache.delete(k)}};
vm.runInNewContext(source,{window,console,setTimeout,clearTimeout,AbortSignal});
const pull=window.EastudyCloudContent.pullPublished;
assert.deepEqual((await pull()).snapshot,snapshot);
assert.deepEqual((await pull()).snapshot,snapshot);assert.equal(calls,2,'cached content still checks live membership');
revision=2;assert.equal((await pull()).revision,2);
fail=true;assert.ok((await pull()).error);assert.equal(cache.size,0,'expired access purges cache');
fail=false;owner='b';assert.equal((await pull()).revision,2);
release=true;const pending=pull();await new Promise(resolve=>setTimeout(resolve,0));owner='c';release();release=null;
assert.equal((await pending).error.message,'ACCOUNT_CHANGED');
owner=null;assert.ok((await pull()).error);
console.log('Catalog version cache, live access and account switching passed.');

// Exercise the real outbox functions through failed requests, a reload, and an
// edit made while an older value is being saved. Cloud calls are test doubles.
const appSource=fs.readFileSync(new URL('../assets/js/app.js',import.meta.url),'utf8');
const queueSource=appSource.slice(appSource.indexOf('const preferencePending='),appSource.indexOf('function applySettings()'));
const durable=new Map();let account='a',saveFailure=true,finishSave,saveCalls=[];
function queueContext(){
 const context={Map,Set,JSON,Object,localStorage:{getItem:k=>durable.get(k),setItem:(k,v)=>durable.set(k,v)},
  currentStudentStorageId:()=>account,toast:()=>{},window:{addEventListener(){},EastudyData:{saveLearningPreferences:async(patch,expected)=>{
   saveCalls.push({patch,expected});if(finishSave)await new Promise(resolve=>finishSave=resolve);
   return saveFailure?{error:Error('offline')}:{data:{}};
  }}}};
 vm.createContext(context);vm.runInContext(queueSource,context);return context;
}
let queue=queueContext();
vm.runInContext("persistPreferences('a',{font:24})",queue);
await vm.runInContext("flushPreferences('a')",queue);
assert.equal(JSON.parse(durable.get('eastudy:preferences:pending:a')).font,24);
queue=queueContext();saveFailure=false;finishSave=true;
const firstSave=vm.runInContext("flushPreferences('a')",queue);
await new Promise(resolve=>setTimeout(resolve,0));
vm.runInContext("persistPreferences('a',{...pendingPreferences('a'),font:28})",queue);
const resume=finishSave;finishSave=null;resume();await firstSave;
assert.equal(saveCalls.at(-1).patch.font,28,'newer edits survive acknowledgment of an older request');
assert.equal(durable.get('eastudy:preferences:pending:a'),'{}');
account='b';const previousCalls=saveCalls.length;
await vm.runInContext("flushPreferences('a')",queue);assert.equal(saveCalls.length,previousCalls,'never send another account outbox');
console.log('Preference outbox: failed save, reload, concurrent edits and account isolation passed.');
