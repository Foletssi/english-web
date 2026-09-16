import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const baseUrl = process.env.EASTUDY_LOCAL_URL || 'http://127.0.0.1:8080';
const snapshot = {
  schemaVersion: 3,
  creators: [{ id: 'fixture-creator', name: '本地创作者', bio: '本地测试', status: 'ACTIVE' }],
  collections: [],
  videos: [{
    id: 9001,
    title: 'Local sentence loop fixture',
    titleZh: '本地单句循环测试',
    creatorId: 'fixture-creator',
    creator: '本地创作者',
    status: 'PUBLISHED',
    pipelineStatus: 'READY',
    mediaUrl: 'data:video/mp4;base64,',
    cover: 'assets/images/video_cover_pending.svg',
    duration: 100,
    level: 'cet4',
    tagIds: ['daily-life'],
    collectionIds: []
  }],
  sentences: {
    9001: [
      { id: '9001-1', order: 0, startTime: 1, endTime: 2, english: 'Taking a short break.', chinese: '短暂休息一下。', keyWords: ['taking'], reviewStatus: 'APPROVED' },
      { id: '9001-2', order: 1, startTime: 3, endTime: 4.5, english: 'Then we continue.', chinese: '然后我们继续。', keyWords: ['continue'], reviewStatus: 'APPROVED' },
      ...Array.from({length: 28}, (_, n) => ({ id: `9001-${n+3}`, order: n+2, startTime: 6+n*3, endTime: 8+n*3, english: `We continue this conversation carefully, sentence ${n+3}.`, chinese: '继续阅读当前句子，检查移动端字幕自动跟随与长句换行。', keyWords: ['continue'], reviewStatus: 'APPROVED' }))
    ]
  },
  jobs: [], trash: [], tombstones: {}, auditLog: []
};

snapshot.videos.push({ ...snapshot.videos[0], id: 9002, title: 'Next video fixture', titleZh: '下一条视频测试' });
const longPhrase='continue this conversation carefully';
Object.assign(snapshot.sentences[9001][2],{english:'We '+longPhrase+'.',keyWords:[longPhrase],timingSource:'aligned',wordTimings:['We','continue','this','conversation','carefully'].map((word,i)=>({word,start:6+i*.4,end:6+(i+1)*.4}))});
Object.assign(snapshot.sentences[9001][3],{english:'Take a break then carry on.',keyWords:['take a break','carry on']});
snapshot.sentences[9002] = [{ id: '9002-1', order: 0, startTime: 1, endTime: 2, english: 'Next video.', chinese: '下一条视频。', reviewStatus: 'APPROVED' }];
for(let n=0;n<13;n++)snapshot.videos.push({...snapshot.videos[0],id:9010+n,title:'Catalog item '+n,titleZh:'目录视频 '+n});
snapshot.videos.push({...snapshot.videos[0]}); // Duplicate catalog ID must render once.
for (const rows of Object.values(snapshot.sentences)) for (const row of rows) {
  row.keyWords ||= [];
  row.expressions = row.keyWords.map(surface => ({surface,lemma:surface,expressionType:surface.includes(' ')?'collocation':'word',
    coreMeaningZh:'测试核心含义',contextMeaningZh:'当前句子的具体含义',selectionReasonZh:'词汇语境教学',needsReview:false,reviewStatus:'APPROVED',sourceTextRevision:1}));
}
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route('**/assets/vendor/*.js', route => {
  const body = route.request().url().includes('/hls-') ? 'window.Hls=undefined;' : 'window.supabase={createClient(){return {auth:{getSession:async()=>({data:{session:null},error:null})}}}};';
  return route.fulfill({ status: 200, contentType: 'application/javascript', body });
});
await context.addInitScript(snapshotValue => {
  localStorage.setItem('zs:platform:content:local:v1', JSON.stringify(snapshotValue));
  localStorage.setItem('zs:user:student-fixture:learningPlan', JSON.stringify({ track: 'cet4', dailyMinutes: 20, onboardingVersion: 1 }));
  const auth = {
    available: true,
    getContext: async () => ({ user: { id: 'student-fixture' }, profile: { role: 'learner', nickname: '测试学员', phone: '+8613800000000' } }),
    getRememberLogin: () => false,
    signOut: async () => ({ error: null })
  };
  const data = {
    getLearningAccess: async () => ({ access: { canEnterLearning: true, reason: 'VIP_ACTIVE' }, error: null }),
    startLearnerActivity: () => () => {}, stopLearnerActivity: () => {},
    getMembership: async () => ({ membership: null, error: null }),
    hydrateStudentLearning: async () => ({ error: null }), pendingStudyEvents: () => 0,
    saveLearningPreferences: async settings => { if(window.__failPreferences)return {error:new Error('offline')};window.__savedPreferences=structuredClone(settings);return { error: null }; },
    logStudyEvent: async () => ({ error: null }), upsertProgress: async () => ({ error: null }),
    recordStudyActivity: async () => ({ error: null })
  };
  const cloud = { syncMediaSession: async () => ({}), clearMediaSession: async () => {} };
  Object.defineProperty(window, 'EastudyAuth', { configurable: true, get: () => auth, set: () => {} });
  Object.defineProperty(window, 'EastudyData', { configurable: true, get: () => data, set: () => {} });
  Object.defineProperty(window, 'EastudyCloudContent', { configurable: true, get: () => cloud, set: () => {} });
}, snapshot);

