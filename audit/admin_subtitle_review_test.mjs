import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const adminSource=fs.readFileSync(new URL('../admin/assets/admin.js',import.meta.url),'utf8');
const adminHtml=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');

assert.ok(adminSource.includes('collectSentenceDrafts(vid,{approve:true,fill:true,resolveTeachingReview:true})'),'batch approval must acknowledge pending teaching review');
assert.ok(adminSource.includes('await subtitleMediaPlayer?.ready'),'sentence preview must wait for the protected media source');
assert.ok(adminSource.includes('await subtitleMediaPlayer.play()'),'sentence preview must use the shared player');
assert.ok(adminSource.includes("Cloud?.syncMediaSession?.('admin',{mediaUrl,force})"),'admin playback authorization must include the media URL');
assert.ok(adminSource.includes('subtitleMediaPlayer?.destroy();subtitleMediaPlayer=null'),'leaving the editor must destroy its media session');
assert.ok(!/<video id="subtitleVideo"[^>]*\ssrc=/.test(adminSource),'protected subtitle media must not be assigned directly to the video element');

const hlsIndex=adminHtml.indexOf('../assets/vendor/hls-1.6.13.min.js');
const playerIndex=adminHtml.indexOf('../shared/media-player.js?v=beta6.50.1');
const adminIndex=adminHtml.indexOf('assets/admin.js?v=beta6.50.1');
assert.ok(hlsIndex>=0&&playerIndex>hlsIndex&&adminIndex>playerIndex,'HLS and shared media player scripts must load before admin.js');

const match=adminSource.match(/function readSentenceDraft\([^\n]+/);
assert.ok(match,'readSentenceDraft must remain directly testable');
const context=vm.createContext({
 JSON,Number,String,Boolean,Math,Error,
 sentenceFromCard(card,existing){return {...existing,english:existing.english,keyWords:existing.keyWords||[]}},
 LearningContract:{VERSION:1,normalizeSurface:value=>String(value||'').trim().toLowerCase(),sentenceIssues:()=>[]}
});
vm.runInContext(match[0],context);

function cardFor(existing,checked=false){
 const expressions=JSON.stringify(existing.expressions||[]);
 return {querySelector(selector){
  if(selector==='[data-field="expressions"]')return {value:expressions};
  if(selector==='[data-field="resolveTeachingReview"]')return {checked};
  if(selector==='[data-field="selectionLocked"]')return {checked:false};
  return null;
 }};
}

const pending={order:0,english:'Review me',keyWords:['review'],textRevision:1,selectionRevision:0,reviewRevision:4,segmentationNeedsReview:true,expressions:[{surface:'review',coreMeaningZh:'复核',contextMeaningZh:'复核本句',needsReview:true}]};
const batch=context.readSentenceDraft(cardFor(pending),pending,{approve:true,resolveTeachingReview:true});
assert.equal(batch.segmentationNeedsReview,false);
assert.equal(batch.expressions[0].needsReview,false);
assert.equal(batch.reviewRevision,5);

const manual=context.readSentenceDraft(cardFor(pending,true),pending,{approve:true});
assert.equal(manual.segmentationNeedsReview,false);
assert.equal(manual.expressions[0].needsReview,false);

const clean={...pending,segmentationNeedsReview:false,reviewRevision:7,expressions:pending.expressions.map(row=>({...row,needsReview:false}))};
const unchanged=context.readSentenceDraft(cardFor(clean),clean,{approve:true,resolveTeachingReview:true});
assert.equal(unchanged.reviewRevision,7,'review revision must not change when there was nothing pending');

console.log('Admin subtitle batch review and protected playback contract passed.');
