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
    duration: 8,
    level: 'cet4',
    tagIds: ['daily-life'],
    collectionIds: []
  }],
  sentences: {
    9001: [
      { id: '9001-1', order: 0, startTime: 1, endTime: 2, english: 'Taking a short break.', chinese: '短暂休息一下。', keyWords: ['taking'], reviewStatus: 'APPROVED' },
      { id: '9001-2', order: 1, startTime: 3, endTime: 4.5, english: 'Then we continue.', chinese: '然后我们继续。', keyWords: ['continue'], reviewStatus: 'APPROVED' }
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
assert.deepEqual(pageErrors, []);

await browser.close();
console.log('Player loop browser UI: blank pre-roll, held gap, keyword style and mobile layout passed.');