const page = await context.newPage();
page.setDefaultTimeout(7000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.goto(`${baseUrl}/#/video/9001`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.authState === 'authenticated').catch(error => { throw new Error(`${error.message}; page errors: ${pageErrors.join('; ')}`); });
await page.evaluate(() => { location.hash = '#/video/9001'; });
await page.locator('#videoPage.active').waitFor().catch(async error => {
  const diagnostic = await page.evaluate(() => ({ hash: location.hash, auth: document.body.dataset.authState, title: document.querySelector('.study-title')?.textContent }));
  throw new Error(`${error.message}\nPlayer diagnostic: ${JSON.stringify(diagnostic)}\nPage errors: ${pageErrors.join('; ')}`);
});
await page.locator('#videoPage .study-title').waitFor();
assert.match(await page.locator('#videoPage .study-title').innerText(), /本地单句循环测试/);
assert.equal((await page.locator('#currentEn').innerText()).trim(), '', 'the pre-roll caption area must be blank');
assert.equal(await page.getByText('释义待生成').count(), 0);

await page.locator('#video').evaluate(video => {
  video.currentTime = 1.25;
  video.dispatchEvent(new Event('timeupdate'));
});
await page.waitForTimeout(50);
assert.match(await page.locator('#currentEn').innerText(), /Taking a short break/);
const keyword = page.locator('#currentEn .teaching-keyword').first();
assert.ok(await keyword.count());
const keywordStyle = await keyword.evaluate(element => ({ color: getComputedStyle(element).color, decoration: getComputedStyle(element).textDecorationLine }));
assert.notEqual(keywordStyle.color, 'rgb(0, 0, 0)');
assert.match(keywordStyle.decoration, /underline/);

await keyword.click();
await page.locator('#speakOriginal').waitFor({state:'visible'});
await page.evaluate(() => {
  document.querySelector('#video').currentTime = 15;
  // The fixture has no decoded media. Verify the UI seek and play request;
  // authorization and decoder behavior have their own media-player tests.
  window.__fixturePlayerPlay = State.mediaPlayer.play;
  State.mediaPlayer.play = () => { window.__originalPlayAt = document.querySelector('#video').currentTime; return Promise.resolve(); };
});
await page.locator('#speakOriginal').click();
assert.ok(Math.abs(await page.evaluate(() => window.__originalPlayAt) - 1.01) < .001,
  'original pronunciation must seek to the clicked sentence normalized start before playing');
assert.equal(await page.locator('#dict').evaluate(el => el.classList.contains('show')), false);
await page.evaluate(() => { State.mediaPlayer.play = window.__fixturePlayerPlay; delete window.__fixturePlayerPlay; });

await page.locator('#video').evaluate(video => {
  video.pause();
  video.currentTime = 2.5;
  video.dispatchEvent(new Event('timeupdate'));
});
await page.waitForTimeout(50);
assert.match(await page.locator('#currentEn').innerText(), /Taking a short break/, 'the previous sentence must remain visible in a caption gap');

await page.locator('[data-practice="loop"]').click();
assert.equal(await page.locator('[data-practice="loop"]').getAttribute('aria-pressed'), 'true');
assert.equal(await page.getByText('录音对比').count(), 0);

await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(250);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile player must not overflow globally');
await page.screenshot({ path: 'tmp/local-player-loop-mobile.png', fullPage: true });
await page.locator('[data-mobile-practice="watch"]').click();
await page.setViewportSize({width:320,height:640});
await page.locator('#video').evaluate(video=>{video.currentTime=6.5;video.dispatchEvent(new Event('timeupdate'))});
const phraseTokens=page.locator('#transcript [data-i="2"] [data-phrase]');
assert.equal(await phraseTokens.count(),4,'phrase meaning preserved on four independent word elements');
const tones=await page.locator('#transcript [data-i="3"] [data-phrase]').evaluateAll(tokens=>tokens.map(el=>({word:el.dataset.word,tone:[...el.classList].find(x=>x.startsWith('keyword-tone-'))})));
assert.equal(tones.length,5,'both adjacent teaching phrases split into individual words');
assert.equal(new Set(tones.filter(x=>x.word==='take a break').map(x=>x.tone)).size,1,'one phrase retains one semantic color');
assert.notEqual(tones[0].tone,tones[3].tone,'adjacent phrases have distinct semantic colors');
const phraseStyle=await phraseTokens.first().evaluate(el=>({color:getComputedStyle(el).color,bounds:el.getBoundingClientRect().toJSON()}));
assert.equal(await page.locator('#transcript [data-i="2"] .timing-active').innerText(),'continue');
await page.locator('#video').evaluate(video=>{video.currentTime=7.3;video.dispatchEvent(new Event('timeupdate'))});
assert.equal(await page.locator('#transcript [data-i="2"] .timing-active').innerText(),'conversation');
assert.equal(await phraseTokens.first().evaluate(el=>getComputedStyle(el).color),phraseStyle.color,'teaching color stays unchanged');
const tokenBoxes=await phraseTokens.evaluateAll(tokens=>tokens.map(el=>({top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height,after:getComputedStyle(el,'::after').content})));
assert.ok(new Set(tokenBoxes.map(x=>x.top)).size>1,'long phrase actually wraps');
assert.ok(tokenBoxes.every(x=>x.height<32 && ['none','normal'].includes(x.after)),'no multi-line phrase border');
// Inspect rendered pixels at literal spaces, including wrapped phrases in both themes.
for (const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('#transcript [data-i="2"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const gaps=await page.locator('#transcript [data-i="2"] .teaching-expression').evaluate(el=>{
    const color=getComputedStyle(el).color.match(/\d+/g).slice(0,3).map(Number);
    return [...el.childNodes].filter(n=>n.nodeType===3 && /^\s+$/.test(n.textContent)).flatMap(n=>{
      const range=document.createRange();range.selectNodeContents(n);
      return [...range.getClientRects()].filter(r=>r.width>1).map(r=>({x:r.x,y:r.y,width:r.width,height:r.height,color}));
    });
  });
  assert.ok(gaps.length,'phrase has measurable spaces');
  const screenshot=`tmp/phrase-underline-${theme}.png`;
  await page.screenshot({path:screenshot});
  execFileSync('py',['-3.12','audit/underline_pixels.py',screenshot,JSON.stringify(gaps)],{stdio:'pipe'});
}
await page.evaluate(()=>document.documentElement.dataset.theme='light');
assert.equal(await page.locator('#transcript [data-i="0"] [data-word-start]').count(),0,'estimated timing is not treated as aligned speech');
for (const viewport of [{width:320,height:568},{width:320,height:640},{width:360,height:800},{width:390,height:844},{width:430,height:932},{width:768,height:1024},{width:1024,height:768},{width:1280,height:800},{width:1440,height:900},{width:844,height:390}]) {
  await page.setViewportSize(viewport);
  const transcriptTab = page.locator('[data-mobile-study="transcript"]');
  if (await transcriptTab.isVisible()) await transcriptTab.click();
  assert.ok(await page.locator('#transcript').isVisible(), `transcript is actually displayed at ${viewport.width}`);
  await page.locator('#video').evaluate(video => { video.currentTime = 60.25; video.dispatchEvent(new Event('timeupdate')); });
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no global overflow at ${viewport.width}`);
  if(viewport.width<=850){
    const boxes=await page.evaluate(()=>Object.fromEntries(['.player','.mobile-learning-tools','.transcript-wrap','.mobile-learning-dock','.timeline','.center-ctl','.learning-dock-links'].map(selector=>[selector,document.querySelector('#videoPage '+selector).getBoundingClientRect().toJSON()])));
    const dock=boxes['.mobile-learning-dock'];
    assert.equal(dock.height,viewport.height<=500?88:112,'compact dock has exact row heights');
    const components=await page.locator('.mobile-learning-dock .player-icon,.mobile-learning-dock .play-disc').evaluateAll(nodes=>nodes.map(node=>({disc:node.classList.contains('play-disc'),width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
    assert.ok(components.every(c=>c.width===(c.disc?32:18)&&c.height===c.width),'icons and play disc retain square dimensions '+JSON.stringify(components));
    assert.ok(dock.bottom<=viewport.height+1 && dock.top>=boxes['.transcript-wrap'].bottom-1,'dock and transcript do not overlap '+JSON.stringify(boxes));
    for(const selector of (viewport.height<=500?['.center-ctl','.learning-dock-links']:['.timeline','.center-ctl','.learning-dock-links']))assert.ok(boxes[selector].top>=dock.top-1 && boxes[selector].bottom<=dock.bottom+1,'all controls contained in dock '+selector+JSON.stringify(boxes));
    if(viewport.height>500)assert.ok(boxes['.player'].top<=45 && boxes['.player'].bottom<=boxes['.mobile-learning-tools'].top+1 && boxes['.mobile-learning-tools'].bottom<=boxes['.transcript-wrap'].top+1,'video/tools/captions in separate rows');
  }else assert.ok(await page.locator('#openLessonMore').isVisible(),'desktop sentence menu preserved');
  const visible = await page.locator('#transcript [data-i="20"]').evaluate(line => {
    const box = document.querySelector('#transcript').getBoundingClientRect(), rect = line.getBoundingClientRect();
    return rect.top >= box.top-2 && (rect.bottom <= box.bottom+2 || (rect.height > box.height && rect.top < box.top+16));
  });
  const layout = await page.locator('#transcript').evaluate(box => ({top:box.getBoundingClientRect().top,height:box.clientHeight,scrollTop:box.scrollTop,scrollHeight:box.scrollHeight,line:box.querySelector('[data-i="20"]')?.getBoundingClientRect().toJSON(),active:box.querySelector('.active')?.dataset.i,time:document.querySelector('#video').currentTime}));
  assert.ok(visible, `current sentence follows inside transcript at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
}
await page.setViewportSize({width:390,height:844});
await page.locator('#transcript').evaluate(box => { box.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true})); box.scrollTop=0; });
await page.locator('#video').evaluate(video => { video.currentTime=72.25; video.dispatchEvent(new Event('timeupdate')); });
await page.waitForTimeout(400);
assert.equal(await page.locator('#transcript').evaluate(box => box.scrollTop), 0, 'manual browsing pauses following');
await page.locator('#returnCurrentSentence').click();
await page.waitForTimeout(650);
assert.ok(await page.locator('#transcript').evaluate(box => box.scrollTop>0), 'return restores following');
const beforeWord = await page.locator('#video').evaluate(video => video.currentTime);
await page.locator('#transcript [data-i="24"] .teaching-keyword').first().click();
assert.equal(await page.locator('#video').evaluate(video => video.currentTime), beforeWord, 'word card must not seek the video');
// Long content must scroll inside the card while actions remain reachable.
await page.locator('#dictExplain').evaluate(el=>{el.parentElement.hidden=false;el.textContent='语境说明，检查长内容可滚动。'.repeat(100)});
for(const theme of ['light','dark']){
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  for(const viewport of [{width:320,height:568},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    await page.locator('#dict').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))});
    const card=await page.locator('#dict').evaluate(el=>{
      const box=el.getBoundingClientRect(),body=el.querySelector('.dict-body'),actions=el.querySelector('.dict-actions').getBoundingClientRect(),close=el.querySelector('#dictClose').getBoundingClientRect();
      body.scrollTop=body.scrollHeight;
      return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,actionsTop:actions.top,actionsBottom:actions.bottom,
        bodyBottom:body.getBoundingClientRect().bottom,scrollable:body.scrollHeight>body.clientHeight,scrollTop:body.scrollTop,closeWidth:close.width,closeHeight:close.height};
    });
    assert.ok(card.left>=0&&card.right<=viewport.width&&card.top>=0&&card.bottom<=viewport.height,'word card fits '+JSON.stringify(card));
    assert.ok(card.scrollable&&card.scrollTop>0,'long definitions scroll');
    assert.ok(card.bodyBottom<=card.actionsTop+1&&card.actionsBottom<=card.bottom,'actions remain outside scroll body');
    assert.equal(card.closeWidth,44);assert.equal(card.closeHeight,44);
    await page.screenshot({path:`tmp/word-card-${theme}-${viewport.width}.png`});
  }
}
await page.evaluate(()=>document.documentElement.dataset.theme='light');
await page.setViewportSize({width:390,height:844});
// Direct entry must not silently acquire unrelated videos.
assert.equal(await page.locator('#nextVideo').isDisabled(), true);
// Close the word card before exercising completion controls.
await page.keyboard.press('Escape');
await page.evaluate(() => { location.hash = '#/home'; });
await page.locator('#mobileVideoList [data-video="9001"]').click();
await page.locator('#videoPage.active').waitFor();
await page.locator('[data-mobile-practice="loop"]').click();
await page.locator('#video').evaluate(video => video.dispatchEvent(new Event('ended')));
assert.equal(await page.locator('#lessonComplete').isVisible(), false, 'sentence loop must not advance the video queue');
await page.locator('[data-mobile-practice="watch"]').click();
await page.locator('#video').evaluate(video => video.dispatchEvent(new Event('ended')));
assert.match(await page.locator('#nextLessonTitle').innerText(), /下一条视频测试/);
assert.equal(await page.locator('#nextLessonReason').innerText(), '来自当前视频列表');
await page.locator('#cancelNextLesson').click();
await page.waitForTimeout(5200);
assert.match(page.url(), /#\/video\/9001$/);
await page.locator('#video').evaluate(video => video.dispatchEvent(new Event('ended')));
await page.waitForURL('**/#/video/9002', { timeout: 8000 });
assert.match(await page.locator('#videoPage .study-title').innerText(), /下一条视频测试/);
await page.locator('#openLessonMore').click();
await page.locator('#previousVideo').click();
await page.waitForURL('**/#/video/9001');
await page.waitForFunction(() => document.querySelector('#videoPage .study-title')?.textContent.includes('本地单句循环测试'));
await page.locator('#video').evaluate(video => {
  // Empty data fixture cannot load metadata; deliver the real readiness contract.
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(video, 'duration', { configurable: true, get: () => 100 });
  video.dispatchEvent(new Event('loadedmetadata'));
});
assert.equal(await page.locator('#video').evaluate(video => video.currentTime), 0, 'previous video starts at zero after metadata');
assert.equal(await page.locator('#previousVideo').isDisabled(), true, 'first item cannot go backwards');
await page.locator('#openQueueDirectory').click();
assert.equal(await page.locator('#closeQueueDirectory').evaluate(el=>el===document.activeElement),true);
assert.ok(await page.locator('#queueDirectoryList img').count()>1,'directory includes covers');
assert.ok(await page.locator('#queueDirectoryList .directory-meta').first().innerText(),'directory includes actual metadata');
for(const theme of ['light','dark']){
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.screenshot({path:`tmp/study-directory-${theme}.png`});
}
await page.keyboard.press('Escape');
assert.equal(await page.locator('#queueDirectory').isVisible(),false);
await page.locator('#openTeachingWords').click();
assert.equal(await page.locator('#playerWordVideoOnly').isVisible(),false,'video-only filter belongs to saved words, not teaching words');
assert.equal(await page.locator('#playerWordList .learning-word-meaning').first().innerText(),'测试核心含义');
const teachingTones=await page.locator('#playerWordList .learning-word-term').evaluateAll(nodes=>nodes.map(el=>[el.textContent,[...el.classList].find(name=>/^keyword-tone-[1-4]$/.test(name))]));
assert.ok(teachingTones.every(([,tone])=>tone),'all approved expressions retain a teaching color');
for(const theme of ['light','dark']){
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.screenshot({path:`tmp/study-highlights-${theme}.png`});
}
await page.locator('#playerWordList button').first().click();
assert.equal(await page.locator('#dictMeaning').innerText(),'测试核心含义','redesigned teaching row still opens its actual definition');
await page.locator('#dict').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))});
for(const theme of ['light','dark']){
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.screenshot({path:`tmp/study-word-card-${theme}.png`});
}
await page.locator('#dictClose').click();
await page.locator('#openLessonMore').click();
await page.locator('#autoplayNext').uncheck();
await page.locator('#lessonMore [data-close]').click();
await page.waitForFunction(()=>document.activeElement?.id==='openLessonMore');
await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('ended')));
await page.waitForTimeout(5200);
assert.match(page.url(), /#\/video\/9001$/);
await page.locator('#cancelNextLesson').click();
await page.locator('#closeLessonComplete').click();
await page.locator('[data-mobile-practice="cloze"]').click();
await page.locator('#openTeachingWords').click();
assert.deepEqual(await page.locator('#playerWordList .learning-word-term').evaluateAll(nodes=>nodes.map(el=>[el.textContent,[...el.classList].find(name=>/^keyword-tone-[1-4]$/.test(name))])),teachingTones,'cloze preserves teaching list colors');
await page.keyboard.press('Escape');
await page.locator('#video').evaluate(video=>{video.currentTime=1.25;video.dispatchEvent(new Event('timeupdate'))});
const cloze=page.locator('#transcript .cloze-input');
await cloze.fill('taking');
await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('seeked')));
assert.equal(await cloze.inputValue(),'taking','same-sentence seek does not erase typed answer');
let warned=false;
page.once('dialog',async dialog=>{warned=true;await dialog.dismiss()});
await page.locator('#openLessonMore').click();
await page.locator('#nextVideo').click();
await page.locator('#lessonMore [data-close]').click();
assert.equal(warned,true,'unfinished dictation warns before manual video navigation');
assert.match(page.url(), /#\/video\/9001$/);
assert.equal(await cloze.inputValue(),'taking','cancelled navigation preserves the answer');
await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('ended')));
assert.equal(await page.locator('#lessonComplete').isVisible(),false,'cloze mode never advances the queue');
await page.locator('[data-mobile-practice="watch"]').click();
const controlBefore=await page.locator('.mobile-learning-dock').boundingBox();
assert.ok(controlBefore && controlBefore.height > 0);
await page.locator('#transcript').evaluate(el=>el.scrollTop=el.scrollHeight);
assert.deepEqual(await page.locator('.mobile-learning-dock').boundingBox(),controlBefore,'video navigation stays fixed when captions scroll');
await page.locator('#dockBlind').click();
assert.equal(await page.locator('#dockBlind').getAttribute('aria-pressed'),'true');
await page.locator('#openTeachingWords').click();
assert.deepEqual(await page.locator('#playerWordList .learning-word-term').evaluateAll(nodes=>nodes.map(el=>[el.textContent,[...el.classList].find(name=>/^keyword-tone-[1-4]$/.test(name))])),teachingTones,'blind listening preserves teaching list colors');
await page.keyboard.press('Escape');
await page.locator('#transcript .line-en').first().click();
assert.match(await page.locator('#transcript .line-en').first().innerText(),/Taking a short break/,'hidden captions can be revealed on mobile');
await page.locator('#openLessonMore').click();
await page.locator('[data-caption-value="chinese"]').click();
await page.locator('#lessonMore [data-close]').click();
assert.equal(await page.locator('#transcript .line-en').first().isVisible(),false,'Chinese mode hides English');
assert.equal(await page.locator('#transcript .line-zh').first().isVisible(),true,'Chinese mode keeps translation');
await page.locator('#dockBlind').click();
await page.locator('#dockBlind').click();
assert.equal(await page.locator('#mobileCaptionMode').inputValue(),'chinese','blind toggle restores the last visible caption mode');
await page.locator('#openLessonMore').click();
await page.locator('[data-caption-value="bilingual"]').click();
await page.locator('#lessonMore [data-close]').click();
for(const viewport of [{width:320,height:640},{width:390,height:844},{width:844,height:390}]){
 await page.setViewportSize(viewport);
 await page.locator('#openLessonMore').click();
 const panel=await page.locator('#lessonMore').boundingBox();
 assert.ok(panel.width>=Math.min(300,viewport.width-20) && panel.x>=0 && panel.x+panel.width<=viewport.width+1,'More panel uses usable width');
 assert.ok(panel.y>=0 && panel.y+panel.height<=viewport.height+1,'More remains in viewport');
 const sizes=await page.locator('.center-ctl button').evaluateAll(nodes=>nodes.filter(x=>x.getClientRects().length).map(x=>({text:x.textContent,width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height})));
 assert.ok(sizes.every(x=>x.width>=44 && x.height>=44),'sentence controls keep touch targets '+JSON.stringify(sizes));
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#openLessonMore').evaluate(el=>el===document.activeElement),true,'More restores trigger focus');
}
await page.setViewportSize({width:390,height:844});
await page.locator('#openLessonMore').click();
await page.locator('#openSettings').click();
await page.locator('.font-choice[data-font-value="24"]').click();
assert.equal(await page.locator('#transcript .line-en').first().evaluate(el=>getComputedStyle(el).fontSize),'24px','mobile font setting changes actual caption size');
await page.locator('.font-choice[data-font-value="16"]').click();
assert.equal(await page.locator('#transcript .line-en').first().evaluate(el=>getComputedStyle(el).fontSize),'16px','mobile font can be reduced again');
await page.locator('#closeSettings').click();
await page.waitForFunction(()=>document.querySelector('#lessonMore').open);
await page.keyboard.press('Escape');
await page.waitForFunction(()=>!document.querySelector('#lessonMore').open);
// Learning markers must acknowledge persistence and keep failures out of local state.
assert.equal(await page.locator('#markLessonLearned').getAttribute('aria-pressed'),'false');
await page.locator('#markLessonLearned').click();
await page.waitForFunction(()=>document.querySelector('#markLessonLearned').getAttribute('aria-pressed')==='true');
assert.ok(await page.evaluate(()=>window.__savedPreferences.reviewedVideos['9001']));
await page.evaluate(()=>{window.__failPreferences=true});
await page.locator('#markLessonLearned').click();
await page.waitForFunction(()=>!document.querySelector('#markLessonLearned').disabled);
assert.equal(await page.locator('#markLessonLearned').getAttribute('aria-pressed'),'true','failed save preserves last confirmed marker');
await page.evaluate(()=>{window.__failPreferences=false});
await page.locator('#markLessonLearned').click();
await page.waitForFunction(()=>document.querySelector('#markLessonLearned').getAttribute('aria-pressed')==='false');
await page.evaluate(()=>{
 const key='zs:user:student-fixture:settings',settings=JSON.parse(localStorage.getItem(key)||'{}');
 settings.reviewedVideos={'9001':'2026-09-16T00:00:00.000Z'};localStorage.setItem(key,JSON.stringify(settings));
 window.dispatchEvent(new Event('eastudy:learning-hydrated'));
});
assert.equal(await page.locator('#markLessonLearned').getAttribute('aria-pressed'),'true','cloud hydration refreshes marker');
await page.locator('#markLessonLearned').click();
await page.locator('#videoPage').evaluate(el=>el.style.setProperty('--player-safe-bottom','34px'));
await page.waitForTimeout(100);
assert.equal((await page.locator('.mobile-learning-dock').boundingBox()).height,146,'safe area adds padding without stretching icons');
await page.locator('#openLessonMore').click();
const safeMore=await page.locator('#lessonMore').boundingBox(),safeDock=await page.locator('.mobile-learning-dock').boundingBox();
assert.ok(safeMore.y+safeMore.height<=safeDock.y-7,'More clears the real dock including safe area');
await page.keyboard.press('Escape');
await page.locator('#videoPage').evaluate(el=>el.style.removeProperty('--player-safe-bottom'));
await page.locator('#speedSelect').selectOption('1.25');
assert.equal(await page.locator('#video').evaluate(video=>video.playbackRate),1.25,'dock speed control changes media rate');
await page.locator('#speedSelect').selectOption('0.5');
assert.deepEqual(await page.locator('#video').evaluate(video=>[video.playbackRate,video.defaultPlaybackRate]),[.5,.5]);
await page.waitForFunction(()=>window.__savedPreferences.playbackRate===.5);
await page.locator('#video').evaluate(video=>{video.playbackRate=1;video.dispatchEvent(new Event('loadedmetadata'))});
assert.equal(await page.locator('#video').evaluate(video=>video.playbackRate),.5,'source metadata restores chosen rate');
await page.locator('#speedSelect').selectOption('1');
await page.locator('#video').evaluate(video=>{video.currentTime=6.5;video.dispatchEvent(new Event('timeupdate'))});
if(await page.locator('#returnCurrentSentence').isVisible())await page.locator('#returnCurrentSentence').click();
await page.waitForTimeout(3500); // Let prior action toasts clear for reference screenshots.
// This fixture has no decodable media. Model ready/paused only for UI screenshots;
// these captures do not validate real playback, network speed, or media decoding.
await page.locator('#video').evaluate(video=>{video.dispatchEvent(new Event('pause'));video.dispatchEvent(new Event('loadeddata'))});
assert.equal(await page.locator('#mediaState').isVisible(),false,'ready paused fixture clears media status');
for(const theme of ['light','dark']){
 if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#studyThemeBtn').click();
 const before=await page.locator('#transcript [data-i="2"] [data-phrase]').first().evaluate(el=>getComputedStyle(el).color);
 await page.locator('#video').evaluate(video=>{video.currentTime=7.3;video.dispatchEvent(new Event('timeupdate'))});
 assert.equal(await page.locator('#transcript [data-i="2"] [data-phrase]').first().evaluate(el=>getComputedStyle(el).color),before,'timing preserves semantic keyword color in '+theme);
 await page.screenshot({path:`tmp/player-blue-${theme}-normal.png`});
 await page.locator('#dockBlind').click();
 assert.equal(await page.locator('#dockBlind').getAttribute('aria-pressed'),'true');
 await page.screenshot({path:`tmp/player-blue-${theme}-blind.png`});
 await page.locator('#dockBlind').click();
 await page.locator('#openLessonMore').click();
 await page.screenshot({path:`tmp/player-blue-${theme}-more.png`});
 await page.keyboard.press('Escape');
}
await page.evaluate(()=>{location.hash='#/home'});
await page.locator('#mobileVideoList [data-video="9001"]').waitFor();
assert.equal(await page.locator('#mobileVideoList [data-video]').count(),12);
await page.locator('#mobileLoadMore').click();
assert.equal(await page.locator('#mobileVideoList [data-video]').count(),15,'full catalog is paginated and deduplicated');
await page.locator('#mobileVideoSearch').fill('下一条');
assert.equal(await page.locator('#mobileVideoList [data-video]').count(),1);
await page.locator('#mobileVideoList [data-video="9002"]').focus();
await page.keyboard.press('Enter');
await page.waitForURL('**/#/video/9002');
await page.locator('#openQueueDirectory').click();
await page.locator('#queueDirectory[open]').waitFor();
assert.equal(await page.locator('#queueDirectoryList button').count(),1,'filtered directory has only the matching video');
assert.equal(await page.locator('#queueDirectoryList button').getAttribute('aria-current'),'true');
await page.keyboard.press('Escape');
assert.equal(await page.locator('#nextVideo').isDisabled(),true,'filtered queue excludes unmatching videos');
await page.locator('#videoPage .study-back').click();
await page.waitForURL('**/#/home');
await page.locator('#mobileVideoSearch').waitFor();
assert.equal(await page.locator('#mobileVideoSearch').inputValue(),'下一条','return restores account search');
await page.locator('#mobileNav [data-route="/discover"]').click();
await page.locator('#discoveryCreators').waitFor();
assert.ok(await page.locator('#discoveryCreators [data-route]').count()>0);

