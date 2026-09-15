// Reproducible same-origin copies of the browser dependencies already used by the app.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const assets=[
 ['supabase-2.116.0.js','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js'],
 ['supabase-2.116.0-LICENSE','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/LICENSE'],
 ['hls-1.6.13.min.js','https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js'],
 ['hls-1.6.13-LICENSE','https://cdn.jsdelivr.net/npm/hls.js@1.6.13/LICENSE']
];
const dir=path.join(root,'assets/vendor');fs.mkdirSync(dir,{recursive:true});
for(const [name,url] of assets){
 const args=['--fail','--silent','--show-error','--max-time','60'];
 if(process.env.HTTPS_PROXY)args.push('--proxy',process.env.HTTPS_PROXY);
 const body=execFileSync('curl.exe',[...args,url],{maxBuffer:8*1024*1024,encoding:'utf8',windowsHide:true});
 if(name.endsWith('.js'))new vm.Script(body,{filename:name});
 else if(!body.includes('Copyright')&&!body.includes('copyright'))throw Error('Unexpected license: '+name);
 fs.writeFileSync(path.join(dir,name),body);console.log(name,Buffer.byteLength(body));
}
