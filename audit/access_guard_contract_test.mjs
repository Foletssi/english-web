import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const windowListeners=new Map(),documentListeners=new Map();
let timerCallback=null,cleared=0,denied=null;
const window={
  setInterval(callback){timerCallback=callback;return 7},clearInterval(id){assert.equal(id,7);cleared+=1},
  addEventListener(name,callback){windowListeners.set(name,callback)},removeEventListener(name){windowListeners.delete(name)}
};
const document={hidden:false,addEventListener(name,callback){documentListeners.set(name,callback)},removeEventListener(name){documentListeners.delete(name)}};
const context=vm.createContext({window,document,console,globalThis:window});
vm.runInContext(fs.readFileSync('shared/access-guard.js','utf8'),context);
window.EastudyAccessGuard.start({intervalMs:60000,check:async()=>({access:{canEnterLearning:false,reason:'VIP_EXPIRED'}}),onDenied:access=>{denied=access.reason}});
await timerCallback();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(denied,'VIP_EXPIRED');
assert.equal(cleared,1);
assert.equal(windowListeners.has('focus'),false);
assert.equal(documentListeners.has('visibilitychange'),false);
console.log('Learner access guard lifecycle contract passed.');
