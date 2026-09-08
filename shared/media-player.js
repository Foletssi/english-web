(function(global){
'use strict';
function create({video,select,source,onError}){
  let hls=null,destroyed=false;
  const playback=source?.playback||{},master=playback.masterUrl||source?.mediaUrl||'';
  const variants=Array.isArray(playback.variants)?playback.variants:[];
  const setOptions=levels=>{if(!select)return;select.innerHTML='<option value="auto">自动</option>'+levels.map((row,index)=>`<option value="${index}">${row.label||((row.height||0)+'p')}</option>`).join('');select.value='auto';select.disabled=!levels.length};
  const switchNative=index=>{const row=variants[index];if(!row?.url)return;const time=video.currentTime,playing=!video.paused;video.src=row.url;video.load();video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(time,video.duration||time);if(playing)video.play().catch(()=>{})},{once:true})};
  const change=()=>{if(destroyed)return;const value=select?.value||'auto';if(hls){hls.currentLevel=value==='auto'?-1:Number(value);hls.nextLevel=hls.currentLevel}else if(value!=='auto')switchNative(Number(value))};
  if(select)select.addEventListener('change',change);
  if(master&&global.Hls?.isSupported()){
    hls=new global.Hls({startLevel:-1,capLevelToPlayerSize:true,maxBufferLength:30});
    hls.loadSource(master);hls.attachMedia(video);
    hls.on(global.Hls.Events.MANIFEST_PARSED,(_,data)=>setOptions((data.levels||hls.levels||[]).map(level=>({height:level.height,label:level.height?`${level.height}p`:'清晰度'}))));
    hls.on(global.Hls.Events.ERROR,(_,data)=>{if(data.fatal)onError?.(data)});
  }else{
    setOptions(variants);
    if(master){video.src=master;video.load()}
  }
  return {get mode(){return hls?'hls.js':'native'},setQuality(value){if(select){select.value=value;change()}},destroy(){if(destroyed)return;destroyed=true;if(select)select.removeEventListener('change',change);hls?.destroy();hls=null;video.pause();video.removeAttribute('src');video.load()}};
}
global.EastudyMediaPlayer={create};
})(window);
