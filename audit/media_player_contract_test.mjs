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
vm.runInNewContext(fs.readFileSync('shared/media-player.js','utf8'),{window,console});
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
console.log('Media player single-rendition contract: 9 checks passed.');
