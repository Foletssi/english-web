import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const calls=[];
const window={EastudyAuth:{client:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:[{revision:9,snapshot:{videos:[]}}]};}})}};
vm.runInNewContext(fs.readFileSync('shared/cloud-content.js','utf8'),{window,URL,Headers,AbortController,setTimeout,clearTimeout});
assert.equal(typeof window.EastudyCloudContent.setCreatorStatus,'function');
const result=await window.EastudyCloudContent.setCreatorStatus('alice','DELETED','bob',8);
assert.equal(result.data.revision,9);
assert.equal(JSON.stringify(calls[0]),JSON.stringify({name:'admin_set_creator_status_v1',args:{p_creator_id:'alice',p_status:'DELETED',p_replacement_id:'bob',p_expected_revision:8}}));
window.ZoContent={localOnly:true};
assert.ok((await window.EastudyCloudContent.setCreatorStatus('alice','ACTIVE',null,9)).error);
assert.equal(calls.length,1,'local mode must not write cloud data');

const app=fs.readFileSync('assets/js/app.js','utf8');
const catalogWindow={};
vm.runInNewContext(fs.readFileSync('shared/content-taxonomy.js','utf8'),{window:catalogWindow});
vm.runInNewContext(fs.readFileSync('shared/catalog-selectors.js','utf8'),{window:catalogWindow});
const catalog=catalogWindow.EastudyCatalog;
const plain=value=>JSON.parse(JSON.stringify(value));
const taxonomy=catalogWindow.EastudyTaxonomy;
const tracks=['gaokao','zsb','cet4','cet6','tem4','tem8','ielts','toefl'];
const graded=tracks.map(track=>({status:'PUBLISHED',difficulty:{schemaVersion:1,reviewStatus:'approved',primaryTrack:track,targetTracks:[track]}}));
assert.deepEqual(plain(taxonomy.availableTracks(graded)).map(([key])=>key),tracks);
assert.deepEqual(plain(taxonomy.availableTracks([
 {...graded[0],status:'DRAFT'}, {...graded[1],deletedAt:'2026-09-16'},
 {...graded[2],difficulty:{...graded[2].difficulty,reviewStatus:'review'}},
 graded[3],graded[3]
])),[['cet6','六级']],'only published, approved, undeleted difficulty appears, once');
const tagVideo={tagIds:['food-culture','daily-life','daily-life','conversation','friendship'],tagAssignments:[
 {tagId:'food-culture',reviewStatus:'APPROVED'}, {tagId:'daily-life',reviewStatus:'APPROVED'},
 {tagId:'conversation',approved:true}, {tagId:'friendship',reviewStatus:'REVIEW',approved:true}
]};
assert.deepEqual(plain(catalog.cardTags(tagVideo)),[
 {id:'food-culture',label:'美食',tone:'amber',role:'primary'},
 {id:'daily-life',label:'日常生活',tone:'blue',role:'secondary'},
 {id:'conversation',label:'真实对话',tone:'teal',role:'secondary'}
]);
assert.deepEqual(plain(catalog.tagIds({...tagVideo,tagAssignments:[]})),[],'explicit empty review cannot expose stale tag IDs');
assert.equal(catalog.tagIds(tagVideo).includes('friendship'),false,'explicit pending status overrides old approved boolean in every catalog consumer');
assert.deepEqual(plain(catalog.cardTags({tagIds:['unknown','daily-life']})).map(tag=>tag.id),['daily-life'],'legacy metadata stays truthful without fake filler');
assert.deepEqual(plain(catalog.cardTags({tagAssignments:[{tagId:'daily-life',reviewStatus:'REVIEW'}]})),[]);
assert.equal(catalog.cardTags({tagIds:['daily-life','food-culture','conversation','friendship']}).length,3);
const stored=new Map();
const contentStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value))};
Object.assign(catalogWindow,{location:{hostname:'english-web-lce.pages.dev',pathname:'/'},localStorage:contentStorage,dispatchEvent(){}});
vm.runInNewContext(fs.readFileSync('shared/content-store.js','utf8'),{window:catalogWindow,localStorage:contentStorage,CustomEvent:class {}});
catalogWindow.ZoContent.importSnapshot({videos:[
 {id:11,tagIds:['daily-life']},
 {id:12,tagIds:['daily-life'],tagAssignments:[]},
 {id:13,tagIds:['daily-life'],tagAssignments:null}
],sentences:{},creators:[],collections:[],jobs:[]});
assert.deepEqual(plain(catalog.tagIds(catalogWindow.ZoContent.getVideo(11))),['daily-life'],'legacy tags survive real cloud import and hydration');
for(const id of [12,13])assert.deepEqual(plain(catalog.tagIds(catalogWindow.ZoContent.getVideo(id))),[],'explicit empty or invalid review does not expose stale tags');
assert.equal(catalogWindow.EastudyCatalog.decodeRouteId('%E0%A4%A'),null,'malformed routes must not throw');
assert.equal(catalogWindow.EastudyCatalog.decodeRouteId('hello%20world'),'hello world');
const creatorContent=catalogWindow.EastudyCatalog.creatorContent([{id:1,creatorId:'a',status:'PUBLISHED',mediaUrl:'x',collectionIds:['7']},{id:2,creatorId:'a',status:'DRAFT',mediaUrl:'x',collectionIds:['8']}],[{id:7},{id:8}],'a');
assert.deepEqual(JSON.parse(JSON.stringify(creatorContent.collections)),[{id:7}]);
const sync=app.split('\n').find(line=>line.startsWith('function syncSessionUI()'));
let cleared=0;
const element={classList:{toggle(){}},hidden:false};
const box={StudentAuth:{phase:'anonymous'},window:{EastudyAvatars:{clear(){cleared++;}}},document:{documentElement:{dataset:{}},body:element},$:()=>element,isStudentProfile:()=>true};
vm.createContext(box);vm.runInContext(sync,box);
for(const phase of ['anonymous','checking','error']){box.StudentAuth.phase=phase;box.syncSessionUI();}
assert.equal(cleared,3,'all non-authenticated states must release private avatar resources');
box.StudentAuth={phase:'authenticated',access:{canEnterLearning:true},context:{user:{},profile:{}}};box.syncSessionUI();
assert.equal(cleared,3,'authorized rendering must preserve avatar resources');
assert.ok(!app.includes("${video.level||'A2'}"),'home priority cards must use the shared human-readable difficulty label');
console.log('Catalog mapping and student auth resource lifecycle passed.');

