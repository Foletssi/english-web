// Field-only publication of separately reviewed teaching; official CLI, no credentials in logs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
if(!args.includes('--cli')||!args.includes('--input'))throw Error('Required: --cli PATH --input DIRECTORY [--apply]');
const cli=option('--cli'),dir=path.resolve(option('--input'));
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const save=(name,data)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(data,null,2));
const source=read('source.json'),patches=read('approved-patches.json'),videoId=String(source.video.id);
const context={window:{}};vm.runInNewContext(fs.readFileSync('shared/learning-contract.js','utf8'),context);
assert.equal(patches.length,source.sentences.length);
const merged=source.sentences.map((row,i)=>{
 const patch=patches[i];assert.equal(patch.id,row.id);
 assert.deepEqual(Object.keys(patch).sort(),['expressions','id','keyWords','teachingAnalysis']);
 const next={...row,...patch},issues=context.window.EastudyLearningContract.sentenceIssues(next,{forPublish:true});
 if(issues.length)throw Error(JSON.stringify(issues));return next;
});
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
function query(sql,name){
 const file=path.join(dir,name+'.sql');fs.writeFileSync(file,sql);
 try{return JSON.parse(execFileSync(cli,['db','query','--linked','--file',file,'--output','json'],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,timeout:120000,stdio:['ignore','pipe','pipe']})).rows;}
 catch{throw Error('Official database operation failed ('+name+'); SQL and private data suppressed');}
}
function current(){return query("select revision,published,draft from private.content_snapshots where environment='production'",'read-current')[0];}
const before=current(),pub=before.published.sentences[videoId],draft=before.draft.sentences[videoId];
assert.deepEqual(pub,source.sentences,'Published transcript changed');
assert.deepEqual(draft,source.draftSentences,'Draft transcript changed');
assert.equal(before.published.videos.find(v=>String(v.id)===videoId)?.processingJobId,source.video.processingJobId);
save('before-publication.json',before);
const count=patches.reduce((n,p)=>n+p.expressions.length,0);
if(args.includes('--apply')){
 const sql="set request.jwt.claim.role='service_role'; select public.service_commit_reviewed_teaching("+
 [literal(videoId),literal(source.video.processingJobId)+'::uuid',before.revision,...[pub,draft,patches].map(v=>literal(JSON.stringify(v))+'::jsonb')].join(',')+") as result;";
 const result=query(sql,'commit-reviewed')[0].result;save('publication-result.json',result);
 const after=current();save('after-publication.json',after);
 const expected=structuredClone(before);
 expected.published.sentences[videoId]=merged;
 const byId=new Map(patches.map(p=>[p.id,p]));
 expected.draft.sentences[videoId]=draft.map(s=>({...s,...byId.get(s.id)}));
 assert.deepEqual(after.published,expected.published,'Unexpected published field change');
 assert.deepEqual(after.draft,expected.draft,'Unexpected draft field change');
 assert.equal(after.revision,before.revision+1);
 console.log(JSON.stringify({videoId,revision:after.revision,sentences:merged.length,expressions:count,verified:true}));
}else console.log(JSON.stringify({videoId,revision:before.revision,sentences:merged.length,expressions:count,dryRun:true}));
