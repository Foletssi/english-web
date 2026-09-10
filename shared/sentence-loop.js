(function(global){
'use strict';

function create(video,options={}){
  let enabled=false,index=-1,wantsPlay=false,internalSeek=false,disposed=false,epoch=0,frame=0;
  const cues=()=>options.getCues?.()||[];
  const cue=()=>cues().find(row=>row.index===index)||null;
  const cancelFrame=()=>{if(frame)global.cancelAnimationFrame(frame);frame=0};
  const pick=time=>{const list=cues();let selected=list[0]||null;for(const row of list){if(row.start>time)break;selected=row}return selected};
  const selectCue=row=>{index=row.index;options.onSelect?.(index)};
  function jump(time){if(Math.abs((Number(video.currentTime)||0)-time)<.001)return;internalSeek=true;video.currentTime=time}
  function fail(error,ticket){if(disposed||ticket!==epoch)return;wantsPlay=false;cancelFrame();options.onError?.(error)}
  function play(){
    if(disposed)return;
    const row=cue();if(enabled&&!row){disable();return}
    wantsPlay=true;const ticket=++epoch;
    try{if(enabled&&(video.currentTime<row.start||video.currentTime>=row.end))jump(row.start);Promise.resolve(video.play()).catch(error=>fail(error,ticket))}catch(error){fail(error,ticket)}
  }
  function pause(){wantsPlay=false;epoch++;cancelFrame();video.pause()}
  function checkBoundary(){if(!enabled||disposed||video.paused||video.seeking)return;const row=cue();if(!row){disable();return}if(video.currentTime>=row.end)jump(row.start)}
  function tick(){frame=0;checkBoundary();if(enabled&&!disposed&&!video.paused)frame=global.requestAnimationFrame(tick)}
  function onPlay(){if(!enabled||disposed)return;wantsPlay=true;const row=cue();if(row&&(video.currentTime<row.start||video.currentTime>=row.end))jump(row.start);cancelFrame();frame=global.requestAnimationFrame(tick)}
  function onPause(){cancelFrame();if(!video.ended){wantsPlay=false;epoch++}}
  function onSeeked(){const own=internalSeek;internalSeek=false;if(!enabled||own)return;const row=pick(video.currentTime);if(!row){disable();return}selectCue(row);if(!video.paused&&(video.currentTime<row.start||video.currentTime>=row.end))jump(row.start)}
  function select(nextIndex){const row=cues().find(item=>item.index===nextIndex);if(!row||disposed)return false;epoch++;selectCue(row);jump(row.start);return true}
  function seek(time){if(!Number.isFinite(time)||disposed)return;epoch++;if(!enabled){video.currentTime=time;return}const row=pick(time);if(!row){disable();return}selectCue(row);jump(time>=row.start&&time<row.end?time:row.start)}
  function enable(nextIndex){if(disposed)return false;const row=cues().find(item=>item.index===nextIndex)||pick(video.currentTime);if(!row)return false;enabled=true;select(row.index);play();return true}
  function disable(){enabled=false;wantsPlay=false;epoch++;internalSeek=false;cancelFrame()}
  function handleEnded(){if(!enabled)return false;const row=cue();if(wantsPlay&&row){jump(row.start);play()}return true}
  function onVisibility(){if(enabled&&global.document.hidden)pause()}
  function onError(){if(enabled)pause()}
  video.addEventListener('play',onPlay);video.addEventListener('pause',onPause);video.addEventListener('timeupdate',checkBoundary);video.addEventListener('seeked',onSeeked);video.addEventListener('error',onError);global.document.addEventListener('visibilitychange',onVisibility);
  function dispose(){if(disposed)return;pause();disable();disposed=true;video.removeEventListener('play',onPlay);video.removeEventListener('pause',onPause);video.removeEventListener('timeupdate',checkBoundary);video.removeEventListener('seeked',onSeeked);video.removeEventListener('error',onError);global.document.removeEventListener('visibilitychange',onVisibility)}
  return Object.freeze({enable,disable,play,pause,select,seek,handleEnded,dispose,isEnabled:()=>enabled,getIndex:()=>index});
}

global.EastudySentenceLoop=Object.freeze({create});
})(window);
