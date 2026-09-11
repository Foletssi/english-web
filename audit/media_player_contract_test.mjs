import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class HlsFixture {
  static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
  static isSupported(){return true}
  constructor(config){this.config=config;this.handlers={};this.levels=[{height:720}]}
  loadSource(value){this.source=value}
  attachMedia(video){this.video=video}
  on(name,handler){this.handlers[name]=handler;if(name==='manifest')handler()}
  destroy(){this.destroyed=true}
}
const video={paused:false,currentTime:4,duration:20,readyState:1,pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},load(){this.loaded=true},addEventListener(){},removeAttribute(name){this.removed=name}};
const window={Hls:HlsFixture};
vm.runInNewContext(fs.readFileSync('shared/media-player.js','utf8'),{window,console,AbortController,setTimeout,clearTimeout});
const player=window.EastudyMediaPlayer.create({video,source:{mediaUrl:'720p/index.m3u8',playback:{policy:'single-standard-v2',masterUrl:'720p/index.m3u8',variants:[{label:'720p'}]}}});
assert.equal(player.mode,'hls.js');
assert.equal(player.quality,undefined);
assert.equal(video.src,undefined);
player.retry();
assert.equal(player.mode,'hls.js');
player.destroy();
assert.equal(video.paused,true);
assert.equal(video.removed,'src');
const source=fs.readFileSync('shared/media-player.js','utf8');
assert.ok(!source.includes('original.url'));
assert.ok(source.includes('maxBufferLength:20'));
assert.ok(source.includes('backBufferLength:30'));

class PendingHls {
  static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
  static isSupported(){return true}
  constructor(){this.handlers={};this.levels=[{height:720}];PendingHls.last=this}
  loadSource(value){this.source=value}
  attachMedia(value){this.video=value}
  on(name,handler){this.handlers[name]=handler}
  destroy(){this.destroyed=true}
}
let playCount=0;
const pendingVideo={paused:true,currentTime:0,duration:20,readyState:0,pause(){this.paused=true},play(){playCount+=1;this.paused=false;return Promise.resolve()},load(){},addEventListener(){},removeEventListener(){},removeAttribute(){}};
const pendingWindow={Hls:PendingHls};
vm.runInNewContext(source,{window:pendingWindow,console,AbortController,setTimeout,clearTimeout});
const pendingPlayer=pendingWindow.EastudyMediaPlayer.create({video:pendingVideo,source:{mediaUrl:'720p/index.m3u8',playback:{masterUrl:'720p/index.m3u8'}}});
await Promise.resolve();
const cancelledPlay=pendingPlayer.play();
pendingPlayer.pause();
PendingHls.last.handlers.manifest();
await cancelledPlay;
assert.equal(playCount,0,'pause must cancel a play intent that is waiting for the manifest');
const reload=pendingPlayer.retry();
await Promise.resolve();
PendingHls.last.handlers.manifest();
await reload;
const stalePlay=pendingPlayer.play();
const latestLoad=pendingPlayer.retry();
await stalePlay;
assert.equal(playCount,0,'an obsolete play request must not start the replacement load');
await Promise.resolve();
PendingHls.last.handlers.manifest();
await latestLoad;
await pendingPlayer.play();
assert.equal(playCount,1,'the current generation may play after it becomes ready');
pendingPlayer.destroy();
console.log('Media player single-rendition lifecycle contract passed.');
