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
  snapshot.videos[0].difficulty={schemaVersion:1,reviewStatus:'approved',primaryTrack:'cet6',targetTracks:['cet6']};
  snapshot.videos[0].tagIds=['food-culture','daily-life','conversation'];
  snapshot.videos[0].tagAssignments=snapshot.videos[0].tagIds.map(tagId=>({tagId,reviewStatus:'APPROVED'}));
  snapshot.sentences[9001].push({id:'s2',startTime:10,endTime:12,english:'Good morning.',chinese:'早上好。',reviewStatus:'APPROVED'});
  localStorage.setItem('zs:platform:content:local:v1',JSON.stringify(snapshot));
  window.mappingFixture={fail:false,calls:0,hold:false,learningCalls:[]};
  const auth={available:true,getContext:async()=>({user:{id:'student-fixture'},profile:{role:'learner',nickname:'测试'}}),getRememberLogin:()=>false};
  const data={getLearningAccess:async()=>({access:{canEnterLearning:true,reason:'VIP_ACTIVE'},error:null}),startLearnerActivity:()=>()=>{},stopLearnerActivity(){},getMembership:async()=>({membership:null,error:null}),hydrateStudentLearning:async()=>({error:null}),pendingStudyEvents:()=>0,saveLearningPreferences:async()=>({error:null}),logStudyEvent:async()=>({error:null}),recordStudyActivity:async()=>({error:null}),setCollectionSave:async()=>{window.mappingFixture.calls++;return {error:window.mappingFixture.fail?new Error('NETWORK_FAILURE'):null}},setCreatorFollow:async()=>({error:null})};
  data.hydrateStudentLearning=async()=>{window.dispatchEvent(new CustomEvent('eastudy:learning-hydrated',{detail:{userId:'student-fixture',vocabularyLoaded:true}}));return {error:null}};
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
 await check('home cards show difficulty, one primary and two secondary tags across themes and widths',async()=>{
  await go('/home');await page.locator('#homePage.active').waitFor();
  for(const theme of ['light','dark'])for(const width of [320,360,390,430,1280]){
   await page.setViewportSize({width,height:844});
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const selector=(width<=850?'#mobileHomeCatalog':'#videoCards')+' .home-video-card';
   const card=page.locator(selector).first();
   await card.waitFor({state:'visible'});
   assert.equal(await card.locator('.video-difficulty').innerText(),'六级');
   assert.deepEqual(await card.locator('.video-tag').allTextContents(),['美食','日常生活','真实对话']);
   assert.equal(await card.locator('[data-tag-role=primary]').count(),1);
   assert.equal(await card.locator('[data-tag-role=secondary]').count(),2);
   const measurements=await page.evaluate(selector=>{
    const node=document.querySelector(selector);
    const box=node.getBoundingClientRect();
    const luminance=color=>{const channels=color.match(/[\d.]+/g);if(!channels)throw new Error('Unresolved computed color: '+JSON.stringify(color)+' connected='+node.isConnected);const rgb=channels.slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
    return [...node.querySelectorAll('.video-tag')].map(tag=>{const r=tag.getBoundingClientRect(),css=getComputedStyle(tag),a=luminance(css.color),b=luminance(css.backgroundColor);return {inside:box.width>0&&box.height>0&&r.width>0&&r.height>0&&r.left>=box.left&&r.right<=box.right+1,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}});
   },selector);
   assert.ok(measurements.every(row=>row.inside&&row.contrast>=4.5),JSON.stringify({theme,width,measurements}));
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.evaluate(()=>{const snapshot=window.ZoContent.snapshot();delete snapshot.videos[0].tagAssignments;window.ZoContent.importSnapshot(snapshot,{type:'fixture.import'})});
  assert.deepEqual(await page.locator('#mobileHomeCatalog .home-video-card').first().locator('.video-tag').allTextContents(),['美食','日常生活','真实对话'],'legacy tag IDs survive the complete student projection');
  await page.locator('#mobileHomeCatalog .home-video-card .video-tag').first().click();
  await page.waitForFunction(()=>location.hash.startsWith('#/video/9001'));
 });
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
  await page.locator('#transcript .line[data-i="1"] .line-zh').click();
  await page.locator('#openLessonMore').click();
  const button=page.locator('#savePinnedSentence');
  await page.evaluate(()=>window.mappingFixture.fail=true);await button.click();
  await page.waitForFunction(()=>!document.querySelector('#savePinnedSentence').disabled);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:favSentences:9001')).includes(1)),false);
  await page.evaluate(()=>window.mappingFixture.fail=false);await button.click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:favSentences:9001')).includes(1));
  assert.equal(await button.innerText(),'取消收藏此句');
  await page.locator('#lessonMore [data-close]').click();
 });
 await check('word card saves the clicked sentence, not the current playback sentence',async()=>{
  const countBefore=Number(await page.locator('#savedWordCount').innerText());
  assert.ok(Number.isFinite(countBefore),'cloud hydration makes count known');
  await page.locator('#video').evaluate(video=>{video.currentTime=1;video.dispatchEvent(new Event('timeupdate'))});
  await page.locator('#transcript .line[data-i="1"] .word-token').first().click();
  assert.equal(await page.locator('#dictContext').innerText(),'Good morning.');
  await page.evaluate(()=>window.mappingFixture.fail=true);await page.locator('#saveWord').click();
  await page.waitForFunction(()=>!document.querySelector('#saveWord').disabled);
  assert.equal(Number(await page.locator('#savedWordCount').innerText()),countBefore,'failed cloud save does not increase count');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocab')||'[]').includes('good')),false);
  await page.evaluate(()=>window.mappingFixture.fail=false);await page.locator('#saveWord').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocab')||'[]').includes('good'));
  const input=await page.evaluate(()=>window.mappingFixture.learningCalls.filter(x=>x.method==='setVocabulary').at(-1).input);
  assert.equal(input.context,'Good morning.');assert.equal(input.sourceSentenceId,'s2');
  assert.equal(Number(await page.locator('#savedWordCount').innerText()),countBefore+1,'successful cloud save updates dock count');
  await page.locator('#dictClose').click();
  await page.locator('#openSavedWords').click();
  await page.locator('#playerWordVideoOnly').check();
  assert.equal(await page.locator('#playerWordList button').innerText(),'good','current video filter uses saved cloud source');
  await page.locator('#playerWordList button').click();
  assert.ok(await page.locator('#dictClose').isVisible(),'list opens existing word card');
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
  const master=page.locator('[data-master="good"]');await master.click();
  await page.waitForFunction(()=>!document.querySelector('[data-master="good"]').disabled);
  assert.notEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('zs:user:student-fixture:vocabMeta'))['good'].state),'mastered');
  const remove=page.locator('[data-remove-word="good"]');await remove.click();
  await page.waitForFunction(()=>!document.querySelector('[data-remove-word="good"]').disabled);
  assert.equal(await remove.count(),1);
  await page.locator('[data-review-word="good"]').click();await page.locator('#vocabReviewReveal').click();
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
 await check('saved word list retains meaning and context from another video',async()=>{
  await go('/video/9001');await page.locator('#videoPage.active').waitFor();
  await page.evaluate(()=>{
   const prefix='zs:user:student-fixture:';
   localStorage.setItem(prefix+'vocab',JSON.stringify(['hello']));
   localStorage.setItem(prefix+'vocabDetails',JSON.stringify({hello:{meaning:'另一视频保存的释义',context:'Hello from another video.',sourceVideoId:'other-video',sourceSentenceId:'other-sentence'}}));
  });
  await page.locator('#openSavedWords').click();await page.locator('#playerWordVideoOnly').uncheck();
  await page.locator('#playerWordList button[data-word="hello"]').click();
  assert.equal(await page.locator('#dictMeaning').innerText(),'另一视频保存的释义');
  assert.equal(await page.locator('#dictContext').innerText(),'Hello from another video.');
  await page.locator('#saveWord').click();
  await page.waitForFunction(()=>!document.querySelector('#saveWord').disabled);
  const input=await page.evaluate(()=>window.mappingFixture.learningCalls.filter(x=>x.method==='setVocabulary').at(-1).input);
  assert.equal(input.sourceVideoId,'other-video');assert.equal(input.sourceSentenceId,'other-sentence');
  await page.locator('#dictClose').click();
 });
 await check('word count ignores stale hydration from another account',async()=>{
  await go('/video/9001');await page.locator('#videoPage.active').waitFor();
  await page.evaluate(()=>{window.__eastudyStudentId='second-fixture';window.dispatchEvent(new CustomEvent('eastudy:learning-hydrated',{detail:{userId:'second-fixture',vocabularyLoaded:false}}))});
  assert.equal(await page.locator('#savedWordCount').innerText(),'—');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eastudy:learning-hydrated',{detail:{userId:'student-fixture',vocabularyLoaded:true}})));
  assert.equal(await page.locator('#savedWordCount').innerText(),'—');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eastudy:learning-hydrated',{detail:{userId:'second-fixture',vocabularyLoaded:true}})));
  assert.equal(await page.locator('#savedWordCount').innerText(),'0','second account never inherits first account words');
 });
 assert.deepEqual(errors,[],'no uncaught browser errors');
 if(process.env.EASTUDY_VISUAL_DIR){
  const fs=await import('node:fs/promises'),out=process.env.EASTUDY_VISUAL_DIR;
  await fs.mkdir(out,{recursive:true});
  const measurements=[];
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   for(const [name,route] of [['home','/home'],['discovery','/collections'],['normal','/video/9001'],['blind','/video/9001'],['more','/video/9001'],['preferences','/video/9001']]){
    await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
    await go(route);await page.waitForTimeout(150);
    if(name==='blind')await page.locator('#dockBlind').click();
    if(name==='more'||name==='preferences')await page.locator('#openLessonMore').click();
    if(name==='preferences')await page.locator('#lessonMore #openSettings').click();
    await page.screenshot({path:out+'/'+theme+'-'+name+'.png'});
    measurements.push({theme,name,...await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>({id:d.id,width:d.getBoundingClientRect().width,height:d.getBoundingClientRect().height}))}))});
    assert.ok(measurements.at(-1).scrollWidth<=390,theme+' '+name+' must not overflow');
    if(name==='blind')await page.locator('#dockBlind').click();
   }
  }
  await fs.writeFile(out+'/measurements.json',JSON.stringify(measurements,null,2));
 }
 assert.deepEqual(failures,[]);
}finally{await browser.close()}
