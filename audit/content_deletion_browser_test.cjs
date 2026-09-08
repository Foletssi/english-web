// Isolated headless Chrome fixture. No real login, Supabase write, R2 write or AI request.
// Start local web server first; install Playwright or set NODE_PATH to its bundled directory.
const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const media=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24','-t','10','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{maxBuffer:4*1024*1024});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext(),errors=[],remoteRequests=[];
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(!['127.0.0.1','localhost'].includes(url.hostname)){remoteRequests.push(url.href);return route.abort()}
   if(url.pathname==='/shared/supabase-client.js')return route.fulfill({contentType:'text/javascript',body:
    "window.EastudyAuth={getContext:async(scope)=>scope==='admin'?{user:{id:'test-admin'},profile:{role:'admin'}}:{user:null,profile:null},client:()=>null,signOut:async()=>({})};"});
   if(url.port==='8788')return route.fulfill({contentType:'application/json',body:'{"jobs":[],"ok":true}'});
   if(url.pathname==='/fixture.mp4')return route.fulfill({contentType:'video/mp4',body:media});
   return route.continue();
  });
  const admin=await context.newPage();
  await admin.goto('http://127.0.0.1:8080/admin/#/videos');
  await admin.waitForSelector('#videoTableBody');
  assert.equal(await admin.locator('[data-row-video]').count(),0);
  // Load legacy data only in this disposable browser context, then let production load() migrate it.
  const legacy=JSON.parse(fs.readFileSync('audit/fixtures/legacy-content.json','utf8'));
  await admin.evaluate(input=>{localStorage.removeItem(ZoContent.KEY);localStorage.setItem('zs:platform:content:v1',JSON.stringify(input))},legacy);
  await admin.reload();await admin.waitForSelector('#videoTableBody');
  assert.equal(await admin.evaluate(()=>ZoContent.listTrash().length),9);
  assert.equal(await admin.locator('[data-row-video]').count(),0);
  await admin.locator('[data-goto="#/trash"]').click();
  await admin.waitForSelector('[data-restore-video="2805"]');
  await admin.locator('[data-restore-video="2805"]').click();
  assert.equal(await admin.evaluate(()=>ZoContent.getVideo(2805).status),'DRAFT');
  // Real non-seed fixture records to exercise selectable UI and cross-tab notification.
  await admin.evaluate(()=>{
   for(const id of [9001,9002]){ZoContent.saveVideo({id,title:'Deletion UI '+id,titleZh:'删除测试 '+id,creatorId:'creator-jojo',creator:'Fixture',status:'DRAFT',pipelineStatus:'READY',mediaUrl:'/fixture.mp4',duration:10,collectionIds:[],goalIds:['daily']});ZoContent.replaceSentences(id,[{id:id+'-1',startTime:0,endTime:1,english:'Hello.',chinese:'你好。',reviewStatus:'APPROVED'}]);ZoContent.setVideoStatus(id,'PUBLISHED')}
   location.hash='#/videos';
  });
  await admin.waitForSelector('[data-delete-video="9001"]');
  // Cancel must leave the record intact.
  admin.once('dialog',d=>d.dismiss());await admin.locator('[data-delete-video="9001"]').click();
  assert.ok(await admin.evaluate(()=>ZoContent.getVideo(9001)));
  const student=await context.newPage();await student.goto('http://127.0.0.1:8080/#/video/9001');
  await student.waitForFunction(()=>typeof State!=='undefined'&&State.currentVideo?.id===9001);
  await student.locator('#video').evaluate(async v=>{v.muted=true;await v.play()});
  assert.equal(await student.locator('#video').evaluate(v=>v.paused),false,'fixture really plays before removal');
  await admin.locator('[data-select-video="9001"]').check();await admin.locator('[data-select-video="9002"]').check();
  admin.once('dialog',d=>d.accept());await admin.locator('[data-delete-selected]').click();
  await student.waitForFunction(()=>document.getElementById('mediaState').dataset.kind==='removed');
  assert.equal(await student.locator('#video').evaluate(v=>v.paused&&!v.getAttribute('src')&&!v.querySelector('source')),true);
  assert.equal(await admin.evaluate(()=>ZoContent.getVideo(9001)),null);
  await admin.reload();await admin.waitForSelector('#videoTableBody');
  assert.equal(await admin.locator('[data-delete-video="9001"]').count(),0,'deleted record stays absent after reload');
  await student.evaluate(()=>{location.hash='#/home'});
  await student.waitForFunction(()=>document.getElementById('todayPrimaryAction').disabled);
  assert.equal(await student.locator('#priorityResumeCard').evaluate(el=>el.hidden),true);
  assert.equal(await student.locator('#videoCards [data-video]').count(),0);
  await student.setViewportSize({width:390,height:844});
  assert.equal(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile must not overflow');
  assert.deepEqual(errors,[],'no JavaScript runtime errors');
  assert.equal(remoteRequests.some(url=>/supabase.co\/rest|supabase.co\/auth/.test(url)),false,'no real account or content calls');
  console.log('Chrome fixture PASS: empty install, legacy cleanup, restore, cancel, bulk delete, cross-tab media stop, reload and mobile.');
  await context.close();
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
