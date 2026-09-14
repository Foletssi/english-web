import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window={},cache=new Map();
vm.runInNewContext(fs.readFileSync(new URL('../shared/personal-library.js',import.meta.url),'utf8'),{window});
let user='a',calls=0,resolve;
const input={key:'collectionSaved:7',active:true,getUserId:()=>user,cache:{set:(k,v)=>cache.set(k,v)},data:{setCollectionSave:async(id,on,uid)=>{calls++;assert.equal(uid,'a');return {error:new Error('offline')}}}};
assert.ok((await window.EastudyPersonalLibrary.saveToggle(input)).error);
assert.equal(cache.size,0,'failed writes never change cache');
input.data.setCollectionSave=async()=>({error:null});
assert.equal((await window.EastudyPersonalLibrary.saveToggle(input)).error,null);
assert.equal(cache.get(input.key),true);
input.active=false;
input.data.setCollectionSave=()=>new Promise(r=>{resolve=r});
const pending=window.EastudyPersonalLibrary.saveToggle(input);
assert.equal(window.EastudyPersonalLibrary.isPending(input.key,'a'),true);
assert.equal(window.EastudyPersonalLibrary.isPending(input.key,'b'),false);
assert.equal((await window.EastudyPersonalLibrary.saveToggle(input)).error.code,'SAVE_PENDING');
user='b';resolve({error:null});
assert.equal((await pending).error.code,'ACCOUNT_CHANGED');
assert.equal(window.EastudyPersonalLibrary.isPending(input.key,'a'),false);
assert.equal(cache.get(input.key),true,'old request must not populate another account');
user='signed-out';assert.ok((await window.EastudyPersonalLibrary.saveToggle(input)).error);
user='a';assert.ok((await window.EastudyPersonalLibrary.saveToggle({...input,data:{}})).error);
const selected=window.EastudyPersonalLibrary.selectFavorites({videos:[{id:1},{id:2}],collections:[{id:7},{id:8}],sentences:[{video:{id:1}},{video:{id:'1'}}],getSaved:k=>k==='collectionSaved:7'});
assert.deepEqual(JSON.parse(JSON.stringify(selected.counts)),{videos:1,collections:1,sentences:2});

