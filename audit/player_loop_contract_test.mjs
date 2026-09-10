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
  const window = {
    document,
    requestAnimationFrame: () => ++frameId,
    cancelAnimationFrame: () => {}
  };
  vm.runInNewContext(fs.readFileSync('shared/sentence-loop.js', 'utf8'), { window });
  return { api: window.EastudySentenceLoop, document };
}

const state = loadPlayerState();
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
assert.ok(css.includes('.word-token.keyword-tone-1{color:') && css.includes('.word-token.keyword-tone-4{color:'));
assert.ok(adminHtml.includes('href="#/learners"') && adminHtml.includes('学员管理'));
assert.ok(adminJs.includes('function renderLearners(') && adminJs.includes('function renderLearnerDetail('));
assert.ok(adminCss.includes('.learner-toolbar') && adminCss.includes('.learner-history'));
assert.ok(supabaseClient.includes("api.rpc('admin_list_learners_v1'") && supabaseClient.includes("api.rpc('touch_my_activity_v1'"));
assert.ok(migration.includes("raise exception 'ADMIN_REQUIRED'") && migration.includes('security definer'));
assert.ok(migration.includes('revoke all on table private.learner_activity'));
assert.equal(migration.includes('completed_sentences'), false, 'unknown daily statistic columns must not be guessed');
assert.equal(migration.includes('reviewed_words'), false, 'unknown daily statistic columns must not be guessed');

console.log('Player loop and learner admin contract: 35 checks passed.');
