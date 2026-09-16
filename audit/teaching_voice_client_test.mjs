import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context={window:{},setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync('shared/teaching-voice.js','utf8'),context);
const api=context.window.EastudyTeachingVoice;
const fingerprint='a'.repeat(64), job='00000000-0000-4000-8000-000000000001';
const token={tokenId:'t0',surface:'read'},phrase={expressionId:'e0',surface:'read into'};
const sentence={id:'s1',textRevision:2,english:'read into',wordLookup:{sourceEnglish:'read into',sourceTextRevision:2,tokens:[token]},expressions:[phrase]};
const source={sourceVideoId:'v1',sourceSentenceId:'s1',sourceTextRevision:2,sourceTokenId:'t0'};
const item={status:'ready',kind:'token',tokenId:'t0',videoId:'v1',sentenceId:'s1',sourceTextRevision:2,contentRevision:'r1',text:'read',fingerprint,url:`/api/processing/media/${job}/voice/${fingerprint}.mp3`};
const video={id:'v1',voiceManifest:{status:'complete',videoId:'v1',contentRevision:'r1',items:[item]}};
assert.equal(api.select(video,sentence,source,'read'),item);
for(const patch of [{sourceVideoId:'v2'},{sourceSentenceId:'s2'},{sourceTextRevision:1},{sourceTokenId:'t1'}])assert.equal(api.select(video,sentence,{...source,...patch},'read'),null);
for(const patch of [{url:'https://evil.test/audio.mp3'},{text:'wind'},{contentRevision:'old'},{sourceTextRevision:1},{status:'failed'}]){
 assert.equal(api.select({...video,voiceManifest:{...video.voiceManifest,items:[{...item,...patch}]}},sentence,source,'read'),null);
}
const phraseItem={...item,kind:'expression',expressionId:'e0',text:'read into'};
assert.equal(api.select({...video,voiceManifest:{...video.voiceManifest,items:[phraseItem]}},sentence,source,'read into'),phraseItem,'phrase selects whole phrase audio');
assert.equal(api.select(video,{...sentence,english:'read elsewhere'},source,'read'),null,'stale lookup is hidden');
let release,plays=0,paused=0,lastAudio,states=[];
const makeAudio=()=>lastAudio={play(){plays++;this.onplaying?.();return Promise.resolve()},pause(){paused++},removeAttribute(){},load(){}};
const player=api.create({makeAudio,authorize:()=>new Promise(resolve=>release=resolve),onState:state=>states.push(state)});
const pending=player.play(item);player.stop();release({});assert.equal(await pending,false);assert.equal(plays,0,'closing during authorization never starts audio');
const next=player.play(item);release({});assert.equal(await next,true);assert.equal(plays,1);assert.equal(states.at(-1),'playing');player.stop();assert.equal(paused,1);
let rejectPlay;
const racing=api.create({makeAudio:()=>({play:()=>new Promise((_,reject)=>rejectPlay=reject),pause(){},removeAttribute(){},load(){}}),authorize:async()=>({}),onState:state=>states.push(state)});
const old=racing.play(item);await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof rejectPlay,'function');racing.stop();rejectPlay(Error('interrupted'));await old;assert.equal(states.at(-1),'idle','late play rejection cannot replace new UI state');
const blocked=api.create({makeAudio:()=>({play:()=>Promise.reject(Error('NotAllowedError')),pause(){},removeAttribute(){},load(){}}),authorize:async()=>({}),onState:state=>states.push(state)});
assert.equal(await blocked.play(item),false);assert.equal(states.at(-1),'error','mobile gesture rejection is retryable');
// Deterministic timers cover interruption after playback starts, not just the
// initial load. Repeated waiting events must not postpone the timeout forever.
const timers=new Map();let nextTimer=0,recoveryAudio;
const recoveryContext={window:{},setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer},clearTimeout:id=>timers.delete(id)};
vm.runInNewContext(fs.readFileSync('shared/teaching-voice.js','utf8'),recoveryContext);
const recovery=recoveryContext.window.EastudyTeachingVoice.create({authorize:async()=>({}),onState:state=>states.push(state),makeAudio:()=>recoveryAudio={currentTime:0,play(){this.onplaying();return Promise.resolve()},pause(){},removeAttribute(){},load(){}}});
assert.equal(await recovery.play(item),true);assert.equal(timers.size,0);
recoveryAudio.onwaiting();assert.equal(states.at(-1),'loading');assert.equal(timers.size,1);
const pendingTimer=[...timers.keys()][0];recoveryAudio.onwaiting();assert.equal([...timers.keys()][0],pendingTimer);
recoveryAudio.currentTime=.2;recoveryAudio.ontimeupdate();assert.equal(timers.size,0);assert.equal(states.at(-1),'playing');
recoveryAudio.onstalled();assert.equal(timers.size,1);
const lateWaiting=recoveryAudio.onwaiting;
[...timers.values()][0]();assert.equal(states.at(-1),'error');assert.equal(recoveryAudio.onwaiting,null);
assert.equal(await recovery.play(item),true,'a stalled pronunciation can be retried');
lateWaiting();assert.equal(timers.size,0,'old media events cannot stall a replacement');
recoveryAudio.onwaiting();recovery.stop();assert.equal(timers.size,0);assert.equal(states.at(-1),'idle');
console.log('Teaching voice identity, playback races and stall recovery passed.');
