// Reviewed published teaching -> private local synthesis -> leased, atomic voice publication.
// Dry-run is read-only. --prepare generates locally; only --apply writes to the cloud.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ORIGIN='https://english-web-lce.pages.dev';
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{try{assert.deepEqual(a,b);return true;}catch{return false;}};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function save(file,value){const temporary=file+'.part';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,file);}

export function validateManifest(manifest,source,output,revision){
  assert.equal(manifest?.status,'complete','Voice generation is incomplete');
  assert.equal(manifest.videoId,String(source.video.id));
  assert.equal(manifest.contentRevision,revision);
  const expected=new Map();
  for(const row of source.sentences){
    const lookup=row.wordLookup;
    assert.equal(lookup?.sourceEnglish,row.english,'Stale word lookup');
    assert.equal(lookup?.sourceTextRevision,Number(row.textRevision||1));
    for(const [kind,items] of [['token',lookup.tokens],['expression',row.expressions||[]]]){
      for(const [index,item] of items.entries()){
        if(kind==='expression'&&['REJECTED','DELETED'].includes(String(item.reviewStatus||'').toUpperCase()))continue;
        const id=kind==='token'?item.tokenId:(item.expressionId||`e${index}`);
        const identity=JSON.stringify([String(row.id),kind,id]);
        assert.ok(!expected.has(identity),'Duplicate teaching identity');
        expected.set(identity,{row,item});
      }
    }
  }
  assert.ok(expected.size>0,'No teaching audio items');
  assert.equal(manifest.items.length,expected.size,'Incomplete voice identities');
  assert.equal(manifest.ready,expected.size);assert.equal(manifest.total,expected.size);
  const files=new Map(),ids=new Set();
  for(const item of manifest.items){
    const identity=JSON.stringify([item.sentenceId,item.kind,item.kind==='token'?item.tokenId:item.expressionId]);
    const sourceItem=expected.get(identity);assert.ok(sourceItem,'Unknown or duplicate voice identity');expected.delete(identity);
    assert.equal(item.text,sourceItem.item.surface);assert.equal(item.sourceTextRevision,Number(sourceItem.row.textRevision||1));
    assert.equal(item.contentRevision,revision);assert.equal(item.videoId,String(source.video.id));
    assert.equal(item.status,'ready');assert.match(item.itemId,/^[a-f0-9]{64}$/);assert.ok(!ids.has(item.itemId));ids.add(item.itemId);
    assert.match(item.fingerprint,/^[a-f0-9]{64}$/);assert.equal(item.storagePath,`voice/${item.fingerprint}.mp3`);
    const data=fs.readFileSync(path.join(output,item.storagePath));
    assert.ok(data.length>=500&&data.length<=1048576);assert.equal(item.bytes,data.length);assert.equal(item.contentHash,hash(data));
    files.set(item.storagePath,{path:item.storagePath,size:data.length,sha256:item.contentHash});
  }
  return [...files.values()];
}

export function validateReceipt(receipt,asset){
  assert.equal(receipt.path,asset.path);assert.equal(receipt.size,asset.size);assert.equal(receipt.sha256,asset.sha256);
  assert.ok(typeof receipt.etag==='string'&&receipt.etag.length>0&&receipt.etag.length<=200);
  return {path:receipt.path,size:receipt.size,sha256:receipt.sha256,etag:receipt.etag};
}

export function expectedSnapshot(before,videoId,jobId,manifest){
  const expected=structuredClone(before);
  expected.published.videos=expected.published.videos.map(v=>String(v.id)===videoId?{...v,voiceManifest:manifest}:v);
  if(equal(before.draft.sentences?.[videoId],before.published.sentences?.[videoId])){
    expected.draft.videos=expected.draft.videos.map(v=>String(v.id)===videoId&&v.processingJobId===jobId?{...v,voiceManifest:manifest}:v);
  }
  expected.revision=Number(before.revision)+1;
  return expected;
}

