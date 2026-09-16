import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateManifest,validateReceipt,expectedSnapshot} from '../scripts/refresh-teaching-voice.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'eastudy-voice-contract-'));
try{
  fs.mkdirSync(path.join(root,'voice'));const data=Buffer.alloc(600,1),fingerprint='a'.repeat(64),storagePath=`voice/${fingerprint}.mp3`;
  fs.writeFileSync(path.join(root,storagePath),data);const sha256=createHash('sha256').update(data).digest('hex');
  const source={video:{id:'v1'},sentences:[{id:'s1',english:'Read',textRevision:2,expressions:[],wordLookup:{sourceEnglish:'Read',sourceTextRevision:2,tokens:[{tokenId:'t0',surface:'Read'}]}}]};
  const manifest={status:'complete',videoId:'v1',contentRevision:'gen1',ready:1,total:1,items:[{sentenceId:'s1',kind:'token',tokenId:'t0',text:'Read',sourceTextRevision:2,contentRevision:'gen1',videoId:'v1',status:'ready',itemId:'b'.repeat(64),fingerprint,storagePath,bytes:600,contentHash:sha256}]};
  const assets=validateManifest(manifest,source,root,'gen1');assert.equal(assets.length,1);
  const bad=structuredClone(manifest);bad.items[0].tokenId='t1';assert.throws(()=>validateManifest(bad,source,root,'gen1'));
  bad.items[0]={...manifest.items[0],contentHash:'c'.repeat(64)};assert.throws(()=>validateManifest(bad,source,root,'gen1'));
  bad.items[0]={...manifest.items[0],sourceTextRevision:1};assert.throws(()=>validateManifest(bad,source,root,'gen1'));
  bad.items[0]={...manifest.items[0],storagePath:'../escape.mp3'};assert.throws(()=>validateManifest(bad,source,root,'gen1'));
  const receipt={...assets[0],etag:'etag'};assert.deepEqual(validateReceipt(receipt,assets[0]),receipt);
  assert.throws(()=>validateReceipt({...receipt,size:100},assets[0]));assert.throws(()=>validateReceipt({...receipt,sha256:'c'.repeat(64)},assets[0]));
  const video={id:'v1',processingJobId:'job1',title:'Keep title'},other={id:'v2',title:'Keep unrelated'};
  const before={revision:2,published:{videos:[video,other],sentences:{v1:source.sentences}},draft:{videos:[video,other],sentences:{v1:source.sentences}}};
  const expected=expectedSnapshot(before,'v1','job1',manifest);assert.equal(expected.revision,3);assert.equal(expected.draft.videos[0].voiceManifest.status,'complete');assert.deepEqual(expected.published.videos[1],other);assert.equal(before.draft.videos[0].voiceManifest,undefined);
  const changed=JSON.parse(JSON.stringify(before));changed.draft.sentences.v1[0].english='Different draft';assert.deepEqual(expectedSnapshot(changed,'v1','job1',manifest).draft,changed.draft);
  console.log('Voice maintenance contracts passed: exact identity, hash, receipt, draft isolation and field-only readback.');
}finally{
  // Only delete the exact temporary directory created by this test.
  fs.rmSync(root,{recursive:true,force:true});
}
