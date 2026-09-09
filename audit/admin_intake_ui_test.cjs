// Disposable Chrome fixture. Network requests are fulfilled from repository files;
// authenticated state and cloud RPCs below are mocks, never production access.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const legacy=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/legacy-content.json'),'utf8'));
const snapshot={...legacy,videos:[{...legacy.videos[0],id:7001,title:'A week in my life — a long video title to verify table layout '.repeat(5),mediaUrl:'/fixture.mp4'}],jobs:[]};
const authFixture=`window.EastudyAuth={getContext:async()=>({user:{id:'fixture-admin'},profile:{role:'admin'}}),signOut:async()=>({}),client:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture'}}})},rpc:async name=>({error:null,data:name==='admin_get_content_snapshot'?[{snapshot:${JSON.stringify(snapshot)},revision:1}]:[]})})};`;
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  for(const mode of ['cloud','local']){
   const context=await browser.newContext();const errors=[],localRequests=[];
   let healthReady=false;
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.port==='8788'){localRequests.push(url.pathname);return route.fulfill({status:healthReady?200:503,contentType:'application/json',body:JSON.stringify(healthReady?{ok:true,jobs:[]}:{error:{message:'Fixture offline'}})})}
    if(!['eastudy.test','localhost'].includes(url.hostname))return route.fulfill({contentType:'text/javascript',body:''});
    if(url.pathname==='/shared/supabase-client.js')return route.fulfill({contentType:'text/javascript',body:authFixture});
    if(url.pathname==='/api/session')return route.fulfill({contentType:'application/json',body:'{}'});
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
    assert.ok(file.startsWith(root+path.sep));
    return route.fulfill(fs.existsSync(file)?{contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)}:{status:404,body:''});
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`${mode==='cloud'?'https://eastudy.test':'http://localhost'}/admin/#/videos`);
   await page.waitForSelector('#videoTableBody');
   if(mode==='cloud'){
    await page.waitForSelector('[data-row-video="7001"]');
    for(const theme of ['light','dark'])for(const width of [320,768,1024,1440,1920]){
     await page.setViewportSize({width,height:900});
     await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
     // Responsive sidebar transitions temporarily overlay the table after resize.
     // Assert its final position instead of testing through that animation.
     await page.waitForFunction(()=>innerWidth>840||document.querySelector('#sidebar').getBoundingClientRect().right<=1);
     const scroller=page.locator('.video-table-scroll');
     for(const edge of ['start','end']){
      await scroller.evaluate((el,value)=>{el.scrollLeft=value==='end'?el.scrollWidth:0},edge);
      const layout=await page.locator('.video-table .row-actions').evaluate(el=>{
       const wrap=el.closest('.video-table-scroll').getBoundingClientRect();
       return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,wrap:{left:wrap.left,right:wrap.right},buttons:[...el.children].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,target:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML?.slice(0,180),hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})};
      });
      if(layout.scrollWidth>width)console.log(await page.evaluate(()=>[...document.querySelectorAll('.topbar,.top-actions,.breadcrumbs,.search-btn,.view,.page-head,.toolbar,.video-table-scroll')].map(el=>({class:el.className,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}))));
      assert.equal(layout.scrollWidth<=width,true,`${theme}/${width}: page overflow`);
      assert.equal(layout.buttons.length,4);
      for(const b of layout.buttons){assert.ok(b.left>=layout.wrap.left&&b.right<=layout.wrap.right&&b.right<=width,`${theme}/${width}/${edge}: action clipped`);assert.ok(b.width>=35&&b.hit,`${theme}/${width}: action unreachable ${JSON.stringify(b)}`)}
     }
    }
    await page.locator('[data-edit-video="7001"]').click();await page.waitForSelector('#videoModal.show');
    await page.locator('[data-close="videoModal"]').first().click();
   }
   await page.setViewportSize({width:1024,height:900});
   await page.locator('#studioV2Creator').evaluate(el=>el.value='null');
   await page.locator('#newVideoTop').click();
   await page.waitForSelector('#studioV2Modal.show');
   assert.equal(await page.locator('#studioV2Creator').inputValue(),'');
   if(mode==='cloud'){
    await page.waitForSelector('#studioV2Health[data-state="unavailable"]');
    assert.ok(await page.locator('#studioV2Submit').isEnabled());
    assert.equal(localRequests.length,0,'cloud UI must not poll localhost');
    assert.equal((await page.locator('#studioV2Modal').innerText()).includes('START_EASTUDY'),false);
    await page.locator('#studioV2Creator').fill('Alice');
    await page.locator('#studioV2Videos').setInputFiles({name:'a week in my life.mp4',mimeType:'video/mp4',buffer:Buffer.from('fixture')});
    await page.locator('#studioV2Form').evaluate(form=>form.requestSubmit());
    assert.equal(localRequests.length,0);
    assert.equal(await page.evaluate(()=>ZoContent.listVideos().length),1,'failed cloud upload must not create video records');
    for(const width of [320,768,1024,1440,1920]){
     await page.setViewportSize({width,height:900});
     const modal=page.locator('.studio-v2-modal');
     const dimensions=await modal.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
     assert.ok(dimensions.scrollWidth<=dimensions.width,`intake/${width}: modal overflow ${JSON.stringify(dimensions)}`);
     const close=page.locator('#studioV2Form [data-close="studioV2Modal"]');
     await close.scrollIntoViewIfNeeded();
     assert.ok(await close.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),`intake/${width}: footer unreachable`);
    }
    await page.setViewportSize({width:1024,height:900});
    await page.locator('.studio-v2-modal').evaluate(el=>el.scrollTop=0);
   }else{
    await page.waitForSelector('#studioV2Health[data-state="error"]');
    assert.ok(await page.locator('#studioV2Submit').isDisabled());
    healthReady=true;await page.locator('#studioV2Recheck').click();
    await page.waitForSelector('#studioV2Health[data-state="ok"]');
    assert.ok(await page.locator('#studioV2Submit').isEnabled());
   }
   assert.deepEqual(errors,[]);
   if(mode==='cloud'&&process.env.EASTUDY_UI_EVIDENCE){
    fs.mkdirSync(process.env.EASTUDY_UI_EVIDENCE,{recursive:true});
    await page.screenshot({path:path.join(process.env.EASTUDY_UI_EVIDENCE,'cloud-intake.png')});
    await page.locator('[data-close="studioV2Modal"]').first().click();
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:path.join(process.env.EASTUDY_UI_EVIDENCE,'video-actions.png')});
   }
   await context.close();
  }
  console.log('Admin UI PASS: 5 widths × 2 themes × 2 scroll edges, clickable actions, cloud makes zero localhost requests, local reconnect works.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
