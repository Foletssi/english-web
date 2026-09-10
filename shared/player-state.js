(function(global){
'use strict';

function initial(){
  return {catalog:'loading',session:'loading',media:'idle',captions:'loading',playRequested:false,firstFramePresented:false,error:null};
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

global.EastudyPlayerState=Object.freeze({initial,buildCaptionTimeline,selectCaption,captionView,activeSlice});
})(window);
