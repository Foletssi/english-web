import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadPlayerState() {
  const window = {};
  vm.runInNewContext(fs.readFileSync('shared/player-state.js', 'utf8'), { window });
  return window.EastudyPlayerState;
}

class EventFixture {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name) { for (const handler of this.listeners.get(name) || []) handler(); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, rows) => sum + rows.size, 0); }
}

class VideoFixture extends EventFixture {
  constructor() {
    super();
    this.currentTime = 0;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.playCount = 0;
    this.readyState = 4;
  }
  play() {
    this.playCount += 1;
    this.paused = false;
    this.ended = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.emit('pause');
  }
}

function loadLoop(video) {
  const document = new EventFixture();
  document.hidden = false;
  let frameId = 0;
  let now = 0, timerId = 0;
  const timers = new Map();
  const window = {
    document,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => ++frameId,
    cancelAnimationFrame: () => {}
  };
  vm.runInNewContext(fs.readFileSync('shared/sentence-loop.js', 'utf8'), { window });
  return { api: window.EastudySentenceLoop, document, advance: ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
  }, timerCount: () => timers.size };
}

const state = loadPlayerState();
assert.equal(state.initialPosition('0', [{s:0},{s:8}], 12), 0);
assert.equal(state.initialPosition('1', [{s:0},{s:8}], 12), 8);
for (const query of [null,'','-1','1.5','abc','10']) {
  assert.equal(state.initialPosition(query, [{s:0},{s:8}], 12), 12);
}
const seekVideo = new VideoFixture();
seekVideo.duration = 30;
seekVideo.readyState = 0;
let current = true, applied = 0;
const cancelSeek = state.attachInitialSeek(seekVideo, 8, () => current, () => applied++);
assert.equal(seekVideo.currentTime, 0, 'do not seek using metadata from the previous source');
seekVideo.emit('loadedmetadata');
assert.equal(seekVideo.currentTime, 0);
seekVideo.readyState = 1;
seekVideo.emit('loadedmetadata');
assert.equal(seekVideo.currentTime, 8);
assert.equal(applied, 1);
seekVideo.emit('loadedmetadata');
assert.equal(applied, 1, 'initial seek is one-shot, including media retries');
cancelSeek();
state.attachInitialSeek(seekVideo, 18, () => current, () => applied++);
current = false;
seekVideo.emit('loadedmetadata');
assert.equal(seekVideo.currentTime, 8, 'late metadata may not seek a different route');
const cancelPending = state.attachInitialSeek(seekVideo, 20, () => true);
cancelPending();
seekVideo.emit('loadedmetadata');
assert.equal(seekVideo.currentTime, 8);
assert.equal(seekVideo.listenerCount(), 0);
for (const code of ['PLAYBACK_AUTH_UNAVAILABLE','PLAYBACK_TICKET_UNAVAILABLE','SESSION_TIMEOUT','']) {
  const message=state.sessionMessage(code).join(' ');
  assert.match(message,/播放服务暂时不可用/);
  assert.doesNotMatch(message,/检查登录|重新登录/,'server failures must not blame the learner session');
}
assert.match(state.sessionMessage('INVALID_SESSION').join(' '),/重新登录/);
assert.match(state.sessionMessage('VIP_EXPIRED').join(' '),/续期/);
assert.match(state.sessionMessage('PLAYBACK_FORBIDDEN').join(' '),/管理员/);
const sentences = [
  { id: 'a', s: 1, e: 2, en: 'First' },
  { id: 'b', s: 3, e: 5, en: 'Second' }
];
const timeline = state.buildCaptionTimeline(sentences);
assert.equal(state.selectCaption('ready', timeline, 0.5).kind, 'blank');
assert.equal(state.selectCaption('ready', timeline, 1.5).kind, 'cue');
assert.equal(state.selectCaption('ready', timeline, 2.5).kind, 'hold');
assert.equal(state.selectCaption('ready', timeline, 6).sentence.en, 'Second');
assert.equal(state.selectCaption('loading', timeline, 1.5).kind, 'loading');
assert.equal(state.selectCaption('error', timeline, 1.5).kind, 'error');
assert.equal(state.selectCaption('ready', [], 1.5).kind, 'empty');

const video = new VideoFixture();
const selected = [];
const { api, document } = loadLoop(video);
const loop = api.create(video, {
  getCues: () => timeline,
  onSelect: index => selected.push(index)
});
assert.equal(loop.enable(0), true);
assert.equal(loop.isEnabled(), true);
assert.equal(video.currentTime, 1);
assert.equal(video.paused, false);
video.currentTime = 2.02;
video.emit('timeupdate');
assert.equal(video.currentTime, 1, 'sentence end must jump to the selected sentence start');

loop.pause();
video.currentTime = 2.2;
video.emit('timeupdate');
assert.equal(video.currentTime, 2.2, 'a paused loop must not restart itself');
assert.equal(loop.select(1), true);
assert.equal(loop.getIndex(), 1);
assert.equal(video.currentTime, 3);
assert.equal(video.paused, true, 'selecting a sentence while paused must stay paused');

loop.play();
loop.seek(4);
assert.equal(video.currentTime, 4);
loop.seek(5.5);
assert.equal(video.currentTime, 3, 'seeking into a gap keeps the previous sentence loop');
video.ended = true;
video.paused = true;
assert.equal(loop.handleEnded(), true, 'loop mode must consume the media ended event');
assert.equal(video.currentTime, 3);
assert.equal(video.paused, false);

