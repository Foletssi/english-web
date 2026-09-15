// Real DOM interactions, served locally with every cloud operation mocked.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const local=process.env.EASTUDY_LOCAL_URL||'http://127.0.0.1:18763';
const origin='https://english-web-lce.pages.dev';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin&&!url.pathname.startsWith('/api/')){
   const response=await context.request.get(local+url.pathname+url.search);
   return route.fulfill({response});
  }
  if(url.pathname.includes('/assets/vendor/'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient(){return {}}};'});
  return route.fulfill({contentType:'application/json',body:'{"jobs":[],"ready":false}'});
 });
 await context.addInitScript(()=>{
  const fixture={revision:10,failSave:true,failTrashRefresh:false,calls:[],publishedVideos:[{id:202,creatorId:'public-only'}],snapshot:{videos:[{id:202,creatorId:'draft-owner',status:'DRAFT'}],sentences:{},jobs:[],collections:[],creators:[{id:7,name:'Original',status:'ACTIVE'},{id:'next',name:'Replacement',status:'ACTIVE'},{id:'public-only',name:'Published owner',status:'ACTIVE'},{id:'draft-owner',name:'Draft owner',status:'ACTIVE'}]}};
  window.catalogFixture=fixture;
  const auth={getContext:async()=>({user:{id:'admin-test'},profile:{role:'admin'}})};
  const cloud={syncMediaSession:async()=>({}),pullAdmin:async()=>({revision:fixture.revision,snapshot:fixture.snapshot}),
   saveDraft:async()=>({data:{revision:++fixture.revision}}),
   publishEntity:async(kind,entity,revision)=>{
    fixture.calls.push({kind,entity,revision});
    if(fixture.failSave)return {error:new Error('NETWORK_FAILURE')};
    const key=kind==='creator'?'creators':'collections';
    fixture.snapshot[key]=[...fixture.snapshot[key].filter(row=>String(row.id)!==String(entity.id)),entity];
    return {data:{revision:++fixture.revision}};
   },
   setCreatorStatus:async(id,status,replacementId,revision)=>{
    fixture.calls.push({kind:'status',id,status,replacementId,revision});
    if(status==='DELETED'){
     const linked=[...fixture.snapshot.videos,...fixture.publishedVideos].some(video=>String(video.creatorId)===String(id));
     if(linked&&!replacementId)return {error:new Error('CREATOR_REPLACEMENT_REQUIRED')};
     fixture.snapshot.videos=fixture.snapshot.videos.map(video=>String(video.creatorId)===String(id)?{...video,creatorId:replacementId}:video);
     fixture.publishedVideos=fixture.publishedVideos.map(video=>String(video.creatorId)===String(id)?{...video,creatorId:replacementId}:video);
    }
    fixture.snapshot.creators=fixture.snapshot.creators.map(row=>String(row.id)===String(id)?{...row,status}:row);
    return {data:{revision:++fixture.revision,snapshot:fixture.snapshot}};
   },
   listTrash:async()=>fixture.failTrashRefresh?{error:new Error('REFRESH_FAILED')}:{rows:[{video_id:101,video:{id:101,creatorId:7},deleted_at:new Date().toISOString()}]},
   listProcessingJobs:async()=>({rows:[],groups:[],total:0}),processingHealth:async()=>({data:{}})};
  for(const [name,value] of Object.entries({EastudyAuth:auth,EastudyCloudContent:cloud}))Object.defineProperty(window,name,{configurable:true,get:()=>value,set:()=>{}});
 });
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/admin/#/creators');
 await page.locator('[data-edit-creator="7"]').click();
 assert.equal(await page.locator('#creatorForm [name=name]').inputValue(),'Original','numeric creator IDs must open the correct entity');
 await page.locator('#creatorForm [name=name]').fill('Renamed');
 await page.locator('#creatorForm button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#creatorFormMessage').textContent.includes('保存失败'));
 assert.equal(await page.locator('#creatorModal').evaluate(el=>el.classList.contains('show')),true);
 assert.equal(await page.evaluate(()=>window.ZoContent.listCreators().find(row=>String(row.id)==='7').name),'Original');
 await page.evaluate(()=>window.catalogFixture.failSave=false);
 await page.locator('#creatorForm button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#creatorModal').classList.contains('show'));
 assert.equal(await page.evaluate(()=>window.ZoContent.listCreators().find(row=>String(row.id)==='7').name),'Renamed');
 await page.locator('[data-delete-creator="7"]').click();
 assert.equal(await page.locator('#creatorReplacementField').isVisible(),true,'trash-only video still requires a replacement');
 assert.equal(await page.locator('#creatorDeleteForm [name=replacementCreatorId]').inputValue(),'','known links must also require an explicit choice');
 assert.equal(await page.locator('#creatorDeleteForm [name=replacementCreatorId]').evaluate(el=>el.required),true);
 await page.locator('#creatorDeleteForm [name=replacementCreatorId]').selectOption('next');
 await page.evaluate(()=>window.catalogFixture.failTrashRefresh=true);
 await page.locator('#creatorDeleteForm button[type=submit]').click();
 await page.locator('[data-restore-creator="7"]').waitFor();
 assert.equal(await page.locator('#creatorDeleteModal').evaluate(el=>el.classList.contains('show')),false,'refresh failure cannot turn a successful delete into a failed delete');
 await page.locator('[data-restore-creator="7"]').click();
 await page.locator('[data-edit-creator="7"]').waitFor();
 assert.equal(await page.evaluate(()=>window.catalogFixture.calls.filter(x=>x.kind==='status').map(x=>x.status).join(',')),'DELETED,ACTIVE');
 // The admin snapshot only has drafts; the server must also protect published-only links.
 await page.locator('[data-delete-creator="public-only"]').click();
 assert.equal(await page.locator('#creatorReplacementField').isVisible(),true,'published-only links must still allow an explicit replacement');
 assert.equal(await page.locator('#creatorDeleteForm [name=replacementCreatorId]').inputValue(),'','deletion must not silently choose the first creator');
 await page.locator('#creatorDeleteForm button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#creatorDeleteMessage').textContent.includes('请选择接替创作者'));
 assert.equal(await page.locator('#creatorDeleteModal').evaluate(el=>el.classList.contains('show')),true,'server-required replacement must leave deletion retryable');
 assert.equal(await page.evaluate(()=>window.catalogFixture.calls.at(-1).replacementId),null,'an unselected replacement must reach the server as null');
 assert.equal(await page.evaluate(()=>window.catalogFixture.publishedVideos[0].creatorId),'public-only','failed deletion must preserve published ownership');
 assert.equal(await page.evaluate(()=>window.catalogFixture.snapshot.videos[0].creatorId),'draft-owner','failed deletion must preserve the unrelated draft ownership');
 await page.locator('#creatorDeleteForm [name=replacementCreatorId]').selectOption('next');
 await page.locator('#creatorDeleteForm button[type=submit]').click();
 await page.locator('[data-restore-creator="public-only"]').waitFor();
 assert.equal(await page.evaluate(()=>window.catalogFixture.publishedVideos[0].creatorId),'next','published ownership changes only to the explicitly selected creator');
 assert.equal(await page.evaluate(()=>window.catalogFixture.snapshot.videos[0].creatorId),'draft-owner');
 await page.evaluate(()=>location.hash='#/collections');
 await page.locator('[data-action=new-collection]').click();
 await page.locator('#collectionForm [name=title]').fill('Draft collection');
 await page.locator('#collectionForm button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#collectionModal').classList.contains('show'));
 assert.ok((await page.locator('body').innerText()).includes('已保存为草稿，学生端不展示'));
 assert.equal(await page.evaluate(()=>window.ZoContent.listCollections()[0].status),'DRAFT');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log('Catalog admin browser: edit, failed save, retry, trash replacement, explicit published-only replacement, restore, draft visibility and mobile width passed.');
} finally {await browser.close();}
