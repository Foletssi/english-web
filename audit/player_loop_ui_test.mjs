import assert from 'node:assert/strict';
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

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route('https://cdn.jsdelivr.net/**', route => {
  const body = route.request().url().includes('hls.js') ? 'window.Hls=undefined;' : 'window.supabase={createClient(){return {}}};';
  return route.fulfill({ status: 200, contentType: 'application/javascript', body });
});
await context.addInitScript(snapshotValue => {
  localStorage.setItem('zs:platform:content:local:v1', JSON.stringify(snapshotValue));
  localStorage.setItem('zs:user:student-fixture:learningPlan', JSON.stringify({ track: 'general', dailyMinutes: 20, onboardingVersion: 1 }));
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
    saveLearningPreferences: async () => ({ error: null }),
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
await page.waitForFunction(() => document.documentElement.dataset.authState === 'authenticated');
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
await page.locator('[data-practice="watch"]').click();
for (const viewport of [{width:320,height:640},{width:360,height:800},{width:390,height:844},{width:430,height:932},{width:768,height:1024},{width:1024,height:768},{width:1280,height:800},{width:844,height:390}]) {
  await page.setViewportSize(viewport);
  const transcriptTab = page.locator('[data-mobile-study="transcript"]');
  if (await transcriptTab.isVisible()) await transcriptTab.click();
  assert.ok(await page.locator('#transcript').isVisible(), `transcript is actually displayed at ${viewport.width}`);
  await page.locator('#video').evaluate(video => { video.currentTime = 60.25; video.dispatchEvent(new Event('timeupdate')); });
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no global overflow at ${viewport.width}`);
  const visible = await page.locator('#transcript [data-i="20"]').evaluate(line => {
    const box = document.querySelector('#transcript').getBoundingClientRect(), rect = line.getBoundingClientRect();
    return rect.top >= box.top-2 && rect.bottom <= box.bottom+2;
  });
  const layout = await page.locator('#transcript').evaluate(box => ({top:box.getBoundingClientRect().top,height:box.clientHeight,scrollTop:box.scrollTop,scrollHeight:box.scrollHeight,line:box.querySelector('[data-i="20"]')?.getBoundingClientRect().toJSON(),active:box.querySelector('.active')?.dataset.i,time:document.querySelector('#video').currentTime}));
  assert.ok(visible, `current sentence follows inside transcript at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
}
await page.setViewportSize({width:390,height:844});
await page.locator('[data-mobile-study="transcript"]').click();
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
assert.deepEqual(pageErrors, []);

await browser.close();
console.log('Player UI: blank pre-roll, held gap, keywords, eight viewport layouts, lyric following, browsing/return and non-seeking word card passed.');
