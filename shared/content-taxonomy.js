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
const LEVEL_LABELS=Object.freeze({
  A1:'英语入门',A2:'基础交流',B1:'日常进阶',B2:'中高阶理解',C1:'高阶表达',C2:'高阶精读'
});

function difficultyLabel(level){
  const parts=String(level||'').split(/[\-–—]/).map(x=>x.trim()).filter(Boolean);
  if(!parts.length||parts.some(part=>!LEVEL_LABELS[part]))return '难度待评估';
  return [...new Set(parts.map(part=>LEVEL_LABELS[part]))].join('—');
}

global.EastudyTaxonomy=Object.freeze({TAGS,TAG_LABELS,LEVEL_LABELS,difficultyLabel});
})(window);
