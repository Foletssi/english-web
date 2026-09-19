import fs from 'node:fs';
import assert from 'node:assert/strict';

const html=fs.readFileSync('index.html','utf8');
const app=fs.readFileSync('assets/js/app.js','utf8');
assert.ok(app.includes('function bindDictionaryClicks(root)'), 'subtitle word cards use stable delegated click handling');
assert.ok(app.includes('window.speechSynthesis.speak(utterance)'), 'word cards provide browser speech fallback');
assert.ok(app.indexOf('renderDictionaryCard(target,savedSource)') < app.indexOf("toast('正在加载词卡详情…')"), 'word card renders before remote teaching details finish');
const css=fs.readFileSync('assets/css/app.css','utf8');

const checks=[
  html.includes('data-auth-state="checking"')&&html.includes('id="authRecovery"'),
  app.includes("phase==='checking'||phase==='error'")&&app.includes("StudentAuth.phase='authenticated'"),
  app.includes("State.practiceBoundaryReached=true;v.pause()")&&app.includes("v.currentTime=sentence.s+.01"),
  app.includes("dx>12&&dx>dy*1.4")&&app.includes("dy>12&&dy>=dx"),
  app.includes("pointercancel")&&app.includes("endScrub(false)"),
  html.includes('id="volumeRange"')&&app.includes("volumeValue.textContent"),
  css.includes('touch-action:pan-y pinch-zoom'),
  css.includes('.video-page .word-token.phrase-token{white-space:normal'),
  !app.includes("$('#repeatBtn')")&&!app.includes("$('#autoPauseBtn')")&&!app.includes("$('#muteBtn')"),
];
checks.forEach((value,index)=>assert.ok(value,`Student player interaction check ${index+1} failed`));
console.log(`Student player interaction: ${checks.length}/${checks.length} checks passed.`);
