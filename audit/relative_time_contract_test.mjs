import assert from 'node:assert/strict';
await import('../shared/relative-time.js');
const relative=globalThis.EastudyRelativeTime.relativeTimeZh;
const at=value=>Date.parse(value);

assert.equal(relative(at('2026-09-12T10:00:00+08:00'),at('2026-09-12T10:00:03+08:00')),'刚刚');
assert.equal(relative(at('2026-09-12T09:59:30+08:00'),at('2026-09-12T10:00:00+08:00')),'30 秒前');
assert.equal(relative(at('2026-09-12T09:30:00+08:00'),at('2026-09-12T10:00:00+08:00')),'30 分钟前');
assert.equal(relative(at('2026-09-12T08:00:00+08:00'),at('2026-09-12T10:00:00+08:00')),'2 小时前');
assert.equal(relative(at('2026-09-11T10:00:00+08:00'),at('2026-09-12T10:00:00+08:00')),'1 天前');
assert.equal(relative(at('2026-01-31T10:00:00+08:00'),at('2026-02-28T10:00:00+08:00')),'1 个月前');
assert.equal(relative(at('2024-02-29T10:00:00+08:00'),at('2025-02-28T10:00:00+08:00')),'1 年前');
assert.equal(relative(at('2026-09-12T10:02:00+08:00'),at('2026-09-12T10:00:00+08:00')),'时间待校准');
assert.equal(relative('',at('2026-09-12T10:00:00+08:00')),'尚未上报');

console.log('Beijing relative time boundary contracts passed.');
