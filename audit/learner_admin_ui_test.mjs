import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.EASTUDY_LOCAL_URL || 'http://127.0.0.1:8080';
const learnerId = '11111111-1111-4111-8111-111111111111';
const learner = {
  id: learnerId,
  phone: '+8613888888888',
  nickname: '本地测试学员',
  role: 'learner',
  isActive: true,
  createdAt: '2026-09-01T08:00:00Z',
  membershipStatus: 'active',
  membershipExpiresAt: '2026-12-31T08:00:00Z',
  remainingSeconds: 96300,
  lastSignInAt: '2026-09-10T05:20:00Z',
  lastSeenAt: '2026-09-10T05:25:00Z',
  totalLearningSeconds: 3725,
  learningDays: 8,
  completedVideos: 3,
  masteredWords: 42
};

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.supabase={createClient(){return {}}};' }));
await context.route('http://127.0.0.1:8788/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [], ready: false }) }));
await context.addInitScript(({ learner, learnerId }) => {
  const auth = {
    getContext: async () => ({ user: { id: 'admin-fixture' }, profile: { role: 'admin', nickname: '本地管理员' } }),
    signOut: async () => ({ error: null }),
    signInPhone: async () => ({ error: null })
  };
  const data = {
    listLearners: async () => ({ serverTime: '2026-09-10T05:30:00Z', page: 1, pageSize: 25, total: 1, items: [learner] }),
    getLearnerDetail: async id => {
      if (id !== learnerId) throw new Error('LEARNER_NOT_FOUND');
      return {
        serverTime: '2026-09-10T05:30:00Z',
        learner,
        daily: [{ studyDate: '2026-09-10', learningSeconds: 125 }],
        history: { page: 1, pageSize: 25, total: 1, items: [{ videoId: 1788926081632, videoTitle: null, watchCoveragePercent: 63, completedAt: null, lastWatchedAt: '2026-09-10T05:22:00Z' }] }
      };
    }
  };
  Object.defineProperty(window, 'EastudyAuth', { configurable: true, get: () => auth, set: () => {} });
  Object.defineProperty(window, 'EastudyData', { configurable: true, get: () => data, set: () => {} });
}, { learner, learnerId });

const page = await context.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => consoleErrors.push(error.message));
page.on('requestfailed', request => failedRequests.push(`${request.url()} — ${request.failure()?.errorText || 'failed'}`));

await page.goto(`${baseUrl}/admin/#/learners`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '学员管理' }).waitFor();
assert.equal(await page.locator('.learners-table tbody tr').count(), 1);
assert.equal(await page.getByText('本地测试学员').count(), 1);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'desktop page must not overflow globally');
await page.screenshot({ path: 'tmp/local-learner-desktop.png', fullPage: true });

await page.goto(`${baseUrl}/admin/#/learners/${learnerId}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '本地测试学员' }).waitFor();
assert.equal(await page.getByText('不足 1 小时').count(), 0);
assert.equal(await page.getByText('1 小时 2 分钟').count(), 1);
assert.equal(await page.getByText('已移除视频（保留学习记录）').count(), 1);

await page.setViewportSize({ width: 375, height: 812 });
await page.goto(`${baseUrl}/admin/#/learners`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '学员管理' }).waitFor();
await page.waitForTimeout(250);
assert.notEqual(await page.locator('#sidebar').evaluate(element => getComputedStyle(element).transform), 'none', 'mobile sidebar must start closed');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page must not overflow globally');
assert.ok(await page.locator('#learnerSearch').evaluate(element => element.getBoundingClientRect().height >= 44));
await page.screenshot({ path: 'tmp/local-learner-mobile.png', fullPage: true });

await page.goto(`${baseUrl}/admin/#/learners/${learnerId}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '本地测试学员' }).waitFor();
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile learner detail must not overflow globally');
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
assert.equal(await page.evaluate(() => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight), true, 'mobile learner detail must scroll to its final controls');
await page.screenshot({ path: 'tmp/local-learner-detail-mobile.png', fullPage: true });

assert.deepEqual(consoleErrors, [], `failed requests: ${failedRequests.join('; ')}`);
await browser.close();
console.log('Learner admin browser UI: desktop, detail, mobile and clean console passed.');