const admin=fs.readFileSync('admin/assets/admin.js','utf8');
const values=new Map();let writes=0;
const storage={getItem:key=>values.get(key)||null,setItem(key,value){writes++;values.set(key,String(value))}};
const storeBox={window:{location:{hostname:'english-web-lce.pages.dev',pathname:'/admin/'},localStorage:storage,sessionStorage:storage,dispatchEvent(){}},localStorage:storage,CustomEvent:class{}};
vm.runInNewContext(fs.readFileSync('shared/content-store.js','utf8'),storeBox);
const Store=storeBox.window.ZoContent;
Store.importSnapshot({videos:[],creators:[{id:'one',name:'Before'}],collections:[],sentences:{},jobs:[]});
const before=JSON.stringify(Store.snapshot()),beforeWrites=writes;
assert.equal(Store.prepareCreator({id:'one',name:'After'}).name,'After');
Store.prepareCollection({title:'Unsaved'});
assert.equal(writes,beforeWrites,'preparing an entity cannot write');
assert.equal(JSON.stringify(Store.snapshot()),before);
const persist=admin.slice(admin.indexOf('async function persistCatalogEntity('),admin.indexOf('function scheduleCloudDraftSync('));
let reply={data:{revision:null}};
const persistBox={Store,CloudState:{revision:8},Cloud:{publishEntity:async()=>reply},cloudImporting:false,flushCloudDraftSync:async()=>{},loadAdminCloud:async()=>{}};
vm.createContext(persistBox);vm.runInContext(persist,persistBox);
await assert.rejects(persistBox.persistCatalogEntity('creator',{id:'one',name:'Bad response'}),/CLOUD_CONTENT_RESPONSE_INVALID/);
reply={error:new Error('NETWORK_FAILURE')};
await assert.rejects(persistBox.persistCatalogEntity('creator',{id:'one',name:'Failed'}),/NETWORK_FAILURE/);
assert.equal(JSON.stringify(Store.snapshot()),before,'failed cloud writes cannot appear locally saved');
reply={data:{revision:9}};
await persistBox.persistCatalogEntity('creator',{id:'one',name:'Saved'});
assert.equal(Store.listCreators()[0].name,'Saved');
assert.equal(persistBox.CloudState.revision,9);
console.log('Catalog prepare, cloud failure and success contracts passed.');

Store.importSnapshot({videos:[{id:1,creatorId:7,creator:'Old name',status:'PUBLISHED',mediaUrl:'/video.m3u8'}],creators:[{id:'7',name:'New name',status:'ACTIVE'}],collections:[],sentences:{},jobs:[]});
const raw=JSON.stringify(Store.snapshot());
assert.equal(Store.listVideos({publishedOnly:true})[0].creator,'New name');
assert.equal(Store.getVideo('1').creator,'New name');
assert.equal(JSON.stringify(Store.snapshot()),raw,'read projection cannot mutate authoritative snapshot');

const syncFunctions=admin.slice(admin.indexOf('function cancelCloudDraftSync('),admin.indexOf('async function persistCatalogEntity('));
let saves=0,mutations=0;
const notices=[];
const retryBox={Store:{localOnly:false,snapshot:()=>({videos:[]})},AdminAuth:{context:{}},CloudState:{revision:4},cloudImporting:false,cloudSyncTimer:null,cloudSyncPromise:Promise.resolve(),clearTimeout,
 Cloud:{saveDraft:async()=>++saves===1?{error:new Error('NETWORK_FAILURE')}:{data:{revision:5}},setCreatorStatus:async()=>({data:{revision:6,snapshot:{videos:[]}}})},
 importCloudMutation:()=>{mutations++},refreshCloudTrash:async()=>{throw new Error('REFRESH_FAILED')},toast:message=>notices.push(message),loadAdminCloud:async()=>{}};
vm.createContext(retryBox);vm.runInContext(syncFunctions,retryBox);
await assert.rejects(retryBox.syncCloudDraftNow(),/NETWORK_FAILURE/);
await retryBox.flushCloudDraftSync();
assert.equal(saves,2,'a failed autosave must permit the next explicit save to retry');
assert.equal(retryBox.CloudState.revision,5);
await retryBox.persistCreatorStatus('one','DELETED','two');
assert.equal(mutations,1);
assert.equal(notices.length,1,'post-save refresh failure is a warning, not a failed mutation');
console.log('Creator name projection, autosave retry and post-save warning passed.');
