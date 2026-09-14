(function(global){
'use strict';

function initial(){
  return {catalog:'loading',session:'loading',media:'idle',captions:'loading',playRequested:false,firstFramePresented:false,error:null};
}

function sessionMessage(code){
  if(['AUTHENTICATION_REQUIRED','AUTH_REQUIRED','INVALID_SESSION','PLAYBACK_SESSION_REQUIRED'].includes(String(code||''))){
    return ['登录状态已失效','请重新登录后继续观看。',true];
  }
  if(['VIP_EXPIRED','MEMBERSHIP_EXPIRED'].includes(String(code||''))){
    return ['会员已到期','请续期后继续观看，学习进度已保留。',true];
  }
  if(['PLAYBACK_FORBIDDEN','ROLE_FORBIDDEN','VIP_REQUIRED','VIP_REVOKED','ACCOUNT_UNAVAILABLE'].includes(String(code||''))){
    return ['暂时无法观看','请联系管理员确认账号或视频的可用状态。',true];
  }
  return ['播放服务暂时不可用','请稍后重试，当前学习位置已经保留。',true];
}

function buildCaptionTimeline(rows){
  return (rows||[]).map((sentence,index)=>({
    sentence,index,
    start:Number(sentence.s??sentence.startTime),
    end:Number(sentence.e??sentence.endTime)
  })).filter(cue=>Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=0&&cue.end>cue.start)
    .sort((a,b)=>a.start-b.start||a.index-b.index);
}

function selectCaption(status,timeline,time){
  const blank=kind=>({kind,index:-1,activeIndex:-1,sentence:null});
  if(status==='loading'||status==='error')return blank(status);
  if(!timeline.length)return blank('empty');
  const value=Number(time);
  if(!Number.isFinite(value))return blank('blank');
  let low=0,high=timeline.length-1,found=-1;
  while(low<=high){
    const middle=(low+high)>>1;
    if(timeline[middle].start<=value){found=middle;low=middle+1}else high=middle-1;
  }
  if(found<0)return blank('blank');
  const cue=timeline[found],active=value<cue.end;
  return {kind:active?'cue':'hold',index:cue.index,activeIndex:active?cue.index:-1,sentence:cue.sentence};
}

function captionView(status,rows,time){
  return selectCaption(status,buildCaptionTimeline(rows),time);
}

function initialPosition(sentenceIndex,rows,resume){
  const index=typeof sentenceIndex==='string'&&/^\d+$/.test(sentenceIndex)?Number(sentenceIndex):-1;
  const start=rows?.[index]?.s;
  if(Number.isFinite(start)&&start>=0)return start;
  const saved=Number(resume);
  return Number.isFinite(saved)&&saved>=0?saved:0;
}

// Install after destroying the old source and before loading the new one.
function attachInitialSeek(video,position,isCurrent,onApplied=()=>{}){
  const cancel=()=>video.removeEventListener('loadedmetadata',apply);
  const apply=()=>{
    if(!isCurrent()){cancel();return}
    if(video.readyState<1||!Number.isFinite(video.duration)||video.duration<=0)return;
    cancel();
    if(position>=0&&position<video.duration){video.currentTime=position;onApplied()}
  };
  video.addEventListener('loadedmetadata',apply);
  return cancel;
}

function activeSlice(previous,current){
  if(!previous||!current)return null;
  const wall=(current.monotonicMs-previous.monotonicMs)/1000;
  const media=current.mediaTime-previous.mediaTime;
  if(!previous.running||!current.running||!previous.visible||!current.visible||previous.seeking||current.seeking)return null;
  if(wall<=0||wall>3||media<=0)return null;
  const expected=wall*(Number(previous.rate)||1);
  if(Math.abs(media-expected)>Math.max(.75,expected*.35))return null;
  return {activeSeconds:wall,watchRange:[previous.mediaTime,current.mediaTime]};
}

global.EastudyPlayerState=Object.freeze({initial,sessionMessage,buildCaptionTimeline,selectCaption,captionView,initialPosition,attachInitialSeek,activeSlice});
})(window);
