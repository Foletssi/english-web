import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('admin/assets/studio-v2.js','utf8');
let rows=[{id:'a',videoId:1,status:'REVIEW',runId:'run-a',updatedAt:'1'},
 {id:'b',videoId:2,status:'REVIEW',runId:'run-b',updatedAt:'2'}];
let imports=0,fail=true,defer=false,content={videos:[{id:1,status:'REVIEW'},{id:2,status:'DRAFT'}]};
const remote={videos:[{id:1,status:'REVIEW'},{id:2,status:'REVIEW'}],sentences:{1:[1,2],2:[3]}};
const window={ZoContent:{localOnly:false},location:{hash:'#/videos'},navigator:{onLine:true},
 EastudyAdminCloudBridge:{isAuthenticated:()=>true,refreshJobs:async()=>rows,refreshContent:async()=>{
  imports++;if(fail)throw Error('temporary read failure');if(defer)return false;content=structuredClone(remote);return true;
 }},dispatchEvent(){}};
vm.runInNewContext(source.replace('global.EastudyStudioV2={','global.__test={cloudPollVisible};global.EastudyStudioV2={'),{
 window,document:{hidden:false,readyState:'loading',addEventListener(){}},CustomEvent:class{},setTimeout:()=>0,clearTimeout});
const studio=window.EastudyStudioV2;
await assert.rejects(studio.syncJobs(),/temporary/);
assert.equal(content.videos[1].status,'DRAFT');
fail=false;await studio.syncJobs();
assert.equal(imports,2,'retry snapshot even though both jobs were already terminal at first observation');
assert.equal(content.videos.filter(v=>v.status==='REVIEW').length,2);
assert.equal(content.sentences[2].length,1);
await studio.syncJobs();assert.equal(imports,2,'no full snapshot request every idle poll');
await studio.refreshJobs();assert.equal(imports,3,'manual refresh reconciles content as well as task status');
rows[1]={...rows[1],updatedAt:'3'};defer=true;await studio.syncJobs();defer=false;await studio.syncJobs();
assert.equal(imports,5,'deferred import remains eligible on next poll');
for(const path of ['/videos','/subtitles','/pipeline','/videos/2']){
 window.location.hash='#'+path;assert.equal(window.__test.cloudPollVisible(),true,path);
}
window.location.hash='#/subtitles/2';assert.equal(window.__test.cloudPollVisible(),false,'do not redraw unsaved subtitle editor');

const admin=readFileSync('admin/assets/admin.js','utf8');
const start=admin.indexOf('async function refreshProcessingContent('),end=admin.indexOf('\nasync function refreshCloudJobs(',start);
let pulls=0,resolvePull,imported=[];
const context={user:{id:'admin'}},box={Store:{localOnly:false,importSnapshot:(data,event)=>imported.push({data,event})},
 Cloud:{pullAdmin:()=>{pulls++;return new Promise(resolve=>resolvePull=resolve)}},AdminAuth:{context},
 CloudState:{revision:122},cloudSyncTimer:null,cloudSyncPromise:Promise.resolve(),cloudImporting:false,
 processingContentRequest:null,contentEditGeneration:0,updateCounts(){},window:{dispatchEvent(){}},CustomEvent:class{},Error};
vm.createContext(box);vm.runInContext(admin.slice(start,end),box);
const flush=async()=>{await Promise.resolve();await Promise.resolve()};
box.cloudSyncTimer=1;assert.equal(await box.refreshProcessingContent(),false);assert.equal(pulls,0);
box.cloudSyncTimer=null;
let pending=box.refreshProcessingContent();let same=box.refreshProcessingContent();await flush();assert.equal(pulls,1);
box.contentEditGeneration++;resolvePull({snapshot:remote,revision:123});
assert.equal(await pending,false);assert.equal(await same,false);assert.equal(imported.length,0,'edit during fetch prevents overwrite');
pending=box.refreshProcessingContent();await flush();resolvePull({snapshot:remote,revision:123});
assert.equal(await pending,true);assert.equal(imported.length,1);assert.equal(box.CloudState.revision,123);
pending=box.refreshProcessingContent();await flush();resolvePull({snapshot:{},revision:122});assert.equal(await pending,false);
pending=box.refreshProcessingContent();await flush();box.AdminAuth.context=null;resolvePull({snapshot:remote,revision:124});
assert.equal(await pending,false,'logout invalidates inflight import');assert.equal(imported.length,1);
box.AdminAuth.context=context;
pending=box.refreshProcessingContent();await flush();resolvePull({error:Error('offline')});await assert.rejects(pending,/offline/);
assert.equal(box.processingContentRequest,null,'failed request does not poison next retry');

for(const name of ['videoRows','renderSubtitlePicker']){
 const line=admin.split('\n').find(line=>line.startsWith('function '+name+'('));
 assert.ok(line.includes('videoCoverImage(v)'),name+' uses authorized cover preview');
}
console.log('PASS terminal completion snapshot retry, manual refresh, both review rows, visible routes, edit/auth guards and cover wiring');