// Hidden-tab recovery uses the live position, not the original sentence link.
await page.evaluate(()=>{location.hash='#/video/9001?sentence=0'});
await page.waitForFunction(()=>State.route==='/video/9001'&&State.mediaPlayer);
await page.evaluate(()=>{
 const video=document.querySelector('#video');let paused=true,time=0;
 window.__resumePlayCount=0;
 Object.defineProperties(video,{readyState:{configurable:true,get:()=>4},duration:{configurable:true,get:()=>100},paused:{configurable:true,get:()=>paused},currentTime:{configurable:true,get:()=>time,set:value=>{time=value}}});
 video.play=()=>{window.__resumePlayCount++;paused=false;video.dispatchEvent(new Event('play'));return Promise.resolve()};
 video.pause=()=>{paused=true;video.dispatchEvent(new Event('pause'))};
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>!!window.__fixtureHidden});
 video.dispatchEvent(new Event('loadedmetadata'));
 setPracticeMode('loop');SentenceLoop.select(1);video.currentTime=3.5;
 window.__resumePlayCount=0;window.__fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'));
 window.dispatchEvent(new Event('pagehide'));
 window.__fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForFunction(()=>!!State.mediaPlayer);
await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('loadedmetadata')));
assert.deepEqual(await page.evaluate(()=>({time:document.querySelector('#video').currentTime,mode:State.practiceMode,index:State.practiceSelectedIndex,loop:SentenceLoop.isEnabled(),plays:window.__resumePlayCount,paused:document.querySelector('#video').paused})),{time:3.5,mode:'loop',index:1,loop:true,plays:0,paused:true});
await page.evaluate(()=>{SentenceLoop.play();const video=document.querySelector('#video');video.currentTime=4.6;video.dispatchEvent(new Event('timeupdate'))});
assert.equal(await page.locator('#video').evaluate(video=>video.currentTime),3,'loop remains functional after visibility recovery');
await page.evaluate(()=>{
 setPracticeMode('intensive');State.practiceSelectedIndex=1;State.practiceBoundaryReached=true;
 document.querySelector('#video').currentTime=4.46;window.__resumePlayCount=0;
 window.__fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'));
 window.__fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForFunction(()=>!!State.mediaPlayer);
await page.locator('#video').evaluate(video=>video.dispatchEvent(new Event('loadedmetadata')));
assert.deepEqual(await page.evaluate(()=>({time:document.querySelector('#video').currentTime,mode:State.practiceMode,index:State.practiceSelectedIndex,boundary:State.practiceBoundaryReached,plays:window.__resumePlayCount})),{time:4.46,mode:'intensive',index:1,boundary:true,plays:0});
// Navigating while suspended discards the old video's restoration state.
await page.evaluate(()=>{window.__fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'));location.hash='#/video/9002'});
await page.waitForFunction(()=>State.route==='/video/9002'&&State.mediaPlayer);
await page.evaluate(()=>{window.__fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));document.querySelector('#video').dispatchEvent(new Event('loadedmetadata'))});
assert.equal(await page.evaluate(()=>State.currentVideo.id),9002);
assert.equal(await page.evaluate(()=>suspendedPlayback),null,'navigation invalidates suspended recovery');
await page.evaluate(()=>{
 window.__fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'));
 window.__eastudyStudentId='different-student';
 window.__fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
});
assert.equal(await page.evaluate(()=>suspendedPlayback),null,'account changes discard the old owner recovery');
assert.equal(await page.evaluate(()=>State.mediaPlayer),null,'account changes cannot recreate the previous owner media session');
assert.deepEqual(pageErrors, []);

await browser.close();
console.log('Player UI: ten viewport layouts, exact dock/icon sizes, safe area, themes, learning markers, captions, word cards, automatic advance and practice controls passed.');
