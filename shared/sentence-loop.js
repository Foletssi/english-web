(function(global){
'use strict';

function create(video,options={}){
  let enabled=false,index=-1,wantsPlay=false,internalSeek=false,disposed=false,epoch=0,frame=0,pending=null,pausing=false;
  const cues=()=>options.getCues?.()||[];
  const cue=()=>cues().find(row=>row.index===index)||null;
  const cancelFrame=()=>{if(frame)global.cancelAnimationFrame(frame);frame=0};
  const pick=time=>{const list=cues();let selected=list[0]||null;for(const row of list){if(row.start>time)break;selected=row}return selected};
  const selectCue=row=>{index=row.index;options.onSelect?.(index)};
  function clearPending(){if(!pending)return;global.clearTimeout(pending.feedback);global.clearTimeout(pending.timeout);pending=null;options.onBuffering?.(false)}
  function cancel(){epoch++;clearPending();cancelFrame()}
  function fail(error,ticket){if(disposed||ticket!==epoch)return;clearPending();wantsPlay=false;cancelFrame();video.pause();options.onError?.(error)}
  function resume(ticket){if(disposed||ticket!==epoch||!wantsPlay)return;try{Promise.resolve(video.play()).catch(error=>fail(error,ticket))}catch(error){fail(error,ticket)}}
  function ready(){
    const job=pending;if(!job||disposed||job.ticket!==epoch||video.seeking||video.readyState<3)return;
    if(Math.abs(Number(video.currentTime)-job.time)>.15)return;
    clearPending();if(wantsPlay)resume(job.ticket);
  }
  function jump(time){
    if(pending&&Math.abs(pending.time-time)<.001)return;
    cancel();const ticket=epoch;
    pausing=true;video.pause();pausing=false;
    if(!wantsPlay){try{internalSeek=true;video.currentTime=time}catch(error){fail(error,ticket)}return}
    pending={ticket,time,feedback:global.setTimeout(()=>{if(pending?.ticket===ticket)options.onBuffering?.(true)},300),timeout:global.setTimeout(()=>fail(new Error('SENTENCE_BUFFER_TIMEOUT'),ticket),8000)};
    try{internalSeek=true;video.currentTime=time;ready()}catch(error){fail(error,ticket)}
  }
  function play(){
    if(disposed)return;
    const row=cue();if(enabled&&!row){disable();return}
    wantsPlay=true;if(pending){ready();return}
    if(enabled&&(video.currentTime<row.start||video.currentTime>=row.end||video.readyState<3)){jump(row.start);return}
    resume(++epoch);
  }
  function pause(){wantsPlay=false;cancel();video.pause()}
  function checkBoundary(){if(!enabled||disposed||pending||video.paused||video.seeking)return;const row=cue();if(!row){disable();return}if(video.currentTime>=row.end)jump(row.start)}
  function tick(){frame=0;checkBoundary();if(enabled&&!disposed&&!video.paused)frame=global.requestAnimationFrame(tick)}
  function onPlay(){if(!enabled||disposed)return;wantsPlay=true;const row=cue();if(row&&(video.currentTime<row.start||video.currentTime>=row.end))jump(row.start);cancelFrame();frame=global.requestAnimationFrame(tick)}
  // Browsers queue pause events: a completed seek may already have resumed playback.
  function onPause(){if(!video.paused)return;cancelFrame();if(!pausing&&!pending&&!video.ended){wantsPlay=false;cancel()}}
  function onSeeked(){const own=internalSeek;internalSeek=false;ready();if(!enabled||own)return;const row=pick(video.currentTime);if(!row){disable();return}selectCue(row);if(!video.paused&&(video.currentTime<row.start||video.currentTime>=row.end))jump(row.start)}
  function select(nextIndex){const row=cues().find(item=>item.index===nextIndex);if(!row||disposed)return false;selectCue(row);jump(row.start);return true}
  function seek(time){if(!Number.isFinite(time)||disposed)return;if(!enabled){cancel();video.currentTime=time;return}const row=pick(time);if(!row){disable();return}selectCue(row);jump(time>=row.start&&time<row.end?time:row.start)}
  function enable(nextIndex,{autoplay=true}={}){if(disposed)return false;const row=cues().find(item=>item.index===nextIndex)||pick(video.currentTime);if(!row)return false;enabled=true;wantsPlay=autoplay;select(row.index);return true}
  function disable(){enabled=false;wantsPlay=false;cancel();internalSeek=false}
  function handleEnded(){if(!enabled)return false;const row=cue();if(wantsPlay&&row)jump(row.start);return true}
  function onVisibility(){if(enabled&&global.document.hidden)pause()}
  function onError(){if(enabled)pause()}
  video.addEventListener('play',onPlay);video.addEventListener('pause',onPause);video.addEventListener('timeupdate',checkBoundary);video.addEventListener('seeked',onSeeked);video.addEventListener('error',onError);global.document.addEventListener('visibilitychange',onVisibility);
  const readinessEvents=['loadeddata','canplay','progress'];readinessEvents.forEach(name=>video.addEventListener(name,ready));
  function dispose(){if(disposed)return;pause();disable();disposed=true;video.removeEventListener('play',onPlay);video.removeEventListener('pause',onPause);video.removeEventListener('timeupdate',checkBoundary);video.removeEventListener('seeked',onSeeked);video.removeEventListener('error',onError);readinessEvents.forEach(name=>video.removeEventListener(name,ready));global.document.removeEventListener('visibilitychange',onVisibility)}
  return Object.freeze({enable,disable,play,pause,select,seek,handleEnded,dispose,isEnabled:()=>enabled,isPlayRequested:()=>wantsPlay,isBuffering:()=>!!pending,getIndex:()=>index});
}

global.EastudySentenceLoop=Object.freeze({create});
})(window);
