import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync('admin/assets/admin.js','utf8');
const start=source.indexOf('function processingConsistencyBanner()');
const end=source.indexOf('function renderVideos()',start);
assert.ok(start>=0&&end>start);
const jobs=[{id:'job-a',videoId:42,status:'REVIEW',inputTitle:'真实标题',resultSentenceCount:2}];
const box={Store:{localOnly:false,getVideo:()=>null,listSentences:()=>[]},allJobs:()=>jobs,
 CloudState:{jobsSyncError:null},window:{EastudyContentAudit:{processingIntegrity:(video,rows)=>({issues:video&&rows.length===2?[]:[{message:'任务已结束但视频记录不存在'}]})}},
 escapeHtml:text=>String(text).replaceAll('<','&lt;'),cloudErrorMessage:error=>error.message};
vm.createContext(box);vm.runInContext(source.slice(start,end),box);
const missing=box.processingConsistencyBanner();
assert.match(missing,/真实标题/);assert.match(missing,/任务已结束但视频记录不存在/);
assert.match(missing,/data-refresh-studio-jobs/);
box.CloudState.jobsSyncError=new Error('CONTENT_SYNC_FAILED');
assert.match(box.processingConsistencyBanner(),/CONTENT_SYNC_FAILED/);
box.Store.getVideo=()=>({id:42});box.Store.listSentences=()=>[{},{}];box.CloudState.jobsSyncError=null;
assert.equal(box.processingConsistencyBanner(),'');
assert.match(source,/path==='\/videos'\|\|path==='\/subtitles'/);
console.log('PASS missing REVIEW content and sync errors remain visible in library and subtitle views');