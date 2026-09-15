const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const fixture=JSON.parse(fs.readFileSync('audit/fixtures/legacy-content.json','utf8'));
const first=fixture.videos[0];
const snapshot={...fixture,videos:[{...first,id:7001,title:'Cloud deletion fixture',mediaUrl:'/fixture.mp4'}],sentences:{'7001':fixture.sentences['2805']},jobs:[],trash:[],tombstones:{}};
const fakeClient=`
(()=>{let snapshot=${JSON.stringify(snapshot)},revision=8,trash=[];window.__rpcCalls=[];
 const ok=data=>Promise.resolve({data,error:null}),api={auth:{getSession:()=>ok({session:{access_token:'fixture-token'}})},rpc(name,args={}){window.__rpcCalls.push({name,args});
  if(name==='admin_get_content_snapshot')return ok([{snapshot,revision,updated_at:new Date().toISOString()}]);
  if(name==='admin_list_processing_jobs')return ok([]);
  if(name==='admin_list_content_trash')return ok(trash.map(x=>({video_id:String(x.video.id),video:x.video,deleted_at:x.deletedAt,reason:'admin-delete'})));
  if(name==='admin_save_content_snapshot_v2'){if(args.p_expected_revision!==revision)return Promise.resolve({data:null,error:{message:'CONTENT_REVISION_CONFLICT'}});snapshot=args.p_snapshot;revision++;return ok([{revision,updated_at:new Date().toISOString()}])}
  if(name==='admin_publish_content_snapshot'){snapshot=args.p_snapshot;revision++;return ok([{revision,published_at:new Date().toISOString()}])}
  if(name==='admin_trash_content_videos'){if(args.p_expected_revision!==revision)return Promise.resolve({data:null,error:{message:'CONTENT_REVISION_CONFLICT'}});for(const id of args.p_video_ids){const video=snapshot.videos.find(v=>String(v.id)===id);trash.unshift({video,deletedAt:new Date().toISOString()});snapshot.videos=snapshot.videos.filter(v=>String(v.id)!==id);delete snapshot.sentences[id]}revision++;return ok([{snapshot,revision,updated_at:new Date().toISOString()}])}
  if(name==='admin_restore_content_video'){if(args.p_expected_revision!==revision)return Promise.resolve({data:null,error:{message:'CONTENT_REVISION_CONFLICT'}});const row=trash.find(x=>String(x.video.id)===args.p_video_id);row.video={...row.video,status:'DRAFT',publishedAt:null};snapshot.videos.unshift(row.video);trash=trash.filter(x=>x!==row);revision++;return ok([{snapshot,revision,updated_at:new Date().toISOString()}])}
  return Promise.resolve({data:null,error:{message:'UNEXPECTED_RPC:'+name}})
 }};
 window.EastudyAuth={client:()=>api,getContext:async scope=>scope==='admin'?{user:{id:'fixture-admin'},profile:{role:'admin'}}:{user:null,profile:null},signOut:async()=>({})};
})();`;
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const context=await browser.newContext(),errors=[];
 await context.route('**/*',async route=>{const url=new URL(route.request().url());
  if(url.pathname.includes('/assets/vendor/'))return route.fulfill({contentType:'text/javascript',body:''});
  if(url.hostname!=='eastudy.test')return route.abort();
  if(url.pathname==='/shared/supabase-client.js')return route.fulfill({contentType:'text/javascript',body:fakeClient});
  if(url.pathname==='/api/session')return route.fulfill({contentType:'application/json',body:'{}'});
  const upstream=await fetch('http://127.0.0.1:8080'+url.pathname);return route.fulfill({status:upstream.status,contentType:upstream.headers.get('content-type')||undefined,body:Buffer.from(await upstream.arrayBuffer())});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://eastudy.test/admin/#/videos');await page.waitForSelector('[data-delete-video="7001"]');
 assert.equal(await page.evaluate(()=>ZoContent.localOnly),false);assert.equal(await page.locator('[data-select-video="7001"]').count(),1);
 await page.evaluate(()=>ZoContent.saveVideo({...ZoContent.getVideo(7001),title:'Edited immediately before delete'}));
 page.once('dialog',dialog=>dialog.accept());await page.locator('[data-delete-video="7001"]').click();await page.waitForFunction(()=>!ZoContent.getVideo(7001));
 await page.locator('[data-goto="#/trash"]').click();await page.waitForSelector('[data-restore-video="7001"]');
 await page.locator('[data-restore-video="7001"]').click();await page.waitForFunction(()=>ZoContent.getVideo(7001)?.status==='DRAFT');
 const calls=await page.evaluate(()=>__rpcCalls);assert.deepEqual(calls.filter(x=>x.name.includes('content_video')).map(x=>x.name),['admin_trash_content_videos','admin_restore_content_video']);
 assert.equal(calls.filter(x=>x.name==='admin_save_content_snapshot_v2').length,1,'pending draft save must flush before delete');
 assert.equal(calls.find(x=>x.name==='admin_trash_content_videos').args.p_expected_revision,9);
 assert.deepEqual(calls.filter(x=>x.name==='admin_trash_content_videos')[0].args.p_video_ids,['7001']);
 assert.equal(await page.evaluate(()=>ZoContent.getVideo(7001).title),'Edited immediately before delete');assert.deepEqual(errors,[]);
 console.log('Cloud Chrome fixture PASS: online delete UI, revisioned RPC, trash list and draft restore.');
 await context.close();
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
