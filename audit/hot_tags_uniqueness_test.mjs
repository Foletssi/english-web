import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const window = {};
vm.runInNewContext(fs.readFileSync('shared/catalog-selectors.js', 'utf8'), { window });
const { uniqueTagPage } = window.EastudyCatalog;

for (const count of [0, 1, 5, 10, 11]) {
  const tags = Array.from({ length: count }, (_, index) => ({ id: `tag-${index}` }));
  for (const offset of [0, 10, 20, -1]) {
    const rows = uniqueTagPage(tags, offset, 10);
    assert.equal(rows.length, Math.min(count, 10));
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  }
}

const duplicate = uniqueTagPage([
  { id: 'daily-life', labelZh: '日常生活' },
  { id: 'daily-life', labelZh: '日常生活' },
  { id: 'spoken-english', labelZh: '日常口语' }
]);
assert.deepEqual(Array.from(duplicate, row => row.id), ['daily-life', 'spoken-english']);
console.log('Hot tags: unique paging and duplicate category guard passed.');
