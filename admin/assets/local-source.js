(function(global){
  'use strict';
  const endpoint='http://127.0.0.1:8789';
  async function preserve(file,receipt){
    // This optimization is optional. The cloud completion receipt is authoritative.
    try{
      const ready=await fetch(endpoint+'/capability',{signal:AbortSignal.timeout(1500),cache:'no-store'});
      if(!ready.ok)return false;
      const {token}=await ready.json();
      const query=new URLSearchParams({key:receipt.key,etag:receipt.etag,size:String(file.size)});
      const saved=await fetch(endpoint+'/source?'+query,{method:'PUT',body:file,
        headers:{'Content-Type':'application/octet-stream','X-Eastudy-Intake':token},
        signal:AbortSignal.timeout(60000)});
      return saved.ok;
    }catch{return false}
  }
  global.EastudyLocalSource=Object.freeze({preserve});
})(window);
