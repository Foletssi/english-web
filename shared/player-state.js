(function(global){
'use strict';

function initial(){
  return {catalog:'loading',session:'loading',media:'idle',captions:'loading',playRequested:false,firstFramePresented:false,error:null};
}

function captionView(status,rows,time){
  if(status==='loading')return {kind:'loading',text:'字幕正在加载中…'};
  if(status==='error')return {kind:'error',text:'字幕加载失败，可重试；视频仍可播放'};
  if(status==='empty')return {kind:'empty',text:'此视频暂未提供学习字幕'};
  const index=(rows||[]).findIndex(row=>time>=Number(row.s??row.startTime)&&time<Number(row.e??row.endTime));
  return index<0?{kind:'gap',text:'字幕将随对白出现',index:-1}:{kind:'cue',sentence:rows[index],index};
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

global.EastudyPlayerState=Object.freeze({initial,captionView,activeSlice});
})(window);
