import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl=process.env.EASTUDY_LOCAL_URL||'http://127.0.0.1:8080';
const batch={id:'11111111-1111-4111-8111-111111111111',label:'9月体验会员',channel:'线下课程',durationDays:30,codeCount:2,availableCount:1,usedCount:1,createdAt:'2026-09-11T06:00:00Z',disabledAt:null};
const available={id:'22222222-2222-4222-8222-222222222222',batchId:batch.id,code:'EAST-12345678-12345678-12345678-12345678',codeHint:'5678',label:batch.label,channel:batch.channel,durationDays:30,validUntil:'2026-10-11T06:00:00Z',createdAt:'2026-09-11T06:00:00Z',status:'available'};
const used={...available,id:'33333333-3333-4333-8333-333333333333',code:'EAST-87654321-87654321-87654321-87654321',codeHint:'4321',status:'used',redeemedBy:'44444444-4444-4444-8444-444444444444',redeemedPhone:'+8613888888888',redeemedNickname:'测试学员',redeemedAt:'2026-09-11T07:00:00Z',entitlementExpiresAt:'2026-10-11T07:00:00Z'};
const inventory={serverTime:'2026-09-11T08:00:00Z',page:1,pageSize:25,total:2,stats:{all:2,available:1,reserved:0,used:1,expired:0,revoked:0},batches:[batch],items:[available,used],audit:[{id:1,action:'BATCH_CREATED',actorName:'管理员',createdAt:'2026-09-11T06:00:00Z',details:{count:2}}]};

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const context=await browser.newContext({viewport:{width:1440,height:900}});
await context.route('**/assets/vendor/*.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:'window.supabase={createClient(){return {}}};'}));
await context.route('http://127.0.0.1:8788/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({jobs:[],ready:false})}));
await context.addInitScript(({inventory})=>{
  const auth={getContext:async()=>({user:{id:'admin-fixture'},profile:{role:'admin',nickname:'管理员'}}),signOut:async()=>({error:null}),signInPhone:async()=>({error:null})};
  const data={
    listInviteCodes:async()=>inventory,
    generateInviteCodes:async()=>({batchId:inventory.batches[0].id,codes:[{id:'new',code:'EAST-12345678-12345678-12345678-12345678',durationDays:30,validUntil:'2026-10-11T06:00:00Z'}],error:null}),
    revokeInviteCode:async()=>({status:'revoked'}),
    setInviteBatchDisabled:async()=>({status:'disabled'}),
    reissueInviteCode:async()=>({code:{id:'new',code:'EAST-87654321-87654321-87654321-87654321',durationDays:30,validUntil:'2026-10-11T06:00:00Z'}})
  };
  window.confirm=()=>true;window.prompt=()=>'';
  Object.defineProperty(window,'EastudyAuth',{configurable:true,get:()=>auth,set:()=>{}});
  Object.defineProperty(window,'EastudyData',{configurable:true,get:()=>data,set:()=>{}});
},{inventory});

const page=await context.newPage(),errors=[];
page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
page.on('pageerror',error=>errors.push(error.message));
await page.goto(`${baseUrl}/admin/#/invites`,{waitUntil:'networkidle'});
await page.getByRole('heading',{name:'邀请码管理'}).waitFor();
assert.equal(await page.locator('.invite-table tbody tr').count(),2);
assert.equal(await page.getByText('EAST-12345678-12345678-12345678-12345678').count(),1);
assert.equal(await page.locator('[data-invite-copy]').count(),2);
assert.equal(await page.getByText('测试学员').count(),1);
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);

await page.locator('#inviteCodeForm input[name="label"]').fill('浏览器测试批次');
await page.locator('#inviteCodeForm button[type="submit"]').click();
await page.getByText('本次生成的邀请码：1 个').waitFor();
assert.equal(await page.locator('#downloadInviteCodes').count(),1);
await page.screenshot({path:'tmp/local-invite-admin-desktop.png',fullPage:true});

await page.setViewportSize({width:375,height:812});
await page.reload({waitUntil:'networkidle'});
await page.getByRole('heading',{name:'邀请码管理'}).waitFor();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
assert.ok(await page.locator('#inviteSearch').evaluate(element=>element.getBoundingClientRect().height>=42));
await page.screenshot({path:'tmp/local-invite-admin-mobile.png',fullPage:true});

assert.deepEqual(errors,[]);
await browser.close();
console.log('Invite admin browser UI: desktop, generation result, mobile and clean console passed.');
