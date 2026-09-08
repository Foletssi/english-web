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
const window={};
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
