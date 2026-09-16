(function(global){
'use strict';

const TAGS=Object.freeze([
  {id:'daily-life',labelZh:'日常生活'},
  {id:'spoken-english',labelZh:'日常口语'},
  {id:'friendship',labelZh:'朋友交流'},
  {id:'workplace',labelZh:'职场沟通'},
  {id:'travel-scene',labelZh:'旅行出行'},
  {id:'food-culture',labelZh:'饮食文化'},
  {id:'study-skills',labelZh:'学习成长'},
  {id:'culture',labelZh:'文化交流'},
  {id:'conversation',labelZh:'真实对话'}
]);
const TAG_LABELS=Object.freeze(Object.fromEntries(TAGS.map(row=>[row.id,row.labelZh])));
// Stable topic colours belong to video cards, never to teaching highlights.
const CARD_TAGS=Object.freeze({
  'daily-life':Object.freeze({label:'日常生活',tone:'blue'}),
  'spoken-english':Object.freeze({label:'日常口语',tone:'mint'}),
  friendship:Object.freeze({label:'朋友交流',tone:'rose'}),
  workplace:Object.freeze({label:'职场沟通',tone:'purple'}),
  'travel-scene':Object.freeze({label:'旅行出行',tone:'green'}),
  'food-culture':Object.freeze({label:'美食',tone:'amber'}),
  'study-skills':Object.freeze({label:'学习成长',tone:'ochre'}),
  culture:Object.freeze({label:'文化交流',tone:'slate'}),
  conversation:Object.freeze({label:'真实对话',tone:'teal'})
});
const LEVEL_LABELS=Object.freeze({
  A1:'英语入门',A2:'基础交流',B1:'日常进阶',B2:'中高阶理解',C1:'高阶表达',C2:'高阶精读'
});
const TRACK_LABELS=Object.freeze({gaokao:'高考',zsb:'专升本',cet4:'四级',cet6:'六级',tem4:'专四',tem8:'专八',ielts:'雅思',toefl:'托福'});
function approvedTracks(video){
  const d=video?.difficulty;
  if(d?.schemaVersion!==1||d.reviewStatus!=='approved'||!Object.hasOwn(TRACK_LABELS,d.primaryTrack)||!Array.isArray(d.targetTracks)||!d.targetTracks.includes(d.primaryTrack))return [];
  return [...new Set(d.targetTracks.filter(track=>Object.hasOwn(TRACK_LABELS,track)))];
}
function availableTracks(videos){
  const present=new Set((videos||[]).filter(v=>v.status==='PUBLISHED'&&!v.deletedAt).flatMap(approvedTracks));
  return Object.entries(TRACK_LABELS).filter(([key])=>present.has(key));
}
function learnerDifficultyLabel(video){return approvedTracks(video).length?TRACK_LABELS[video.difficulty.primaryTrack]:''}

function difficultyLabel(level){
  const parts=String(level||'').split(/[\-–—]/).map(x=>x.trim()).filter(Boolean);
  if(!parts.length||parts.some(part=>!LEVEL_LABELS[part]))return '难度待评估';
  return [...new Set(parts.map(part=>LEVEL_LABELS[part]))].join('—');
}

global.EastudyTaxonomy=Object.freeze({TAGS,TAG_LABELS,CARD_TAGS,LEVEL_LABELS,TRACK_LABELS,difficultyLabel,approvedTracks,availableTracks,learnerDifficultyLabel});
})(window);
