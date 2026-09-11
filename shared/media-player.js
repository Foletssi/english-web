(function(global){
'use strict';

function create({video,source,onError,onState,authorize}){
  let hls=null,destroyed=false,mode='idle',generation=0,networkRecoveries=0,mediaRecoveries=0,authorizationRecoveries=0;
  let readyPromise=Promise.resolve(),cancelPendingLoad=null,loadController=null,playIntent=0,wantsPlay=false;
  const playback=source?.playback||{};
  const mediaUrl=String(source?.mediaUrl||'');
  const master=String(playback.masterUrl||(/\.m3u8(?:$|[?#])/i.test(mediaUrl)?mediaUrl:''));
  const legacyFile=master?'':mediaUrl;

  function notify(kind,detail={}){onState?.({kind,mode,...detail})}
  function fail(code,data,retryable=true){onError?.({code,retryable,mode,data})}
  function position(){return {time:Number(video.currentTime)||0,playing:!video.paused}}
  function applyPosition(state,own){
    if(!state||destroyed||own!==generation)return;
    const duration=Number(video.duration),time=Math.max(0,Number(state.time)||0);
    video.currentTime=Number.isFinite(duration)?Math.min(time,Math.max(0,duration-.05)):time;
  }
  function destroyHls(){hls?.destroy();hls=null}
  function statusCode(data){return Number(data?.response?.code||data?.response?.status)||0}

  async function authorizeSource(force,signal){
    if(typeof authorize==='function')await authorize({mediaUrl:master||legacyFile,force:Boolean(force),signal});
  }

  function waitBounded(promise,{signal,timeoutMs=20000}={}){
    return new Promise((resolve,reject)=>{
      let finished=false,timer;
      const end=(callback,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener?.('abort',abort);callback(value)};
      const abort=()=>end(reject,Object.assign(new Error('MEDIA_LOAD_CANCELLED'),{name:'AbortError',code:'MEDIA_LOAD_CANCELLED'}));
      if(signal?.aborted)return abort();
      signal?.addEventListener?.('abort',abort,{once:true});
      timer=setTimeout(()=>end(reject,Object.assign(new Error('MEDIA_LOAD_TIMEOUT'),{code:'MEDIA_LOAD_TIMEOUT',stage:'media'})),timeoutMs);
      Promise.resolve(promise).then(value=>end(resolve,value),error=>end(reject,error));
    });
  }

  function loadHls(state,own){
    return new Promise((resolve,reject)=>{
      let settled=false,current=null;
      const finish=callback=>{if(cancelPendingLoad===cancel)cancelPendingLoad=null;callback()};
      const cancel=()=>{if(settled)return;settled=true;finish(resolve)};
      const resolveReady=()=>{if(settled)return;if(destroyed||own!==generation)return cancel();settled=true;notify('manifest',{levels:(current?.levels||[]).length});applyPosition(state,own);finish(resolve)};
      const rejectReady=(error,code,data,retryable)=>{if(settled){fail(code,data,retryable);return}settled=true;fail(code,data,retryable);finish(()=>reject(error))};
      cancelPendingLoad=cancel;
      current=new global.Hls({startLevel:0,maxBufferLength:20,maxMaxBufferLength:40,backBufferLength:30,maxBufferSize:12*1024*1024});
      hls=current;
      current.on(global.Hls.Events.MANIFEST_PARSED,resolveReady);
      current.on(global.Hls.Events.ERROR,(_,data)=>{
        if(destroyed||own!==generation||!data?.fatal)return;
        const types=global.Hls?.ErrorTypes||{},status=statusCode(data),code=data.details||data.type||'HLS_FATAL';
        if(data.type===types.NETWORK_ERROR&&status===401&&authorizationRecoveries<1){
          authorizationRecoveries+=1;notify('recovering',{stage:'authorization',attempt:authorizationRecoveries});
          const resume=position(),resumeIntent=playIntent,resumeWanted=wantsPlay;
          const recovery=load(resume,{forceAuthorization:true,preserveAuthorizationBudget:true}),recoveryGeneration=generation;
          recovery.then(()=>{if(!destroyed&&generation===recoveryGeneration&&resumeWanted&&wantsPlay&&playIntent===resumeIntent)video.play().catch(error=>{if(error?.name==='NotAllowedError')notify('interaction-required')})}).catch(()=>{});
          return;
        }
        if(data.type===types.NETWORK_ERROR&&![401,403,404,410].includes(status)&&networkRecoveries<2){
          networkRecoveries+=1;notify('recovering',{stage:'network',attempt:networkRecoveries});current.startLoad?.();return;
        }
        if(data.type===types.MEDIA_ERROR&&mediaRecoveries<1){
          mediaRecoveries+=1;notify('recovering',{stage:'media',attempt:mediaRecoveries});current.recoverMediaError?.();return;
        }
        const retryable=data.type===types.NETWORK_ERROR&&![403,404,410].includes(status);
        rejectReady(Object.assign(new Error(code),{status,stage:'media'}),code,data,retryable);
      });
      current.attachMedia(video);current.loadSource(master);
    });
  }

  function loadNative(url,state,nextMode,own){
    return new Promise((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{video.removeEventListener?.('loadedmetadata',onReady);video.removeEventListener?.('error',onFailure)};
      const finish=callback=>{cleanup();if(cancelPendingLoad===cancel)cancelPendingLoad=null;callback()};
      const cancel=()=>{if(settled)return;settled=true;finish(resolve)};
      const onReady=()=>{if(settled)return;if(destroyed||own!==generation)return cancel();settled=true;applyPosition(state,own);notify('manifest',{levels:1});finish(resolve)};
      const onFailure=()=>{if(settled)return;settled=true;const error=Object.assign(new Error('MEDIA_ELEMENT_ERROR'),{stage:'media'});fail('MEDIA_ELEMENT_ERROR',video.error,false);finish(()=>reject(error))};
      cancelPendingLoad=cancel;
      mode=nextMode;notify('loading',{urlKind:nextMode});
      video.addEventListener?.('loadedmetadata',onReady,{once:true});video.addEventListener?.('error',onFailure,{once:true});
      video.src=url;video.load();if(Number(video.readyState)>=1)onReady();
    });
  }

  function load(state=null,{forceAuthorization=false,preserveAuthorizationBudget=false}={}){
    loadController?.abort();loadController=null;cancelPendingLoad?.();cancelPendingLoad=null;
    const own=++generation;
    const controller=new AbortController();loadController=controller;
    destroyHls();networkRecoveries=0;mediaRecoveries=0;
    if(!preserveAuthorizationBudget)authorizationRecoveries=0;
    if(master&&global.Hls?.isSupported())mode='hls.js';
    else if(master&&video.canPlayType?.('application/vnd.apple.mpegurl'))mode='native-hls';
    else if(legacyFile)mode='legacy-file';
    readyPromise=waitBounded((async()=>{
      await authorizeSource(forceAuthorization,controller.signal);
      if(destroyed||own!==generation)return;
      if(master&&global.Hls?.isSupported()){
        notify('loading',{urlKind:'hls'});await loadHls(state,own);return;
      }
      if(master&&video.canPlayType?.('application/vnd.apple.mpegurl')){await loadNative(master,state,'native-hls',own);return}
      if(legacyFile){await loadNative(legacyFile,state,'legacy-file',own);return}
      const code=master?'HLS_UNSUPPORTED':'MEDIA_SOURCE_MISSING',error=Object.assign(new Error(code),{stage:'media'});
      fail(code,null,false);throw error;
    })(),{signal:controller.signal,timeoutMs:20000}).finally(()=>{if(loadController===controller)loadController=null});
    readyPromise.catch(()=>{});
    return readyPromise;
  }

  load();
  return {
    get mode(){return mode},
    get ready(){return readyPromise},
    async play(){
      wantsPlay=true;const intent=++playIntent,own=generation,ready=readyPromise;
      try{await ready;if(destroyed||own!==generation||intent!==playIntent||!wantsPlay)return;return await video.play()}
      catch(error){if(destroyed||own!==generation||intent!==playIntent||!wantsPlay||error?.name==='AbortError')return;if(error?.name==='NotAllowedError'){wantsPlay=false;notify('interaction-required');return}fail(error?.code||'PLAYBACK_FAILED',error,true)}
    },
    pause(){wantsPlay=false;++playIntent;video.pause();notify('paused')},
    retry(){return load(position(),{forceAuthorization:true})},
    destroy(){if(destroyed)return;destroyed=true;wantsPlay=false;++playIntent;loadController?.abort();loadController=null;cancelPendingLoad?.();cancelPendingLoad=null;++generation;destroyHls();video.pause();video.removeAttribute('src');video.load()}
  };
}

global.EastudyMediaPlayer=Object.freeze({create});
})(window);
