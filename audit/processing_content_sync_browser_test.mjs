import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const admin=readFileSync('admin/assets/admin.js','utf8'),studio=readFileSync('admin/assets/studio-v2.js','utf8');
function declaration(name,multiline=false){const start=admin.indexOf(`function ${name}(`);assert.ok(start>=0);return admin.slice(start,multiline?admin.indexOf('\n}',start)+2:admin.indexOf('\n',start))}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
 await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="green"/></svg>'}));
 await page.setContent('<base href="https://fixture.test/admin/"><main id="view"></main>');
 await page.addScriptTag({content:`
 let content={videos:[{id:1,title:'Productive vlog',status:'REVIEW'},{id:2,title:'待生成',status:'DRAFT',duration:0}],sentences:{1:Array(419).fill({}),2:[]}};
 const jobs=[1,2].map(n=>({id:'00000000-0000-4000-8000-00000000000'+n,videoId:n,runId:'00000000-0000-4000-8000-000000000003',status:'REVIEW',updatedAt:'done',previewCover:'/api/processing/media/00000000-0000-4000-8000-00000000000'+n+'/cover-320.webp?previewRun=00000000-0000-4000-8000-000000000003'}));
 let failures=1;
 window.ZoContent={localOnly:false,listVideos:()=>content.videos,listSentences:id=>content.sentences[id]};
 window.EastudyAdminCloudBridge={refreshJobs:async()=>jobs,refreshContent:async()=>{
  if(failures-- >0)throw Error('first snapshot request failed');
  content={videos:[{id:1,title:'Productive vlog',status:'REVIEW',pipelineStatus:'READY',duration:1078},{id:2,title:'Busy day vlog',status:'REVIEW',pipelineStatus:'READY',duration:739}].map((v,n)=>({...v,processingJobId:jobs[n].id,cover:'/api/processing/media/'+jobs[n].id+'/cover.webp'})),sentences:{1:Array(419).fill({}),2:Array(119).fill({})}};return true;
 }};
 const Store=window.ZoContent,Taxonomy=null,allJobs=()=>jobs,icon=()=>'',deleteButton=()=>'',status=x=>x,pageHead=()=>'',view=html=>document.querySelector('#view').innerHTML=html;
 `});
 const declarations=['asset','escapeHtml','fmtDuration','videoRows','renderSubtitlePicker'].map(n=>declaration(n)).concat(['jobCoverImage','videoCoverImage'].map(n=>declaration(n,true)));
 await page.addScriptTag({content:declarations.join('\n')});
 // Disable automatic binding in this isolated fixture; call the actual public sync API.
 await page.addScriptTag({content:studio.replace("if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();",'')});
 await page.evaluate(()=>renderSubtitlePicker());assert.equal(await page.locator('tbody tr').count(),1);
 await page.evaluate(()=>window.EastudyStudioV2.syncJobs().catch(()=>{}));
 await page.evaluate(async()=>{await window.EastudyStudioV2.syncJobs();renderSubtitlePicker()});
 assert.equal(await page.locator('tbody tr').count(),2);
 assert.deepEqual(await page.locator('tbody tr td:nth-child(2)').allTextContents(),['419','119']);
 await page.waitForFunction(()=>[...document.querySelectorAll('img')].every(img=>img.complete&&img.naturalWidth>0));
 assert.equal(await page.locator('img[data-cover-preview]').count(),2);
 await page.evaluate(()=>{document.querySelector('#view').innerHTML='<table><tbody>'+videoRows(Store.listVideos())+'</tbody></table>'});
 assert.match(await page.locator('tbody').innerText(),/Busy day vlog/);
 assert.match(await page.locator('tbody').innerText(),/12:19/);
 assert.doesNotMatch(await page.locator('tbody').innerText(),/待生成/);
 console.log('PASS browser: stale one-row review recovers to two rows (419/119), correct title/duration and both authorized covers');
}finally{await browser.close()}
