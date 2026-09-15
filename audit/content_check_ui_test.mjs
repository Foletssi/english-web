import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<main id="view"></main>');
 for(const path of ['shared/learning-contract.js','shared/content-audit.js','admin/assets/content-check.js'])await page.addScriptTag({path});
 await page.evaluate(()=>{
  const snapshot={videos:[],creators:[{id:1}],sentences:{}};
  for(let id=1;id<=10;id++){
   snapshot.videos.push({id,titleZh:id===1?'<img src=x onerror=alert(1)>':'视频'+id,title:'Video',creatorId:1,status:'DRAFT'});
   snapshot.sentences[id]=Array.from({length:110},(_,i)=>({id:`${id}-${i}`,english:'We put off the task',chinese:'我们推迟任务',startTime:i*3,endTime:i*3+3,
    keyWords:['put off'],expressions:[{surface:'put off',coreMeaningZh:'推迟',contextMeaningZh:'推迟任务',reviewStatus:'APPROVED'}],grammar:'短语',reviewStatus:'APPROVED'}));
  }
  const fixture=window.fixture={snapshot,revision:12,reads:0,writes:0,repairs:[],fail:false,conflict:false};
  window.controller=EastudyContentCheck.create({
   cloud:{pullAdmin:async()=>{fixture.reads++;return fixture.fail?{error:Error('连接失败')}:{snapshot:structuredClone(snapshot),revision:fixture.revision}},
    listProcessingJobs:async()=>({summary:{failed:2}})},
   store:{localOnly:false,save(){fixture.writes++;throw Error('read must not write')}},
   show:html=>document.querySelector('#view').innerHTML=html,active:()=>true,
   repair:async(id,mode,revision)=>{fixture.repairs.push({id,mode,revision});if(fixture.conflict)throw Error('内容已更新，请重新检查')},
   failureText:error=>error.message});
  controller.open();
 });
 await page.locator('.audit-video').first().waitFor();
 assert.equal(await page.locator('.audit-video').count(),8);
 assert.equal(await page.locator('.audit-issue').count(),0);
 assert.equal(await page.locator('.audit-video img').count(),0,'titles must never render as HTML');
 await page.locator('[data-content-details="1"]').click();
 assert.equal(await page.locator('.audit-issue').count(),20,'3300 diagnoses are paginated');
 assert.ok((await page.locator('.audit-details').innerText()).includes('put off 缺少正确的表达类型'));
 assert.equal(await page.locator('.audit-issue').first().locator('a').getAttribute('href'),'#/subtitles/1?sentence=1-0');
 assert.equal(await page.locator('.audit-issue details[open]').count(),0);
 await page.locator('[data-detail-page="2"]').click();
 assert.equal(await page.locator('.audit-issue').count(),20);
 await page.locator('[data-content-page="2"]').click();
 assert.equal(await page.locator('.audit-video').count(),2);
 await page.evaluate(()=>fixture.fail=true);
 await page.locator('[data-content-refresh]').click();
 await page.getByRole('status').filter({hasText:'未取得最新数据'}).waitFor();
 assert.equal(await page.locator('.audit-video').count(),2,'failed refresh retains previous results');
 assert.equal(await page.evaluate(()=>fixture.writes),0);assert.equal(await page.evaluate(()=>fixture.repairs.length),0);
 await page.evaluate(()=>{fixture.fail=false;fixture.revision=13;fixture.conflict=true});
 await page.locator('[data-content-refresh]').click();
 await page.getByRole('status').filter({hasText:'内容版本 13'}).waitFor();
 await page.locator('[data-content-repair="9"][data-mode="fill_missing"]').click();
 await page.getByRole('alert').filter({hasText:'重新检查'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>fixture.repairs[0]),{id:'9',mode:'fill_missing',revision:13});
 page.once('dialog',dialog=>dialog.dismiss());
 await page.locator('[data-content-repair="9"][data-mode="reextract"]').click();
 assert.equal(await page.evaluate(()=>fixture.repairs.length),1,'cancelled reselection cannot create work');
 await page.evaluate(()=>fixture.conflict=false);
 page.once('dialog',dialog=>dialog.accept());
 await page.locator('[data-content-repair="9"][data-mode="reextract"]').click();
 await page.waitForFunction(()=>location.hash==='#/pipeline');
 assert.equal(await page.evaluate(()=>fixture.repairs[1].mode),'reextract');
 await page.evaluate(()=>{
  document.querySelector('#view').innerHTML=EastudyContentCheck.tabs('/learners');
 });
 await page.getByRole('link',{name:'邀请码',exact:true}).click();
 assert.equal(await page.evaluate(()=>location.hash),'#/invites');
 assert.deepEqual(errors,[]);
 console.log('Content check DOM: read-only refresh, failures, pagination, escaping, source revision, two repair modes and invite navigation passed.');
}finally{await browser.close()}
