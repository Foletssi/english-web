/* M05: account-scoped, durable preference patches; never flush another account. */
(function(global){
 'use strict';
 function create({storage,getOwner,save,onError}){
  const pending=new Map(),running=new Set();
  const key=owner=>'eastudy:preferences:pending:'+owner;
  function read(owner){
   if(!pending.has(owner)){try{const value=JSON.parse(storage.getItem(key(owner))||'{}');pending.set(owner,value&&typeof value==='object'&&!Array.isArray(value)?value:{})}catch{pending.set(owner,{})}}
   return {...pending.get(owner)};
  }
  function persist(owner,patch){pending.set(owner,{...patch});try{storage.setItem(key(owner),JSON.stringify(patch))}catch{}}
  function enqueue(owner,patch){if(owner&&owner!=='signed-out')persist(owner,{...read(owner),...patch})}
  async function flush(owner){
   if(!owner||owner==='signed-out'||running.has(owner)||owner!==getOwner())return;
   running.add(owner);
   try{while(owner===getOwner()&&Object.keys(read(owner)).length){
    const patch=read(owner);let result;
    try{result=await save(patch,owner)}catch(error){result={error}}
    if(result?.error){if(owner===getOwner())onError?.(result.error);break}
    const remaining=read(owner);for(const name of Object.keys(patch))if(JSON.stringify(remaining[name])===JSON.stringify(patch[name]))delete remaining[name];persist(owner,remaining);
   }}finally{running.delete(owner)}
  }
  return Object.freeze({read,enqueue,flush});
 }
 global.EastudyPreferenceSync=Object.freeze({create});
})(window);
