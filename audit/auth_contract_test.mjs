import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)}}
const calls=[],localStorage=storage(),sessionStorage=storage();
const api={auth:{setSession:async input=>{calls.push(['set-session',input]);return {data:{session:input},error:null}},signInWithPassword:async input=>{calls.push(['legacy-login',input]);return {data:{},error:null}},updateUser:async input=>{calls.push(['password',input]);return {data:{},error:null}}},rpc:async name=>{calls.push(['rpc',name]);return {data:null,error:null}}};
const fetch=async(url,init)=>{calls.push(['fetch',url,JSON.parse(init.body)]);return {ok:true,json:async()=>({session:{access_token:'access',refresh_token:'refresh'}})}};
const window={localStorage,sessionStorage,fetch,EASTUDY_SUPABASE_CONFIG:{url:'https://fixture.supabase.co',publishableKey:'fixture-key'},supabase:{createClient:()=>api}};
const context=vm.createContext({window,localStorage,sessionStorage,fetch,console,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}});
vm.runInContext(fs.readFileSync(new URL('../shared/supabase-client.js',import.meta.url),'utf8'),context);

const auth=window.EastudyAuth;
assert.equal(auth.isLearnerProfile({role:'admin'}),true);
await auth.signInAccount({account:'learner_01',password:'Password123'},'student');
assert.deepEqual(calls[0],['fetch','/api/auth/login',{account:'learner_01',password:'Password123'}]);
assert.deepEqual(JSON.parse(JSON.stringify(calls[1])),['set-session',{access_token:'access',refresh_token:'refresh'}]);
await auth.registerWithInvite({account:'new_learner',password:'Password123',displayName:'测试学员',inviteCode:'EAST-TEST-CODE',attemptId:'00000000-0000-4000-8000-000000000001'},'student');
assert.equal(calls[2][1],'/api/auth/register');
assert.equal(calls[2][2].inviteCode,'EAST-TEST-CODE');
assert.equal(calls[2][2].attemptId,'00000000-0000-4000-8000-000000000001');
await auth.updatePassword('12345678','student');
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['password',{password:'12345678'}]);
assert.ok(!calls.some(row=>row[0]==='rpc'&&row[1]==='mark_my_phone_verified'));

const studentHtml=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const studentApp=fs.readFileSync(new URL('../assets/js/app.js',import.meta.url),'utf8');
const adminHtml=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
assert.ok(studentHtml.includes('id="signinAccount"'));
assert.ok(studentHtml.includes('id="signinInviteCode"'));
assert.ok(studentHtml.includes('id="signinPasswordConfirm"'));
assert.ok(!studentHtml.includes('id="authGetCode"'));
assert.ok(studentHtml.includes('id="authPasswordEye"')&&studentHtml.includes('aria-pressed="false"'));
assert.ok(studentApp.includes('function setPasswordVisible('));
assert.ok(studentApp.includes("visible?'eye-off':'eye'"));
assert.ok(adminHtml.includes('data-password-target="adminAuthPass"'));
console.log(JSON.stringify({ok:true,tests:18},null,2));
