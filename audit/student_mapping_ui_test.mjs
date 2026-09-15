// Local real-DOM tests; all remote endpoints are intercepted, no production writes.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=process.env.EASTUDY_LOCAL_URL||'http://127.0.0.1:18763';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const failures=[];
try {
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===base)return route.continue();
  return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient(){return {}}};'});
 });
 await context.addInitScript(()=>{
  const snapshot={schemaVersion:3,creators:[{id:'c1',name:'真实博主',status:'ACTIVE'}],collections:[{id:'7001',title:'真实合集',status:'PUBLISHED',videoIds:[9001]}],videos:[{id:9001,title:'Real video',titleZh:'真实视频',status:'PUBLISHED',creatorId:'c1',collectionIds:['7001'],mediaUrl:'https://fixture.invalid/video.mp4',duration:30,level:'cet4',cover:'assets/images/video_cover_pending.svg'}],sentences:{9001:[{id:'s1',startTime:0,endTime:2,english:'Hello there.',chinese:'你好。',reviewStatus:'APPROVED'}]},jobs:[]};
  localStorage.setItem('zs:platform:content:local:v1',JSON.stringify(snapshot));
  for(const [key,value] of Object.entries({learningPlan:{track:'general',dailyMinutes:20,onboardingVersion:1},'collectionSaved:7001':true,'favSentences:9001':[0]}))localStorage.setItem('zs:user:student-fixture:'+key,JSON.stringify(value));
  snapshot.creators[0].bio='真实博主简介';
  snapshot.sentences[9001].push({id:'s2',startTime:10,endTime:12,english:'Good morning.',chinese:'早上好。',reviewStatus:'APPROVED'});
  localStorage.setItem('zs:platform:content:local:v1',JSON.stringify(snapshot));
  window.mappingFixture={fail:false,calls:0,hold:false,learningCalls:[]};
  const auth={available:true,getContext:async()=>({user:{id:'student-fixture'},profile:{role:'learner',nickname:'测试'}}),getRememberLogin:()=>false};
  const data={getLearningAccess:async()=>({access:{canEnterLearning:true,reason:'VIP_ACTIVE'},error:null}),startLearnerActivity:()=>()=>{},stopLearnerActivity(){},getMembership:async()=>({membership:null,error:null}),hydrateStudentLearning:async()=>({error:null}),pendingStudyEvents:()=>0,saveLearningPreferences:async()=>({error:null}),logStudyEvent:async()=>({error:null}),recordStudyActivity:async()=>({error:null}),setCollectionSave:async()=>{window.mappingFixture.calls++;return {error:window.mappingFixture.fail?new Error('NETWORK_FAILURE'):null}},setCreatorFollow:async()=>({error:null})};
  const saveCollection=data.setCollectionSave;
  data.setCollectionSave=async()=>{if(window.mappingFixture.hold)await new Promise(resolve=>window.mappingFixture.release=resolve);return saveCollection()};
  data.setCreatorFollow=async()=>{if(window.mappingFixture.hold)await new Promise(resolve=>window.mappingFixture.releaseFollow=resolve);window.mappingFixture.followCalls=(window.mappingFixture.followCalls||0)+1;return {error:window.mappingFixture.fail?new Error('NETWORK_FAILURE'):null}};
  const cloud={syncMediaSession:async()=>({}),clearMediaSession:async()=>({})};
  for(const method of ['setFavorite','setVocabulary'])data[method]=async input=>{
   window.mappingFixture.learningCalls.push({method,input});
   if(window.mappingFixture.hold)await new Promise(resolve=>window.mappingFixture.releaseLearning=resolve);
   return {error:window.mappingFixture.fail?new Error('NETWORK_FAILURE'):null};
  };
  data.upsertProgress=async()=>({error:null});
  for(const [name,value] of Object.entries({EastudyAuth:auth,EastudyData:data,EastudyCloudContent:cloud}))Object.defineProperty(window,name,{configurable:true,get:()=>value,set:()=>{}});
 });
 const page=await context.newPage(),errors=[];
 page.setDefaultTimeout(7000);
 page.on('pageerror',e=>errors.push(e.message));
 const check=async(name,run)=>{try{await run();console.log('PASS '+name)}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message)}};
 await page.goto(base+'/#/favorites');
 await page.waitForFunction(()=>document.documentElement.dataset.authState==='authenticated');
 const go=async route=>{await page.evaluate(route=>{location.hash='#'+route},route);await page.waitForFunction(route=>location.hash==='#'+route&&document.querySelector('.page.active'),route);};
 await check('favorite counts and saved collection route',async()=>{
  await go('/favorites');await page.locator('#favoritesPage.active').waitFor();
  assert.equal(await page.locator('[data-fav-tab=videos] b').innerText(),'1');
  assert.equal(await page.locator('[data-fav-tab=collections] b').innerText(),'1');
  await page.locator('[data-fav-tab=collections]').click();
  await page.locator('#favoritesContent [data-route="/compilation/7001"]').click({timeout:3000});
  await page.locator('#collectionPage.active').waitFor();
 });
 await check('learning metric routes are not overridden',async()=>{
  for(const [selector,expected] of [['.learning-mini-stat.mint','/vocabulary?state=mastered'],['.learning-mini-stat.amber','/learning?view=calendar'],['.learning-mini-stat.blue','/history?status=started']]){
   await go('/learning');await page.locator('#learningPage.active').waitFor();
   await page.locator(selector).click();
   assert.equal(await page.evaluate(()=>location.hash),'#'+expected);
  }
 });
 await check('cloud save failure keeps cache and UI unchanged, then retry',async()=>{
  await go('/compilation/7001');await page.locator('#collectionPage.active').waitFor();
  await page.evaluate(()=>window.mappingFixture.fail=true);
  await page.locator('#collectionSaveBtn').click();
  await page.waitForFunction(()=>window.mappingFixture.calls>0);
  assert.equal(await page.locator('#collectionSaveBtn span').innerText(),'已收藏');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:collectionSaved:7001'))),true);
  await page.evaluate(()=>window.mappingFixture.fail=false);
  await page.locator('#collectionSaveBtn').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:collectionSaved:7001'))===false);
  await go('/favorites');await page.locator('#favoritesPage.active').waitFor();
  assert.equal(await page.locator('[data-fav-tab=collections] b').innerText(),'0');
  await page.evaluate(()=>{localStorage.setItem('zs:user:student-fixture:collectionSaved:7001','true');window.dispatchEvent(new Event('eastudy:learning-hydrated'))});
  assert.equal(await page.locator('[data-fav-tab=collections] b').innerText(),'1');
 });
 await check('late save cannot enable an unavailable collection',async()=>{
  await go('/compilation/7001');await page.locator('#collectionPage.active').waitFor();
  await page.evaluate(()=>window.mappingFixture.hold=true);
  await page.locator('#collectionSaveBtn').click();
  await page.waitForFunction(()=>typeof window.mappingFixture.release==='function');
  await go('/compilation/missing');
  await page.waitForFunction(()=>document.querySelector('.collection-v2.is-unavailable'));
  const calls=await page.evaluate(()=>window.mappingFixture.calls);
  await page.evaluate(()=>{window.mappingFixture.hold=false;window.mappingFixture.release()});
  await page.waitForFunction(calls=>window.mappingFixture.calls>calls,calls);
  assert.equal(await page.locator('#collectionSaveBtn').isDisabled(),true);
  await go('/compilation/7001');
  await page.waitForFunction(()=>!document.querySelector('.collection-v2.is-unavailable'));
  assert.equal(await page.locator('#collectionSaveBtn').isDisabled(),false);
 });
 await check('creator follow is usable after leaving during a save',async()=>{
  await go('/creator/c1');await page.locator('#creatorDetailPage.active').waitFor();
  await page.evaluate(()=>window.mappingFixture.hold=true);
  await page.locator('#creatorFollowMain').click();
  await page.waitForFunction(()=>typeof window.mappingFixture.releaseFollow==='function');
  await go('/favorites');await page.locator('#favoritesPage.active').waitFor();
  await page.evaluate(()=>{window.mappingFixture.hold=false;window.mappingFixture.releaseFollow()});
  await page.waitForFunction(()=>localStorage.getItem('zs:user:student-fixture:follow:c1')==='true');
  await go('/creator/c1');await page.locator('#creatorDetailPage.active').waitFor();
  assert.equal(await page.locator('#creatorFollowMain').isDisabled(),false);
  assert.equal(await page.locator('#creatorFollowMain span').innerText(),'已关注');
 });
 await check('unavailable creator clears the previous creator and disables follow',async()=>{
  await go('/creator/c1');await page.locator('#creatorDetailPage.active').waitFor();
  assert.equal(await page.locator('.creator-profile-hero h1').innerText(),'真实博主');
  await go('/creator/missing');
  await page.waitForFunction(()=>document.querySelector('.creator-profile-hero h1').textContent==='创作者暂不可用');
  assert.equal(await page.locator('#creatorVideoGrid [data-video]').count(),0);
  assert.equal(await page.locator('#creatorFollowMain').isDisabled(),true);
  assert.equal(await page.locator('#creatorFollowMain').getAttribute('data-follow-key'),null);
  await go('/creator/c1');
  await page.waitForFunction(()=>document.querySelector('.creator-profile-hero h1').textContent==='真实博主');
  assert.equal(await page.locator('#creatorFollowMain').isDisabled(),false);
  assert.equal(await page.locator('#creatorVideoGrid [data-video]').count(),1);
 });
 await check('creator directory follow saves to cloud and does not fake success on failure',async()=>{
  await page.evaluate(()=>window.mappingFixture.fail=true);
  await go('/creators');await page.locator('#creatorsPage.active').waitFor();
  const button=page.locator('#creatorDirectory [data-follow="follow:c1"]');
  const calls=await page.evaluate(()=>window.mappingFixture.followCalls||0);
  await button.click();
  await page.waitForFunction(calls=>(window.mappingFixture.followCalls||0)>calls,calls);
  assert.equal(await button.innerText(),'已关注');
  assert.equal(await page.evaluate(()=>localStorage.getItem('zs:user:student-fixture:follow:c1')),'true');
  await page.evaluate(()=>window.mappingFixture.fail=false);
  await button.click();
  await page.waitForFunction(()=>localStorage.getItem('zs:user:student-fixture:follow:c1')==='false');
  assert.equal(await button.innerText(),'+ 关注');
  assert.equal(await page.evaluate(()=>location.hash),'#/creators');
 });
 await check('creator tabs expose their real content and support keyboard navigation',async()=>{
  await go('/creator/c1');await page.locator('#creatorDetailPage.active').waitFor();
  const tabs=page.locator('.profile-tabs');
  await tabs.locator('[data-creator-tab=collections]').click();
  assert.equal(await page.locator('#creatorVideoGrid [data-route="/compilation/7001"]').count(),1);
  await tabs.locator('[data-creator-tab=bio]').click();
  assert.match(await page.locator('#creatorVideoGrid').innerText(),/真实博主简介/);
  await tabs.locator('[data-creator-tab=bio]').press('Home');
  assert.equal(await tabs.locator('[data-creator-tab=videos]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#creatorVideoGrid [data-video]').count(),1);
 });
 await check('sentence save failure leaves state unchanged and allows retry',async()=>{
  await go('/video/9001');await page.locator('#videoPage.active').waitFor();
  // Mobile now keeps the transcript visible without a separate tab.
  await page.locator('#transcript').waitFor();
  await page.locator('#transcript .line[data-i="1"]').waitFor();
  await page.locator('#transcript .line[data-i="1"] .line-time').click();
  const button=page.locator('#transcript .line[data-i="1"] .favSentence');
  await page.evaluate(()=>window.mappingFixture.fail=true);await button.click();
  await page.waitForFunction(()=>!document.querySelector('.line[data-i="1"] .favSentence').disabled);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:favSentences:9001')).includes(1)),false);
  await page.evaluate(()=>window.mappingFixture.fail=false);await button.click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:favSentences:9001')).includes(1));
  assert.equal(await button.locator('.label').innerText(),'已收藏');
 });
 await check('word card saves the clicked sentence, not the current playback sentence',async()=>{
  await page.locator('#video').evaluate(video=>{video.currentTime=1;video.dispatchEvent(new Event('timeupdate'))});
  await page.locator('#transcript .line[data-i="1"] .word-token').first().click();
  assert.equal(await page.locator('#dictContext').innerText(),'Good morning.');
  await page.evaluate(()=>window.mappingFixture.fail=true);await page.locator('#saveWord').click();
  await page.waitForFunction(()=>!document.querySelector('#saveWord').disabled);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocab')||'[]').includes('good morning')),false);
  await page.evaluate(()=>window.mappingFixture.fail=false);await page.locator('#saveWord').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocab')||'[]').includes('good morning'));
  const input=await page.evaluate(()=>window.mappingFixture.learningCalls.filter(x=>x.method==='setVocabulary').at(-1).input);
  assert.equal(input.context,'Good morning.');assert.equal(input.sourceSentenceId,'s2');
  await page.locator('#dictClose').click();
 });
 await check('late word save does not overwrite a different open word card',async()=>{
  if(await page.locator('#dictClose').isVisible())await page.locator('#dictClose').click();
  await page.locator('#transcript .line[data-i="0"] .word-token').first().click();
  await page.evaluate(()=>window.mappingFixture.hold=true);await page.locator('#saveWord').click();
  await page.waitForFunction(()=>typeof window.mappingFixture.releaseLearning==='function');
  await page.locator('#dictClose').click();
  await page.locator('#transcript .line[data-i="0"] .word-token').nth(1).click();
  const word=await page.locator('#dictWord').innerText();
  await page.evaluate(()=>{window.mappingFixture.hold=false;window.mappingFixture.releaseLearning()});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocab')||'[]').includes('hello'));
  assert.equal(await page.locator('#dictWord').innerText(),word);
  assert.equal(await page.locator('#saveWord').isDisabled(),false);
  assert.equal(await page.locator('#saveWord').innerText(),'＋ 加入生词本');
  await page.locator('#dictClose').click();
 });
 await check('vocabulary mastery, deletion and review keep their state on cloud failure',async()=>{
  // Earlier metric navigation intentionally selects "mastered"; this scenario needs all words.
  await go('/vocabulary?state=all');await page.locator('#vocabularyPage.active').waitFor();
  await page.evaluate(()=>window.mappingFixture.fail=true);
  const master=page.locator('[data-master="good morning"]');await master.click();
  await page.waitForFunction(()=>!document.querySelector('[data-master="good morning"]').disabled);
  assert.notEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocabMeta'))['good morning'].state),'mastered');
  const remove=page.locator('[data-remove-word="good morning"]');await remove.click();
  await page.waitForFunction(()=>!document.querySelector('[data-remove-word="good morning"]').disabled);
  assert.equal(await remove.count(),1);
  await page.locator('[data-review-word="good morning"]').click();await page.locator('#vocabReviewReveal').click();
  const progress=await page.locator('#vocabReviewProgress').innerText();
  await page.locator('#vocabReviewKnown').click();
  await page.waitForFunction(()=>!document.querySelector('#vocabReviewKnown').disabled);
  assert.equal(await page.locator('#vocabReviewProgress').innerText(),progress);
  await page.evaluate(()=>window.mappingFixture.fail=false);await page.locator('#vocabReviewKnown').click();
  await page.waitForFunction(()=>document.querySelector('#vocabReviewProgress').textContent.startsWith('2 /'));
 });
 await check('saved sentence route seeks after metadata becomes available',async()=>{
  await go('/favorites');await page.locator('#favoritesPage.active').waitFor();
  await page.locator('[data-fav-tab=sentences]').click();
  // Hidden transcript DOM survives route changes; wait for the new media mount,
  // not a sentence left behind by the previous playback scenario.
  await page.locator('#transcript .line').evaluateAll(lines=>lines.forEach(line=>line.dataset.previousMount='true'));
  await page.locator('[data-sentence-video="9001"][data-sentence-go="1"]').click();
  await page.locator('#videoPage.active #transcript .line[data-i="1"]:not([data-previous-mount])').waitFor({state:'attached'});
  assert.equal(await page.evaluate(()=>location.hash),'#/video/9001?sentence=1');
  await page.locator('#video').evaluate(video=>{
   Object.defineProperty(video,'readyState',{configurable:true,get:()=>1});
   Object.defineProperty(video,'duration',{configurable:true,get:()=>30});
   video.dispatchEvent(new Event('loadedmetadata'));
  });
  assert.equal(await page.locator('#video').evaluate(video=>video.currentTime),10);
 });
 await check('collection entry preserves its queue and back destination',async()=>{
  await go('/compilation/7001');await page.locator('#collectionPage.active').waitFor();
  await page.locator('#collectionPage [data-video="9001"]').first().click();
  await page.waitForFunction(()=>document.querySelector('#videoPage .study-back')?.dataset.route==='/compilation/7001');
  const queue=await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:learningQueue')));
  assert.equal(queue.source,'collection');assert.equal(queue.collectionId,'7001');assert.deepEqual(queue.ids,['9001']);
  await page.locator('#videoPage .study-back').click();await page.waitForURL('**/#/compilation/7001');
 });
 assert.deepEqual(errors,[],'no uncaught browser errors');
 assert.deepEqual(failures,[]);
}finally{await browser.close()}
