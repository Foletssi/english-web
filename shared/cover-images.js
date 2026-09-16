/* M02: native responsive images and bounded catalogue-cover recovery. */
(function(global){
  'use strict';
  const placeholder='assets/images/video_cover_pending.svg';
  const attempts=new WeakMap(),pending=[],failed=new Set();
  let renewal=null,active=0,renewedAt=0,renewedOwner=null;
  function protectedCover(value){
    try{const url=new URL(value,location.href);return url.origin===location.origin&&/^\/api\/processing\/media\/[0-9a-f-]{36}\/cover(?:-(?:320|640|960))?\.webp$/i.test(url.pathname)?url.href:null}catch{return null}
  }
  function attributes(video,options={}){
    const src=String(video?.cover||placeholder),base=protectedCover(src),seen=new Set();
    const variants=(Array.isArray(video?.coverImages)?video.coverImages:[]).filter(row=>{
      const url=protectedCover(row?.url);
      if(!base||!url||new URL(base).pathname.split('/')[4]!==new URL(url).pathname.split('/')[4]||!Number.isInteger(row.width)||row.width<1||row.width>960||!Number.isInteger(row.height)||row.height<1||row.height>540||!(row.bytes>0)||seen.has(row.width))return false;
      seen.add(row.width);return true;
    }).sort((a,b)=>a.width-b.width);
    return {src,width:'640',height:'360',decoding:'async',loading:options.eager?'eager':'lazy',...(variants.length?{srcset:variants.map(row=>protectedCover(row.url)+' '+row.width+'w').join(', '),sizes:options.sizes||'(max-width:850px) calc((100vw - 34px)/2), 320px'}:{})};
  }
  function apply(image,video,options){
    image.removeAttribute('srcset');image.removeAttribute('sizes');
    const attrs=attributes(video,options);
    for(const key of ['width','height','loading','decoding','sizes','srcset','src'])if(attrs[key])image.setAttribute(key,attrs[key]);
  }
  function refresh(){
    const owner=global.__eastudyStudentId;
    if(owner===renewedOwner&&Date.now()-renewedAt<10000)return Promise.resolve();
    if(!renewal)renewal=Promise.resolve().then(()=>global.EastudyCloudContent.syncMediaSession('student',{force:true})).then(()=>{renewedOwner=owner;renewedAt=Date.now()}).finally(()=>{renewal=null});
    return renewal;
  }
  function enqueue(task){return new Promise(resolve=>{pending.push(async()=>{try{await task()}finally{resolve()}});pump()})}
  function pump(){while(active<3&&pending.length){active++;pending.shift()().finally(()=>{active--;pump()})}}
  function restore(image,state){
    image.removeAttribute('srcset');image.removeAttribute('src');
    if(state.srcset)image.setAttribute('srcset',state.srcset);
    image.src=state.src;
  }
  async function recover(image){
    const source=protectedCover(image.currentSrc||image.src),owner=global.__eastudyStudentId;
    if(!source)return;
    let state=attempts.get(image);
    if(!state||state.source!==source||state.owner!==owner){state={source,owner,src:image.src,srcset:image.getAttribute('srcset'),retries:0,renewed:false,busy:false};attempts.set(image,state)}
    if(state.busy)return;
    state.busy=true;
    await enqueue(async()=>{
      const current=()=>image.isConnected&&attempts.get(image)===state&&state.owner===global.__eastudyStudentId&&protectedCover(image.currentSrc||image.src)===source;
      if(!current()){state.busy=false;return}
      const fallback=retryable=>{if(current()){image.removeAttribute('srcset');image.src=placeholder;image.dataset.coverFailed='true';if(retryable)failed.add(image)}};
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
      try{
        let status=0;
        try{status=(await fetch(source,{method:'HEAD',credentials:'same-origin',signal:controller.signal})).status}catch{/* Unknown network failure. */}
        if(!current())return;
        if(status===401&&!state.renewed){state.renewed=true;await refresh()}
        else if((status===0||status>=500||status===200)&&state.retries<2){state.retries++;await new Promise(resolve=>setTimeout(resolve,800*state.retries))}
        else{fallback(status===0||status>=500);return}
        if(current()){state.busy=false;restore(image,state)}
      }catch{fallback(true)}finally{clearTimeout(timeout);state.busy=false}
    });
  }
  function retryFailed(){
    for(const image of failed){failed.delete(image);const state=attempts.get(image);
      if(!image.isConnected||!state||state.owner!==global.__eastudyStudentId||image.getAttribute('src')!==placeholder)continue;
      attempts.delete(image);delete image.dataset.coverFailed;restore(image,state);
    }
  }
  document.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement)void recover(event.target)},true);
  global.addEventListener('online',retryFailed);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)retryFailed()});
  global.EastudyCoverImages=Object.freeze({protectedCover,attributes,apply,retryFailed});
})(window);