async function generate(python,request,output){
  await new Promise((resolve,reject)=>{
    const child=spawn(python,[path.join(ROOT,'services/local-studio/teaching_voice.py'),'--request',request,
      '--output-dir',output,'--manifest',path.join(output,'voice-manifest.json')],{
      cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
    let lastProgress=Date.now(),reported=0;
    const timer=setInterval(()=>{if(Date.now()-lastProgress>180000){child.kill();}},1000);
    for(const stream of [child.stdout,child.stderr]){
      let pending='';stream.setEncoding('utf8');stream.on('data',chunk=>{
        pending+=chunk;let next;
        while((next=pending.indexOf('\n'))>=0){const line=pending.slice(0,next);pending=pending.slice(next+1);
          try{const event=JSON.parse(line);if(event.event==='progress'){
            lastProgress=Date.now();if(lastProgress-reported>5000||event.current===event.total){
              console.log(JSON.stringify({stage:'generate',current:event.current,total:event.total,status:event.status}));reported=lastProgress;
            }
          }}catch{/* Model diagnostics stay private; never echo subprocess output. */}
        }
        if(pending.length>8192)pending='';
      });
    }
    child.on('error',()=>{clearInterval(timer);reject(Error('Private voice runtime could not start'));});
    child.on('close',code=>{clearInterval(timer);code===0?resolve():reject(Error('Voice generation incomplete; inspect private manifest and retry'));});
  });
}

async function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const cli=option('--cli'),videoId=option('--video'),directory=option('--output');
  if(!cli||!videoId||!directory)throw Error('Required: --cli PATH --video ID --output tmp/DIRECTORY [--python PATH] [--prepare|--apply]');
  const output=path.resolve(ROOT,directory),relative=path.relative(path.join(ROOT,'tmp'),output);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Output must be a private subdirectory of repository tmp');
  fs.mkdirSync(output,{recursive:true});
  function query(sql,name){
    const file=path.join(output,name+'.sql');fs.writeFileSync(file,sql);
    try{return JSON.parse(execFileSync(cli,['db','query','--linked','--file',file,'--output','json'],{
      cwd:ROOT,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,timeout:120000,stdio:['ignore','pipe','pipe']})).rows;}
    catch{throw Error(`Official database operation failed (${name}); SQL and capabilities suppressed`);}
  }
  const current=()=>query("select revision,published,draft from private.content_snapshots where environment='production'",'read-current')[0];
  const before=current();assert.ok(before,'Production catalog missing');
  const videos=before.published.videos.filter(v=>String(v.id)===videoId&&v.status==='PUBLISHED');assert.equal(videos.length,1,'Exactly one published video required');
  const source={video:videos[0],sentences:before.published.sentences[videoId]};
  const jobId=source.video.processingJobId;assert.match(jobId,/^[a-f0-9-]{36}$/i);assert.ok(Array.isArray(source.sentences)&&source.sentences.length);
  const revision=hash(JSON.stringify({videoId,jobId,rows:source.sentences}));
  const sourceFile=path.join(output,'voice-source.json');
  if(fs.existsSync(sourceFile)){
    const previous=read(sourceFile);assert.equal(previous.jobId,jobId,'Output belongs to another media job');
    assert.equal(previous.contentRevision,revision,'Teaching changed; use a new output directory');
  }
  save(sourceFile,{videoId,jobId,contentRevision:revision,revision:before.revision,sentences:source.sentences});
  const count=source.sentences.reduce((n,s)=>n+(s.wordLookup?.tokens?.length||0)+(s.expressions||[]).filter(e=>!['REJECTED','DELETED'].includes(String(e.reviewStatus||'').toUpperCase())).length,0);
  const missingTeachingRows=source.sentences.filter(s=>s.wordLookup?.sourceEnglish!==s.english||
    s.wordLookup?.sourceTextRevision!==Number(s.textRevision||1)||!s.wordLookup?.tokens?.length).length;
  if(!args.includes('--prepare')&&!args.includes('--apply')){
    console.log(JSON.stringify({videoId,revision:before.revision,sentences:source.sentences.length,items:count,
      teachingDetailsReady:missingTeachingRows===0,missingTeachingRows,dryRun:true}));return;
  }
  if(missingTeachingRows)throw Error('Publish current complete teaching details before preparing voice audio');
  const cache=path.join(os.homedir(),'.cache/eastudy-kokoro-v1.0');
  const python=option('--python')||process.env.EASTUDY_VOICE_PYTHON||path.join(ROOT,'tmp/voice-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const config={modelPath:process.env.ZOSPEAK_TTS_MODEL_PATH||path.join(cache,'kokoro-v1.0.int8.onnx'),
    voicesPath:process.env.ZOSPEAK_TTS_VOICES_PATH||path.join(cache,'voices-v1.0.bin'),voice:'af_heart',language:'en-us'};
  const request=path.join(output,'voice-request.json');save(request,{videoId,contentRevision:revision,rows:source.sentences,config});
  await generate(python,request,output);
  const manifest=read(path.join(output,'voice-manifest.json'));
  const assets=validateManifest(manifest,source,output,revision);
  if(!args.includes('--apply')){console.log(JSON.stringify({videoId,prepared:true,items:manifest.total,files:assets.length}));return;}
  const latest=current();assert.deepEqual(latest,before,'Catalog changed during generation; rerun to retain prepared audio and recheck');
  if(source.video.voiceManifest?.status==='complete'&&source.video.voiceManifest.contentRevision===revision&&
      equal(source.video.voiceManifest?.items?.map(i=>i.itemId),manifest.items.map(i=>i.itemId))&&
      equal(source.video.voiceManifest?.items?.map(i=>i.contentHash),manifest.items.map(i=>i.contentHash))){
    console.log(JSON.stringify({videoId,alreadyPublished:true,revision:before.revision}));return;
  }
  save(path.join(output,'before-voice-publication.json'),before);
  const lease=query("set request.jwt.claim.role='service_role'; select public.service_begin_voice_refresh("+literal(jobId)+'::uuid,'+before.revision+') as result','begin-voice')[0].result;
  assert.equal(lease.jobId,jobId);assert.match(lease.runId,/^[a-f0-9-]{36}$/i);assert.ok(typeof lease.token==='string'&&lease.token.length>=32);
  const receiptFile=path.join(output,'voice-upload-receipts.json');
  let local=fs.existsSync(receiptFile)?read(receiptFile):{jobId,runId:lease.runId,receipts:[]};
  assert.equal(local.jobId,jobId);assert.equal(local.runId,lease.runId,'Media run changed; use a new output directory');
  const known=new Map([...local.receipts,...lease.existingReceipts].map(r=>[r.path,r])),receipts=[];
  for(const [index,asset] of assets.entries()){
    let receipt=known.get(asset.path);
    if(!receipt){
      const url=new URL('/api/processing/output',ORIGIN);url.search=new URLSearchParams({job:jobId,run:lease.runId,token:lease.token,path:asset.path}).toString();
      let response;
      try{response=await fetch(url,{method:'PUT',body:fs.readFileSync(path.join(output,asset.path)),redirect:'error',headers:{'Content-Type':'audio/mpeg'},signal:AbortSignal.timeout(90000)});}
      catch{throw Error('Voice upload transport failed; capability URL suppressed; retry resumes saved receipts');}
      if(!response.ok)throw Error(`Voice upload failed (HTTP ${response.status}); capability URL suppressed`);
      try{receipt=await response.json();}catch{throw Error('Voice upload returned invalid receipt');}
      assert.equal(receipt.ok,true,'Voice upload was not acknowledged');
    }
    receipts.push(validateReceipt(receipt,asset));
    save(receiptFile,{jobId,runId:lease.runId,receipts});
    if(index%25===0||index===assets.length-1)console.log(JSON.stringify({stage:'upload',current:index+1,total:assets.length}));
  }
  assert.deepEqual(current(),before,'Catalog changed during upload; rerun safely before publication');
  const result=query("set request.jwt.claim.role='service_role'; select public.service_commit_voice_refresh("+
    [literal(jobId)+'::uuid',before.revision,literal(JSON.stringify(manifest))+'::jsonb',literal(JSON.stringify(receipts))+'::jsonb'].join(',')+') as result','commit-voice')[0].result;
  save(path.join(output,'voice-publication-result.json'),result);
  const after=current();save(path.join(output,'after-voice-publication.json'),after);
  assert.equal(result.videoId,videoId);assert.equal(result.revision,Number(before.revision)+1);
  assert.deepEqual(after,expectedSnapshot(before,videoId,jobId,result.voiceManifest),'Unexpected publication changes; inspect saved before/after snapshots');
  console.log(JSON.stringify({videoId,revision:after.revision,items:manifest.total,files:assets.length,verified:true}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(JSON.stringify({error:error.code||'VOICE_REFRESH_FAILED',message:error instanceof assert.AssertionError?'Voice data verification failed; inspect private prepared files':error.message}));process.exitCode=1;});
}
