import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class HlsFixture{
  static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
  static isSupported(){return true}
  constructor(){this.handlers={};this.currentLevel=-1}
  loadSource(value){this.source=value}
  attachMedia(video){this.video=video}
  on(name,handler){this.handlers[name]=handler;if(name==='manifest')handler(null,{levels:[{height:480},{height:720}]})}
  destroy(){this.destroyed=true}
}
const select={value:'auto',disabled:false,innerHTML:'',addEventListener(_,fn){this.change=fn},removeEventListener(){}};
const video={paused:false,currentTime:4,duration:20,readyState:1,pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},load(){this.loaded=true},addEventListener(){},removeAttribute(name){this.removed=name}};
const window={Hls:HlsFixture};
vm.runInNewContext(fs.readFileSync('shared/media-player.js','utf8'),{window,console});
const player=window.EastudyMediaPlayer.create({video,select,source:{playback:{masterUrl:'master.m3u8',original:{url:'source.mp4',label:'1080p 原画'}}}});
assert.equal(player.mode,'hls.js');
assert.match(select.innerHTML,/480p/);
assert.match(select.innerHTML,/720p/);
assert.match(select.innerHTML,/1080p 原画/);
player.setQuality('1');
player.setQuality('original');
assert.equal(player.mode,'native');
assert.equal(video.src,'source.mp4');
assert.equal(video.currentTime,4);
player.setQuality('auto');
assert.equal(player.mode,'hls.js');
assert.equal(video.currentTime,4);
player.destroy();
assert.equal(video.paused,true);
assert.equal(video.removed,'src');
console.log('Media player contract: 11 checks passed.');
