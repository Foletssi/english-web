(function(global){
'use strict';

function create({video,select,source,onError}){
  let hls=null,destroyed=false,mode='native',quality='auto';
  const playback=source?.playback||{};
  const master=playback.masterUrl||source?.mediaUrl||'';
  const variants=Array.isArray(playback.variants)?playback.variants:[];
  const original=playback.original||{};

  function optionRows(levels){
    const rows=[['auto','自动']];
    levels.forEach((row,index)=>rows.push([String(index),row.label||((row.height||0)+'p')]));
    if(original.url)rows.push(['original',original.label||'1080p 原画']);
    return rows;
  }

  function setOptions(levels){
    if(!select)return;
    select.innerHTML=optionRows(levels).map(([value,label])=>
      `<option value="${value}">${label}</option>`).join('');
    select.value=quality;
    if(select.value!==quality){quality='auto';select.value='auto'}
    select.disabled=!master&&!original.url;
  }

  function position(){
    return {time:Number(video.currentTime)||0,playing:!video.paused};
  }

  function restore(state){
    const apply=()=>{
      if(destroyed)return;
      const duration=Number(video.duration);
      video.currentTime=Number.isFinite(duration)?Math.min(state.time,Math.max(0,duration-.05)):state.time;
      if(state.playing)video.play().catch(()=>{});
    };
    if(Number(video.readyState)>=1)apply();
    else video.addEventListener('loadedmetadata',apply,{once:true});
  }

  function destroyHls(){
    hls?.destroy();
    hls=null;
  }

  function loadNative(url,state){
    destroyHls();
    mode='native';
    video.src=url;
    video.load();
    if(state)restore(state);
  }

  function loadHls(level='auto',state){
    if(!master)return;
    if(global.Hls?.isSupported()){
      destroyHls();
      mode='hls.js';
      hls=new global.Hls({startLevel:level==='auto'?-1:Number(level),capLevelToPlayerSize:true,maxBufferLength:30});
      hls.loadSource(master);
      hls.attachMedia(video);
      hls.on(global.Hls.Events.MANIFEST_PARSED,(_,data)=>{
        const levels=(data.levels||hls.levels||[]).map(item=>({height:item.height,label:item.height?`${item.height}p`:'清晰度'}));
        setOptions(levels);
        hls.currentLevel=level==='auto'?-1:Number(level);
        hls.nextLevel=hls.currentLevel;
        if(state)restore(state);
      });
      hls.on(global.Hls.Events.ERROR,(_,data)=>{if(data.fatal)onError?.(data)});
    }else{
      const row=level==='auto'?null:variants[Number(level)];
      loadNative(row?.url||master,state);
      setOptions(variants);
    }
  }

  function change(){
    if(destroyed)return;
    const next=select?.value||'auto';
    if(next===quality)return;
    const state=position();
    quality=next;
    if(next==='original')loadNative(original.url,state);
    else if(hls){
      hls.currentLevel=next==='auto'?-1:Number(next);
      hls.nextLevel=hls.currentLevel;
    }else loadHls(next,state);
  }

  if(select)select.addEventListener('change',change);
  setOptions(variants);
  if(master)loadHls('auto');
  else if(original.url)loadNative(original.url);

  return {
    get mode(){return mode},
    setQuality(value){if(select){select.value=value;change()}},
    destroy(){
      if(destroyed)return;
      destroyed=true;
      if(select)select.removeEventListener('change',change);
      destroyHls();
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  };
}

global.EastudyMediaPlayer={create};
})(window);
