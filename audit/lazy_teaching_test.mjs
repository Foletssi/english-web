import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const durable=new Map(),listeners={};let changes=0;
const window={location:{hostname:'example.test',pathname:'/'},__eastudyStudentId:'a',
 localStorage:{getItem:k=>durable.get(k),setItem:(k,v)=>durable.set(k,v),removeItem:k=>durable.delete(k)},
 addEventListener:(name,fn)=>listeners[name]=fn,dispatchEvent:()=>changes++};
vm.runInNewContext(read('../shared/content-store.js'),{window,CustomEvent:class{}});
const store=window.ZoContent,row={id:'s1',english:'Ready now.',chinese:'现在可以了。',textRevision:1,startTime:0,endTime:2,expressions:[]};
const catalog={videos:[{id:1,status:'PUBLISHED'}],sentences:{1:[row]}};
store.importSnapshot(catalog,{type:'cloud.import',revision:7});
const sentences=store.listSentences(1),detail={videoId:'1',revision:7,video:{...catalog.videos[0],voiceManifest:{status:'complete'}},sentences:sentences.map(row=>({...row,wordLookup:{tokens:[{tokenId:'t0',surface:'Ready'}]}}))};
const stored=durable.get(store.KEY),before=changes;
assert.equal(store.hydrateVideoTeaching(detail),true);
assert.equal(changes,before,'hydration must not reenter player through content-changed');
assert.equal(durable.get(store.KEY),stored,'full dictionaries never enter browser persistence');
assert.equal(store.getVideo(1).voiceManifest.status,'complete');
assert.equal(store.listSentences(1)[0].wordLookup.tokens[0].surface,'Ready');
assert.equal(store.listVideos()[0].voiceManifest,undefined);
assert.equal(store.snapshot().sentences[1][0].wordLookup,undefined);
assert.throws(()=>store.hydrateVideoTeaching({...detail,revision:8}),/CONTENT_REVISION_CONFLICT/);
assert.throws(()=>store.hydrateVideoTeaching({...detail,sentences:[{...detail.sentences[0],english:'Different.'}]}),/TEACHING_SOURCE_STALE/);
assert.throws(()=>store.hydrateVideoTeaching({...detail,videoId:'2'}),/VIDEO_NOT_FOUND/);
window.__eastudyStudentId='b';assert.equal(store.getVideo(1).voiceManifest,undefined);
store.hydrateVideoTeaching(detail);store.importSnapshot(catalog,{type:'cloud.import',revision:7});assert.equal(store.listSentences(1)[0].wordLookup,undefined);
store.hydrateVideoTeaching(detail);listeners.storage({key:store.KEY});assert.equal(store.getVideo(1).voiceManifest,undefined);

let owner='a',revision=7,denied=false,missing=false,hold,detailCalls=0;
const api={auth:{getSession:async()=>({data:{session:owner?{user:{id:owner}}:null}})},rpc:async(name,args)=>{
 if(hold)await new Promise(resolve=>hold=resolve);
 if(denied)return {error:Error('VIP_EXPIRED')};
 if(name==='get_published_catalog_if_changed_v2')return {data:[{snapshot:args.p_known_revision===revision?null:catalog,revision}]};
 assert.equal(name,'get_published_video_teaching_v1');detailCalls++;
 if(missing)return {error:Error('VIDEO_NOT_FOUND')};
 return {data:[{video:args.p_known_revision===revision?null:detail.video,sentences:args.p_known_revision===revision?null:detail.sentences,revision}]};
}};
window.EastudyAuth={client:()=>api};
vm.runInNewContext(read('../shared/cloud-content.js'),{window,setTimeout,clearTimeout,AbortController});
const cloud=window.EastudyCloudContent;
await cloud.pullPublished();
assert.equal((await cloud.pullVideoTeaching(1)).video.voiceManifest.status,'complete');
assert.equal((await cloud.pullVideoTeaching(1)).sentences.length,1);assert.equal(detailCalls,2,'cached details still check current server access');
assert.ok([...durable.values()].every(value=>!value.includes('voiceManifest')&&!value.includes('wordLookup')));
revision=8;assert.equal((await cloud.pullVideoTeaching(1)).error.message,'CONTENT_REVISION_CONFLICT');
await cloud.pullPublished();assert.equal((await cloud.pullVideoTeaching(1)).revision,8);
missing=true;assert.equal((await cloud.pullVideoTeaching(1)).error.message,'VIDEO_NOT_FOUND');missing=false;
denied=true;assert.equal((await cloud.pullVideoTeaching(1)).error.message,'VIP_EXPIRED');denied=false;
hold=true;const pending=cloud.pullVideoTeaching(1);await new Promise(resolve=>setTimeout(resolve,0));owner='b';hold();hold=null;
assert.equal((await pending).error.message,'ACCOUNT_CHANGED');
owner=null;assert.equal((await cloud.pullVideoTeaching(1)).error.message,'AUTH_REQUIRED');
console.log('Lazy teaching: source/revision/access/account isolation, memory-only overlay, no boot reentry passed.');

// Execute the application's real async hydration function with delayed replies.
const app=read('../assets/js/app.js');
const hydration=app.slice(app.indexOf('function loadPlayerTeaching('),app.indexOf('async function bootVideo('));
let resolveDetail,playerOwner='a',hydrated=0,renders=0,refreshes=0;
const state={mediaGeneration:1,route:'/video/1',teachingReady:false},data={sentences:[]};
const player={State:state,DATA:data,currentStudentStorageId:()=>playerOwner,activeVideoId:()=>state.route.split('/').at(-1),
 playerSentenceRows:rows=>rows,renderTranscript:()=>renders++,applyCurrent:()=>{},hydrateCloudContent:async()=>refreshes++,
 window:{EastudyCloudContent:{pullVideoTeaching:()=>new Promise(resolve=>resolveDetail=resolve)},ZoContent:{
  hydrateVideoTeaching:()=>hydrated++,listSentences:()=>detail.sentences,getVideo:()=>detail.video}}};
vm.createContext(player);vm.runInContext(hydration,player);
let load=vm.runInContext("loadPlayerTeaching('1',1,'a')",player);
state.mediaGeneration=2;state.route='/video/2';resolveDetail(detail);assert.equal(await load,false);
assert.equal(hydrated,0);assert.equal(renders,0,'late detail must not overwrite another video');
state.route='/video/1';load=vm.runInContext("loadPlayerTeaching('1',2,'a')",player);playerOwner='b';resolveDetail(detail);assert.equal(await load,false);assert.equal(hydrated,0);
playerOwner='a';load=vm.runInContext("loadPlayerTeaching('1',2,'a')",player);resolveDetail({error:Error('CONTENT_REVISION_CONFLICT')});assert.equal(await load,false);assert.equal(refreshes,1);
load=vm.runInContext("loadPlayerTeaching('1',2,'a')",player);resolveDetail(detail);assert.equal(await load,true);assert.equal(hydrated,1);assert.equal(state.teachingLoad,null);assert.equal(state.teachingReady,true);
console.log('Player delayed hydration: navigation, account switches, catalog refresh and retry passed.');
