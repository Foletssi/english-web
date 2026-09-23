import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const studioSource=readFileSync('admin/assets/studio-v2.js','utf8');
const rows=[
  {id:'failed',videoId:1,status:'ERROR',updatedAt:'1'},
  {id:'review-a',videoId:2,status:'REVIEW',updatedAt:'2'},
  {id:'review-b',videoId:3,status:'REVIEW',updatedAt:'3'}
];
const calls=[],succeeded=[];
let failFirst=true;
const window={ZoContent:{localOnly:false},location:{hash:'#/pipeline'},navigator:{onLine:true},
  EastudyAdminCloudBridge:{isAuthenticated:()=>true,refreshJobs:async()=>rows,
    refreshVideoContent:async(id,job)=>{
      calls.push([String(id),job?.id]);
      if(String(id)==='2'&&failFirst)throw new Error('R2_TEMPORARY_FAILURE');
      succeeded.push(String(id));return true;
    },refreshContent:async()=>{throw new Error('stale fallback must not be called')}},dispatchEvent(){}};
vm.runInNewContext(studioSource.replace("if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();",''),{
  window,document:{hidden:false,readyState:'complete',addEventListener(){},querySelector(){return null}},CustomEvent:class{},setTimeout:()=>0,clearTimeout});
await assert.rejects(window.EastudyStudioV2.syncJobs(),/R2_TEMPORARY_FAILURE/);
assert.deepEqual(calls.map(row=>row[0]),['2','3'],'ERROR never blocks later REVIEW reconciliation');
assert.deepEqual(succeeded,['3']);
failFirst=false;
await window.EastudyStudioV2.syncJobs();
assert.deepEqual(calls.map(row=>row[0]),['2','3','2'],'successful REVIEW is not redundantly rewritten');
await window.EastudyStudioV2.refreshJobs();
assert.deepEqual(calls.slice(-2).map(row=>row[0]),['2','3'],'manual refresh checks both R2 results');

const admin=readFileSync('admin/assets/admin.js','utf8');
const start=admin.indexOf('function processingResultIsAlreadySynchronized(');
const end=admin.indexOf('}async function refreshCloudJobs(',start)+1;
assert.ok(start>0&&end>start);
let fallbackReads=0,imports=0;
const context={user:{id:'admin'}};
const snapshot={videos:[{id:2,title:'待生成',status:'DRAFT',pipelineStatus:'WAITING'}],sentences:{2:[]}};
const box={Store:{localOnly:false,getVideo:()=>snapshot.videos[0],listSentences:()=>snapshot.sentences[2],
  snapshot:()=>snapshot,importSnapshot:()=>{imports++}},Cloud:{pullAdminProcessingResult:async()=>({error:new Error('R2_UNAVAILABLE')}),
  pullAdminVideoContent:async()=>{fallbackReads++;return {data:{video:snapshot.videos[0],sentences:[]}}}},
  AdminAuth:{context},CloudState:{jobs:[],revision:1},cloudSyncTimer:null,cloudSyncPromise:Promise.resolve(),
  contentEditGeneration:0,cloudImporting:false,window:{EastudyProcessingResult:{isUsable:()=>false},dispatchEvent(){}},
  updateCounts(){},CustomEvent:class{},Error};
vm.createContext(box);vm.runInContext(admin.slice(start,end),box);
await assert.rejects(box.refreshProcessingVideoContent(2,{id:'review-a',status:'REVIEW'}),/R2_UNAVAILABLE/);
assert.equal(fallbackReads,0,'stale draft must never be accepted after R2 failure');
box.Cloud.pullAdminProcessingResult=async()=>({data:{id:'review-a',status:'REVIEW',result:{sentences:[]}}});
await assert.rejects(box.refreshProcessingVideoContent(2,{id:'review-a',status:'REVIEW'}),/PROCESSING_RESULT_INCOMPLETE/);
assert.equal(imports,0);
console.log('PASS terminal ERROR isolation, retry, force R2 reconciliation, and missing R2 result cannot validate stale draft');