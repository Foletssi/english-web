import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync('admin/assets/studio-v2.js','utf8');
let serial=0,reads=0,healthReads=0,active=0,authenticated=true,fail=false,release;
const timers=new Map(),events=new Map();
const document={hidden:false,readyState:'loading',addEventListener(){}};
const window={ZoContent:{localOnly:false},location:{hash:'#/pipeline'},navigator:{onLine:true},
 EastudyAdminCloudBridge:{isAuthenticated:()=>authenticated,processingSummary:()=>({active}),
  refreshJobs:async()=>{reads++;if(fail)throw Error('offline');if(release===true)await new Promise(resolve=>{release=resolve});return []}},
 EastudyCloudContent:{processingHealth:async()=>{healthReads++;return {data:{ready:true}}}},
 dispatchEvent(){},addEventListener:(name,fn)=>events.set(name,fn)};
vm.runInNewContext(code.replace('global.EastudyStudioV2={','global.__pollTest={state,wakeCloudPoll,runCloudPoll};global.EastudyStudioV2={'),{
 window,document,CustomEvent:class{},setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial},clearTimeout:id=>timers.delete(id)});
const {state,wakeCloudPoll,runCloudPoll}=window.__pollTest;
const next=()=>{assert.equal(timers.size,1);return [...timers.values()][0].ms};
async function tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.fn()}
wakeCloudPoll();assert.equal(next(),0);await tick();assert.equal(next(),60000);assert.equal(reads,1);
active=1;await tick();assert.equal(next(),5000,'global active count includes jobs on other pages');
for(const mode of ['hidden','offline','settings','signed-out']){
 document.hidden=mode==='hidden';window.navigator.onLine=mode!=='offline';window.location.hash=mode==='settings'?'#/settings':'#/pipeline';authenticated=mode!=='signed-out';
 const before=reads;wakeCloudPoll();assert.equal(timers.size,0);await runCloudPoll();assert.equal(reads,before,mode+' must stop automatic requests');
 document.hidden=false;window.navigator.onLine=true;window.location.hash='#/pipeline';authenticated=true;
 wakeCloudPoll();assert.equal(next(),0);await tick();assert.equal(next(),5000);
}
release=true;const pending=tick();await Promise.resolve();const before=reads;
wakeCloudPoll();await tick();assert.equal(reads,before,'wake during an in-flight request must not duplicate it');
document.hidden=true;release();await pending;release=null;assert.equal(timers.size,0,'a response arriving after hide must not restart polling');
document.hidden=false;wakeCloudPoll();fail=true;await tick();assert.ok(next()>=5000&&next()<5500);
await tick();assert.ok(next()>=10000&&next()<10500);
fail=false;active=0;await tick();assert.equal(next(),60000);assert.equal(state.cloudFailures,0);assert.equal(reads,healthReads);
console.log('PASS polling: global activity, idle delay, hidden/offline/routes/logout, re-entry, in-flight wake, backoff.');
