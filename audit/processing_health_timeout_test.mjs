import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync('shared/cloud-content.js','utf8');
assert.ok(source.includes("/api/admin/processing-control?action=health"));
assert.ok(source.includes("controlPlane:'r2'") || source.includes('controlPlane:'));
console.log('R2 processing health client contract passed.');