document.hidden = true;
document.emit('visibilitychange');
assert.equal(video.paused, true, 'hidden pages must pause the loop');
loop.dispose();
assert.equal(video.listenerCount(), 0);
assert.equal(document.listenerCount(), 0);
assert.ok(selected.includes(0) && selected.includes(1));

const restoredVideo = new VideoFixture();
const restoredLoop = loadLoop(restoredVideo).api.create(restoredVideo, {getCues: () => timeline});
assert.equal(restoredLoop.enable(1, {autoplay: false}), true);
assert.equal(restoredLoop.isEnabled(), true);
assert.equal(restoredLoop.getIndex(), 1);
assert.equal(restoredVideo.playCount, 0, 'restoring a ready loop must never request playback');
restoredVideo.currentTime = 4;
restoredLoop.play();
assert.equal(restoredVideo.playCount, 1);
restoredVideo.currentTime = 5.1;
restoredVideo.emit('timeupdate');
assert.equal(restoredVideo.currentTime, 3, 'restored loop still repeats its selected sentence');
restoredLoop.dispose();

const slowVideo = new VideoFixture();
slowVideo.readyState = 1;
const clock = loadLoop(slowVideo), feedback = [], errors = [];
const slowLoop = clock.api.create(slowVideo, {getCues: () => timeline, onBuffering: x => feedback.push(x), onError: x => errors.push(x.message)});
slowLoop.enable(0);
assert.equal(slowVideo.playCount, 0, 'wait for decoded media before resuming');
clock.advance(299);
assert.deepEqual(feedback, [], 'fast seek does not flash buffering');
clock.advance(1);
assert.deepEqual(feedback, [true]);
slowLoop.pause();
slowVideo.readyState = 4;
slowVideo.emit('canplay');
assert.equal(slowVideo.playCount, 0, 'cancelled buffering cannot restart playback');
assert.equal(clock.timerCount(), 0);
slowLoop.play();
slowVideo.emit('pause');
assert.equal(slowLoop.isPlayRequested(), true, 'queued internal pause cannot cancel resumed playback');
for (let i = 0; i < 20; i++) {
  slowVideo.currentTime = 2.01;
  slowVideo.emit('timeupdate');
  slowVideo.emit('seeked');
  assert.equal(slowVideo.currentTime, 1);
  assert.equal(slowVideo.paused, false);
}
slowVideo.readyState = 1;
slowLoop.select(1);
slowLoop.select(0);
slowVideo.readyState = 4;
slowVideo.emit('seeked');
assert.equal(slowVideo.currentTime, 1, 'latest selected cue owns the pending seek');
assert.equal(clock.timerCount(), 0);
slowVideo.readyState = 1;
slowLoop.select(1);
clock.advance(8000);
assert.deepEqual(errors, ['SENTENCE_BUFFER_TIMEOUT']);
assert.equal(slowLoop.isPlayRequested(), false);
slowVideo.readyState = 4;
const plays = slowVideo.playCount;
slowVideo.emit('canplay');
assert.equal(slowVideo.playCount, plays, 'late readiness after timeout must not auto-resume');
slowLoop.play();
assert.equal(slowVideo.paused, false, 'explicit retry resumes the selected cue');
slowVideo.readyState = 1;
slowLoop.select(0);
slowLoop.dispose();
clock.advance(10000);
assert.equal(clock.timerCount(), 0);
assert.equal(slowVideo.listenerCount(), 0);

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('assets/js/app.js', 'utf8');
const css = fs.readFileSync('assets/css/app.css', 'utf8');
const adminHtml = fs.readFileSync('admin/index.html', 'utf8');
const adminJs = fs.readFileSync('admin/assets/admin.js', 'utf8');
const adminCss = fs.readFileSync('admin/assets/admin.css', 'utf8');
const supabaseClient = fs.readFileSync('shared/supabase-client.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260910213000_learner_admin_and_activity_v1.sql', 'utf8');

for (const forbidden of ['MediaRecorder', 'getUserMedia', 'recordPlayback', 'id="follow"']) {
  assert.equal(`${html}\n${app}`.includes(forbidden), false, `${forbidden} must not remain in the player`);
}
assert.ok(html.includes('data-practice="loop"') && html.includes('循环跟读'));
assert.ok(css.includes('.word-token.teaching-keyword') && css.includes('text-decoration-color:currentColor'));
assert.ok(css.includes(':is(.word-token,.teaching-expression).keyword-tone-1{color:') && css.includes(':is(.word-token,.teaching-expression).keyword-tone-4{color:'));
const navWindow = {};
vm.runInNewContext(fs.readFileSync('admin/assets/content-check.js', 'utf8'), {window:navWindow});
assert.ok(adminHtml.includes('href="#/learners"') && adminHtml.includes('学员与会员'));
assert.ok(navWindow.EastudyContentCheck.tabs('/learners').includes('学员管理'));
assert.ok(adminJs.includes('function renderLearners(') && adminJs.includes('function renderLearnerDetail('));
assert.ok(adminCss.includes('.learner-toolbar') && adminCss.includes('.learner-history'));
assert.ok(supabaseClient.includes("api.rpc('admin_list_learners_v1'") && supabaseClient.includes("api.rpc('touch_my_activity_v1'"));
assert.ok(migration.includes("raise exception 'ADMIN_REQUIRED'") && migration.includes('security definer'));
assert.ok(migration.includes('revoke all on table private.learner_activity'));
assert.equal(migration.includes('completed_sentences'), false, 'unknown daily statistic columns must not be guessed');
assert.equal(migration.includes('reviewed_words'), false, 'unknown daily statistic columns must not be guessed');

console.log('Player loop and learner admin contract: all checks passed.');
