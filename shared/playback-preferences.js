/* M04: one rate contract for controls, restored preferences and source remounts. */
(function(global){
 'use strict';
 const rates=Object.freeze([0.5,0.75,1,1.25,1.5,2]);
 const normalize=value=>rates.includes(Number(value))?Number(value):1;
 function apply(video,value){
  const rate=normalize(value);
  if(video){for(const key of ['preservesPitch','webkitPreservesPitch','mozPreservesPitch'])if(key in video)video[key]=true;video.defaultPlaybackRate=rate;video.playbackRate=rate}
  return rate;
 }
 function populate(select){if(!select)return;select.replaceChildren(...rates.map(rate=>{const option=document.createElement('option');option.value=String(rate);option.textContent=rate+'×';return option}))}
 global.EastudyPlaybackPreferences=Object.freeze({rates,normalize,apply,populate});
})(window);
