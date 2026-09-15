(function(global){
 'use strict';
 function create({report=()=>{},isCurrent=()=>true,timeoutMs=4000}={}){
  let generation=0,timer=null,utterance=null;
  function cancel(){generation++;clearTimeout(timer);timer=null;utterance=null;try{global.speechSynthesis?.cancel()}catch(_){}}
  function speak(word,dialect='en-GB'){
   cancel();const text=String(word||'').trim(),own=generation,synth=global.speechSynthesis;
   if(!text)return;
   if(!synth||!global.SpeechSynthesisUtterance){report('设备朗读不可用，可返回视频播放原句');return}
   const current=()=>own===generation&&isCurrent();
   const voices=synth.getVoices?.()||[],exact=voices.find(v=>v.lang?.toLowerCase()===dialect.toLowerCase());
   utterance=new global.SpeechSynthesisUtterance(text);utterance.lang=dialect;
   if(exact)utterance.voice=exact;
   const label=exact?(dialect==='en-US'?'美音':'英音'):'设备英语朗读';
   const failure=()=>{if(!current())return;cancel();report('设备未能播放发音，请重试或播放原句')};
   utterance.onstart=()=>{if(!current())return;clearTimeout(timer);timer=null;report('正在播放'+label)};
   utterance.onend=()=>{if(!current())return;clearTimeout(timer);timer=null;report('点击扬声器再次播放')};
   utterance.onerror=failure;
   report('正在启动发音…');timer=setTimeout(failure,timeoutMs);
   // Keep speak inside the user's tap: asynchronous voice loading can lose iOS activation.
   // With no voice yet, lang lets the browser select its English voice.
   try{synth.resume?.();synth.speak(utterance)}catch(_){failure()}
  }
  return {speak,cancel};
 }
 global.EastudyPronunciation=Object.freeze({create});
})(window);