let identity='a',writes=0;
const api={auth:{getSession:async()=>({data:{session:identity?{user:{id:identity}}:null}})},from:table=>table==='profiles'?{select(){return this},eq(){return this},maybeSingle:async()=>({data:{role:'learner'},error:null})}:{upsert:async row=>{writes++;return {data:row,error:null}}}};
const storage={getItem:()=>null,setItem(){},removeItem(){}};
const authWindow={EASTUDY_SUPABASE_CONFIG:{url:'https://fixture.supabase.co',publishableKey:'fixture'},supabase:{createClient:()=>api},addEventListener(){}};
vm.runInNewContext(fs.readFileSync(new URL('../shared/supabase-client.js',import.meta.url),'utf8'),{window:authWindow,document:{addEventListener(){}},localStorage:storage,sessionStorage:storage,console});
for(const method of ['setCreatorFollow','setCollectionSave']){
 identity=null;assert.ok((await authWindow.EastudyData[method]('7',true,'a')).error);
 identity='b';assert.ok((await authWindow.EastudyData[method]('7',true,'a')).error);
 identity='a';assert.equal((await authWindow.EastudyData[method]('7',true,'a')).error,null);
}
assert.equal(writes,2,'anonymous or stale identity never writes');
for(const method of ['setFavorite','setVocabulary']){
 const payload={active:true,videoId:1,sentenceIndex:0,wordKey:'hello',word:'Hello',expectedUserId:'a'};
 identity=null;assert.ok((await authWindow.EastudyData[method](payload)).error,'anonymous '+method+' must fail closed');
 identity='b';assert.ok((await authWindow.EastudyData[method](payload)).error,'stale '+method+' must fail closed');
 identity='a';assert.equal((await authWindow.EastudyData[method](payload)).error,null);
}
assert.equal(writes,4);
let committed=0,finish;
const transaction={key:'vocab:hello',getUserId:()=>user,save:async uid=>{assert.equal(uid,'a');return {error:new Error('offline')}},commit:()=>committed++};
assert.ok((await window.EastudyPersonalLibrary.saveMutation(transaction)).error);
assert.equal(committed,0);
transaction.save=()=>new Promise(resolve=>finish=resolve);
const saving=window.EastudyPersonalLibrary.saveMutation(transaction);
assert.equal((await window.EastudyPersonalLibrary.saveMutation(transaction)).error.code,'SAVE_PENDING');
user='b';finish({error:null});assert.equal((await saving).error.code,'ACCOUNT_CHANGED');
assert.equal(committed,0);
user='a';transaction.save=async()=>({error:null});
assert.equal((await window.EastudyPersonalLibrary.saveMutation(transaction)).error,null);
assert.equal(committed,1);
console.log('Personal library: failed save, retry, duplicate, account switch, selection and API identity checks passed.');
const lib=window.EastudyPersonalLibrary,local=new Map(),saved=[];
const localCache={get:(key,fallback)=>local.has(key)?local.get(key):fallback,set:(key,value)=>local.set(key,value)};
const vocabInput={word:'Hello',key:'hello',active:true,getUserId:()=>user,cache:localCache,data:{setVocabulary:async input=>{saved.push(input);return {error:null}}}};
local.set('vocab',['Hello']);local.set('vocabMeta',{hello:{state:'new',addedAt:'invalid-date'}});
local.set('vocabDetails',{hello:{meaning:'你好',context:'Original context',contentVersion:3}});
assert.equal((await lib.saveVocabulary({...vocabInput,details:{context:'Different context'}})).error,null);
assert.equal(saved.at(-1).addedAt,null);
assert.equal(saved.at(-1).context,'Original context');
assert.equal(saved.at(-1).contentVersion,3);
assert.equal((await lib.saveVocabulary({...vocabInput,active:false})).error,null);
assert.equal(local.get('vocab').length,0,'remove canonical and legacy display-case words');
assert.deepEqual(Object.keys(local.get('vocabDetails')),[]);
const completions=[];
const sentenceInput={videoId:1,sentence:{id:'s',en:'Hello'},getUserId:()=>user,cache:localCache,data:{setFavorite:()=>new Promise(resolve=>completions.push(resolve))}};
const first=lib.saveSentence({...sentenceInput,index:0}),second=lib.saveSentence({...sentenceInput,index:1});
completions[1]({error:null});await second;completions[0]({error:null});await first;
assert.deepEqual([...local.get('favSentences:1')].sort(),[0,1],'parallel sentence saves merge latest cache');
const failed=await lib.saveSentence({...sentenceInput,index:0,data:{setFavorite:async()=>({error:new Error('offline')})}});
assert.ok(failed.error);assert.equal(local.get('favSentences:1').length,2);
console.log('Personal library date, legacy-key removal, original context and concurrent sentence tests passed.');

// Restore real API rows, then persist a review without losing the original source.
const hydrated=new Map();
const persisted={getItem:key=>hydrated.get(key)||null,setItem:(key,value)=>hydrated.set(key,value),removeItem:key=>hydrated.delete(key),key:index=>[...hydrated.keys()][index],get length(){return hydrated.size}};
const rows=[{word_key:'hello',word:'Hello',state:'learning',context:'Original sentence',content_version:'published-v2',source_video_id:9001,source_sentence_id:'s1'}];
const hydrateApi={auth:api.auth,rpc:async()=>({data:null,error:null}),from(table){
 const result={data:table==='profiles'?{role:'learner'}:table==='user_vocabulary'?rows:[],error:null};
 return {select(){return this},eq(){return this},order(){return this},limit(){return this},maybeSingle:async()=>result,then(resolve,reject){return Promise.resolve(result).then(resolve,reject)}};
}};
const hydrateWindow={...authWindow,supabase:{createClient:()=>hydrateApi},dispatchEvent(){}};
vm.runInNewContext(fs.readFileSync(new URL('../shared/supabase-client.js',import.meta.url),'utf8'),{window:hydrateWindow,document:{addEventListener(){}},localStorage:persisted,sessionStorage:persisted,CustomEvent:class{},console});
await hydrateWindow.EastudyData.hydrateStudentLearning();
const restoredDetails=JSON.parse(hydrated.get('zs:user:a:vocabDetails'));
assert.equal(restoredDetails.hello.contentVersion,'published-v2');
assert.equal(restoredDetails.hello.context,'Original sentence');
assert.deepEqual(JSON.parse(hydrated.get('zs:user:a:vocab')),['hello']);
console.log('Cloud vocabulary hydration preserves canonical key, context and content version.');
