(function(global){
'use strict';

function create({video,select,source,onError,onState,onQuality}){
  let hls=null,destroyed=false,mode='idle',quality='auto',networkRecoveries=0,mediaRecoveries=0;
  const playback=source?.playback||{};
  const mediaUrl=String(source?.mediaUrl||'');
  const master=String(playback.masterUrl||(/\.m3u8(?:$|[?#])/i.test(mediaUrl)?mediaUrl:''));
  const variants=Array.isArray(playback.variants)?playback.variants:[];
  const original=playback.original||{};

  function notify(kind,detail={}){onState?.({kind,mode,quality,...detail})}
  function fail(code,data,retryable=true){onError?.({code,retryable,mode,data})}
  function safeLevel(value){
    const level=Number(value);
    return Number.isInteger(level)&&level>=0&&level<(hls?.levels?.length||variants.length)?level:-1;
  }
  function optionRows(levels){
    const rows=[['auto','自动画质']];
    levels.forEach((row,index)=>rows.push([String(index),row.label||((row.height||0)+'p')]));
    if(original.url)rows.push(['original',original.label||'1080p 原画']);
    return rows;
  }
  function setOptions(levels){
    if(!select)return;
    select.innerHTML=optionRows(levels).map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
    select.value=quality;
    if(select.value!==quality){quality='auto';select.value='auto'}
    select.disabled=!master&&!original.url&&!mediaUrl;
  }
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
  function loadNative(url,state,nextMode='file'){
    destroyHls();mode=nextMode;notify('loading',{urlKind:nextMode});
    video.src=url;video.load();if(state)restore(state);
  }
  function reportLevel(index){
    const row=hls?.levels?.[index]||variants[index]||{};
    onQuality?.({mode:quality,currentLevel:index,height:Number(row.height)||null,label:row.label||''});
  }
  function handleHlsError(data){
    if(!data?.fatal)return;
    const ErrorTypes=global.Hls?.ErrorTypes||{};
    if(data.type===ErrorTypes.NETWORK_ERROR&&networkRecoveries<2){networkRecoveries+=1;notify('recovering',{stage:'network',attempt:networkRecoveries});hls?.startLoad?.();return}
    if(data.type===ErrorTypes.MEDIA_ERROR&&mediaRecoveries<1){mediaRecoveries+=1;notify('recovering',{stage:'media',attempt:mediaRecoveries});hls?.recoverMediaError?.();return}
    fail(data.details||data.type||'HLS_FATAL',data,Boolean(data.type===ErrorTypes.NETWORK_ERROR));
  }
  function loadHls(level='auto',state){
    if(!master){
      if(original.url||mediaUrl)loadNative(original.url||mediaUrl,state,'file');
      else fail('MEDIA_SOURCE_MISSING',null,false);
      return;
    }
    if(global.Hls?.isSupported()){
      destroyHls();mode='hls.js';networkRecoveries=0;mediaRecoveries=0;notify('loading',{urlKind:'hls'});
      const requested=level==='auto'?-1:safeLevel(level);
      hls=new global.Hls({startLevel:requested,capLevelToPlayerSize:true,maxBufferLength:30});
      hls.on(global.Hls.Events.MANIFEST_PARSED,(_,data)=>{
        if(destroyed)return;
        const levels=(data.levels||hls.levels||[]).map(item=>({height:item.height,label:item.height?`${item.height}p`:'清晰度'}));
        setOptions(levels);hls.currentLevel=requested;hls.nextLevel=requested;notify('manifest',{levels:levels.length});
        if(state)restore(state);
      });
      hls.on(global.Hls.Events.ERROR,(_,data)=>handleHlsError(data));
      if(global.Hls.Events.LEVEL_SWITCHED)hls.on(global.Hls.Events.LEVEL_SWITCHED,(_,data)=>reportLevel(data.level));
      hls.attachMedia(video);hls.loadSource(master);
    }else if(video.canPlayType?.('application/vnd.apple.mpegurl')){
      mode='native-hls';quality='auto';setOptions([]);loadNative(master,state,'native-hls');onQuality?.({mode:'auto',currentLevel:null,height:null,label:'浏览器控制'});
    }else if(original.url||mediaUrl){
      quality=original.url?'original':'auto';loadNative(original.url||mediaUrl,state,'file');setOptions([]);
      onQuality?.({mode:quality,currentLevel:null,height:Number(original.height)||null,label:'兼容画质'});
    }else fail('HLS_UNSUPPORTED',null,false);
  }
  function change(){
    if(destroyed)return;
    const next=select?.value||'auto';if(next===quality)return;
    const state=position();quality=next;
    if(next==='original')loadNative(original.url,state,'file');
    else if(hls){const level=next==='auto'?-1:safeLevel(next);hls.currentLevel=level;hls.nextLevel=level;reportLevel(level)}
    else loadHls(next,state);
  }

  if(select)select.addEventListener('change',change);
  setOptions(variants);
  if(master)loadHls('auto');
  else if(original.url||mediaUrl)loadNative(original.url||mediaUrl,null,'file');
  else fail('MEDIA_SOURCE_MISSING',null,false);

  return {
    get mode(){return mode},
    get quality(){return quality},
    setQuality(value){if(select){select.value=value;change()}},
    retry(){const state=position();if(master)loadHls(quality==='original'?'auto':quality,state);else loadNative(original.url||mediaUrl,state,'file')},
    destroy(){
      if(destroyed)return;destroyed=true;
      if(select)select.removeEventListener('change',change);
      destroyHls();video.pause();video.removeAttribute('src');video.load();
    }
  };
}

global.EastudyMediaPlayer=Object.freeze({create});
})(window);
