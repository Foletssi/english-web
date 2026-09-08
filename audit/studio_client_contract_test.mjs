import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FileFixture {constructor(name,size=1){this.name=name;this.size=size}}
class FormDataFixture {constructor(){this.rows=[]}append(...args){this.rows.push(args)}}
let sent;
class XhrFixture {
  constructor(){this.upload={};this.status=202;this.response={id:'job-1'}}
  open(method,url){this.method=method;this.url=url}
  send(body){sent={xhr:this,body};this.upload.onprogress?.({lengthComputable:true,loaded:1,total:2});this.onload()}
}
const window={location:{hostname:'localhost'}};
vm.runInNewContext(fs.readFileSync('shared/studio-client.js','utf8'),{window,fetch:()=>{},
  File:FileFixture,FormData:FormDataFixture,XMLHttpRequest:XhrFixture,console});
let progress=0;
const job=await window.EastudyStudioClient.createJob({video:new FileFixture('My Vlog.mp4'),
  metadata:{creator:'Alice'},onProgress:value=>progress=value});
assert.equal(job.id,'job-1');
assert.equal(sent.xhr.method,'POST');
assert.equal(sent.xhr.url,'http://127.0.0.1:8788/jobs');
assert.deepEqual(sent.body.rows.map(row=>row[0]),['metadata','aiConfig','video']);
assert.equal(progress,100);
console.log('Studio client contract: 5 checks passed.');

// A production tab must never read or submit jobs on the operator's computer.
const production={location:{hostname:'english-web-lce.pages.dev'}};
let localRequests=0;
vm.runInNewContext(fs.readFileSync('shared/studio-client.js','utf8'),{
  window:production,fetch:()=>{localRequests++;throw Error('UNEXPECTED_LOCAL_FETCH')},
  File:FileFixture,FormData:FormDataFixture,
  XMLHttpRequest:class {constructor(){localRequests++;throw Error('UNEXPECTED_LOCAL_UPLOAD')}}
});
const cloud=production.EastudyStudioClient;
assert.equal((await cloud.health()).ok,false);
for(const action of [()=>cloud.listJobs(),()=>cloud.getJob('job-1'),()=>cloud.retryJob('job-1'),()=>cloud.createJob({video:new FileFixture('v.mp4')})]){
  await assert.rejects(action,{code:'CLOUD_PROCESSING_NOT_CONFIGURED'});
}
assert.equal(localRequests,0);
console.log('Production studio boundary: all operations blocked before any localhost request.');
