import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function storage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function contentStore(pathname, localStorage, sessionStorage) {
  const window = {
    location: { hostname: 'english-web-lce.pages.dev', pathname },
    localStorage,
    sessionStorage,
    dispatchEvent() {}
  };
  const context = vm.createContext({
    window,
    localStorage,
    sessionStorage,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console
  });
  vm.runInContext(fs.readFileSync(new URL('../shared/content-store.js', import.meta.url), 'utf8'), context);
  return window.ZoContent;
}

const sharedLocalStorage = storage();
const adminSessionStorage = storage();
const studentSessionStorage = storage();
const admin = contentStore('/admin/', sharedLocalStorage, adminSessionStorage);
const student = contentStore('/', sharedLocalStorage, studentSessionStorage);

assert.equal(admin.SCOPE, 'admin');
assert.equal(student.SCOPE, 'student');
assert.notEqual(admin.KEY, student.KEY, 'admin and student content caches must be isolated');
admin.importSnapshot({ schemaVersion: 2, videos: [{ id: 101, title: 'Admin video' }], sentences: {}, creators: [], collections: [], jobs: [], auditLog: [] });
student.importSnapshot({ schemaVersion: 2, videos: [], sentences: {}, creators: [], collections: [], jobs: [], auditLog: [] });
assert.deepEqual(JSON.parse(JSON.stringify(admin.listVideos().map(video => video.id))), [101], 'student import must not erase the admin cache');

const adminSource = fs.readFileSync(new URL('../admin/assets/admin.js', import.meta.url), 'utf8');
const timelineSource = ['wordTimelineValue', 'parseWordTimeline'].map(name => {
  const match = adminSource.match(new RegExp(`function ${name}\\([^\\n]+`));
  assert.ok(match, `${name} must remain directly testable`);
  return match[0];
}).join('\n');
const timelineContext = vm.createContext({ JSON, Number, String, Error });
vm.runInContext(timelineSource, timelineContext);
const original = [{ text: 'No,', start: 16.981234, end: 17.221234 }, { text: "I'm", start: 17.321234, end: 17.441234 }];
const encoded = timelineContext.wordTimelineValue({ wordTimings: original });
const decoded = timelineContext.parseWordTimeline(encoded);
assert.deepEqual(JSON.parse(JSON.stringify(decoded)), original, 'punctuation and Whisper precision must survive a round trip');
assert.throws(() => timelineContext.parseWordTimeline('No,@16.98-17.22'), /JSON/, 'legacy comma parsing must not silently corrupt words');

console.log(JSON.stringify({ ok: true, tests: 8 }, null, 2));
