(function(global){
'use strict';

function create({video,source,onError,onState}){
  let hls=null,destroyed=false,mode='idle',networkRecoveries=0,mediaRecoveries=0;
  const playback=source?.playback||{};
  const mediaUrl=String(source?.mediaUrl||'');
  const master=String(playback.masterUrl||(/\.m3u8(?:$|[?#])/i.test(mediaUrl)?mediaUrl:''));
  const legacyFile=master?'':mediaUrl;

  function notify(kind,detail={}){onState?.({kind,mode,...detail})}
  function fail(code,data,retryable=true){onError?.({code,retryable,mode,data})}
  function position(){return {time:Number(video.currentTime)||0,playing:!video.paused}}
  function restore(state){
    const apply=()=>{
      if(destroyed)return;
      const duration=Number(video.duration);
      video.currentTime=Number.isFinite(duration)?Math.min(state.time,Math.max(0,duration-.05)):state.time;
      if(state.playing)video.play().catch(()=>notify('interaction-required'));
    };
    if(Number(video.readyState)>=1)apply();
    else video.addEventListener('loadedmetadata',apply,{once:true});
  }
  function destroyHls(){hls?.destroy();hls=null}
  function loadNative(url,state,nextMode){
    destroyHls();mode=nextMode;notify('loading',{urlKind:nextMode});
    video.src=url;video.load();if(state)restore(state);
  }
  function handleHlsError(data){
    if(!data?.fatal)return;
    const types=global.Hls?.ErrorTypes||{};
    if(data.type===types.NETWORK_ERROR&&networkRecoveries<2){networkRecoveries+=1;notify('recovering',{stage:'network',attempt:networkRecoveries});hls?.startLoad?.();return}
    if(data.type===types.MEDIA_ERROR&&mediaRecoveries<1){mediaRecoveries+=1;notify('recovering',{stage:'media',attempt:mediaRecoveries});hls?.recoverMediaError?.();return}
    fail(data.details||data.type||'HLS_FATAL',data,Boolean(data.type===types.NETWORK_ERROR));
  }
  function load(state){
    if(master&&global.Hls?.isSupported()){
      destroyHls();mode='hls.js';networkRecoveries=0;mediaRecoveries=0;notify('loading',{urlKind:'hls'});
      hls=new global.Hls({startLevel:0,maxBufferLength:20,maxMaxBufferLength:40,backBufferLength:30,maxBufferSize:12*1024*1024});
      hls.on(global.Hls.Events.MANIFEST_PARSED,()=>{if(destroyed)return;notify('manifest',{levels:(hls.levels||[]).length});if(state)restore(state)});
      hls.on(global.Hls.Events.ERROR,(_,data)=>handleHlsError(data));
      hls.attachMedia(video);hls.loadSource(master);return;
    }
    if(master&&video.canPlayType?.('application/vnd.apple.mpegurl')){loadNative(master,state,'native-hls');return}
    if(legacyFile){loadNative(legacyFile,state,'legacy-file');return}
    fail(master?'HLS_UNSUPPORTED':'MEDIA_SOURCE_MISSING',null,false);
  }

  load();
  return {
    get mode(){return mode},
    retry(){load(position())},
    destroy(){if(destroyed)return;destroyed=true;destroyHls();video.pause();video.removeAttribute('src');video.load()}
  };
}

global.EastudyMediaPlayer=Object.freeze({create});
})(window);
