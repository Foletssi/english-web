import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const source=readFileSync('admin/assets/admin.js','utf8');
const start=source.indexOf('function replaceViewContent('),end=source.indexOf('function view(',start);
assert.ok(start>=0&&end>start);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext();let requests=0;
 await context.route('https://cover.test/**',route=>{
  requests++;return route.fulfill({headers:{'Cache-Control':'private, no-store'},contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'});
 });
 const page=await context.newPage();await page.setContent('<main id="view"></main>');
 await page.addScriptTag({content:'const AdminAuth={context:{user:{id:"fixture"}}};'+source.slice(start,end)+`
 window.draw=(run='first')=>replaceViewContent(document.querySelector('#view'),'<img src="https://cover.test/'+run+'" data-cover-preview="https://cover.test/'+run+'" data-cover-fallback="fallback">');
 window.bind=()=>{const img=document.querySelector('img');img.__eastudyCoverContext=AdminAuth.context;window.previous=img};
 window.changeAccount=()=>{AdminAuth.context={user:{id:'different'}}};
 `});
 await page.evaluate(()=>window.draw());await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);await page.evaluate(()=>window.bind());
 for(let i=0;i<5;i++)await page.evaluate(()=>window.draw());
 assert.equal(await page.evaluate(()=>window.previous===document.querySelector('img')),true);
 assert.equal(requests,1,'repeated renders must retain the loaded node without another authorization request');
 await page.evaluate(()=>window.draw('new-run'));await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);assert.equal(requests,2);
 await page.evaluate(()=>{window.bind();window.changeAccount();window.draw('new-run')});
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);assert.equal(requests,3,'account changes must not reuse the previous account cover');
 assert.equal(await page.evaluate(()=>window.previous===document.querySelector('img')),false);
 console.log('PASS browser: cover retained across five redraws; new run/account starts a fresh authorized request.');
}finally{await browser.close()}
