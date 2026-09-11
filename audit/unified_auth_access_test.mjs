import assert from 'node:assert/strict';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestPost as activate } from '../functions/api/auth/activate-and-login.js';
import { canonicalLoginKey } from '../functions/_lib/login-identity.js';

const env={SUPABASE_URL:'https://project.test',SUPABASE_PUBLISHABLE_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service'};
const request=(path,body)=>new Request('https://site.test'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

assert.equal(canonicalLoginKey('198 8256 8394'),'19882568394');
assert.equal(canonicalLoginKey('+86 198 8256 8394'),'19882568394');
assert.equal(canonicalLoginKey('00123456'),'00123456');
assert.equal(canonicalLoginKey('Alpha.User'),'alpha.user');
assert.equal(canonicalLoginKey('账号'),'');

{
  let grantBody;
  globalThis.fetch=async(url,init={})=>{
    if(String(url).includes('/resolve_account_login_v2'))return response({state:'FOUND',userId:'user-1',identity:{email:'mapped@test.invalid'}});
    if(String(url).includes('/auth/v1/token')){grantBody=JSON.parse(init.body);return response({user:{id:'user-1'},access_token:'a',refresh_token:'r'})}
    if(String(url).includes('/service_get_user_learning_access_v2'))return response({canEnterLearning:true,canPlay:true,reason:'OK',kind:'LEARNER',expiresAt:'2099-01-01T00:00:00Z'});
    throw new Error('unexpected '+url);
  };
  const result=await login({request:request('/api/auth/login',{account:'19882568394',password:'111111'}),env});
  assert.equal(result.status,200);
  assert.deepEqual(grantBody,{email:'mapped@test.invalid',password:'111111'},'11 digit mapped account must use its registered identity');
}

{
  globalThis.fetch=async(url)=>{
    if(String(url).includes('/resolve_account_login_v2'))return response({state:'FOUND',userId:'u',identity:{email:'u@test.invalid'}});
    if(String(url).includes('/auth/v1/token'))return response({user:{id:'u'},access_token:'a',refresh_token:'r'});
    if(String(url).includes('/service_get_user_learning_access_v2'))return response({canEnterLearning:false,reason:'VIP_EXPIRED',expiresAt:'2026-01-01T00:00:00Z'});
    throw new Error('unexpected '+url);
  };
  const result=await login({request:request('/api/auth/login',{account:'12345678',password:'111111'}),env});
  assert.equal(result.status,403);
  const payload=await result.json();
  assert.equal(payload.error,'VIP_EXPIRED');
  assert.equal(payload.session,undefined);
}

{
  globalThis.fetch=async(url)=>String(url).includes('/resolve_account_login_v2')?response({message:'database unavailable'},503):response({});
  const result=await login({request:request('/api/auth/login',{account:'12345678',password:'111111'}),env});
  assert.equal(result.status,503);
  assert.equal((await result.json()).error,'LOGIN_SERVICE_UNAVAILABLE');
}

{
  let accessReads=0,redeems=0;
  globalThis.fetch=async(url,init={})=>{
    const value=String(url);
    if(value.includes('/resolve_account_login_v2'))return response({state:'FOUND',userId:'u',identity:{email:'u@test.invalid'}});
    if(value.includes('/auth/v1/token'))return response({user:{id:'u'},access_token:'user-token',refresh_token:'r'});
    if(value.includes('/service_get_user_learning_access_v2'))return response(++accessReads===1?{canEnterLearning:false,reason:'VIP_EXPIRED',kind:'LEARNER'}:{canEnterLearning:true,canPlay:true,reason:'OK',kind:'LEARNER',expiresAt:'2099-01-01T00:00:00Z'});
    if(value.includes('/redeem_activation_code')){redeems++;assert.equal(init.headers.Authorization,'Bearer user-token');return response([{product_id:'eastudy_pro'}])}
    throw new Error('unexpected '+url);
  };
  const result=await activate({request:request('/api/auth/activate-and-login',{account:'12345678',password:'111111',inviteCode:'EAST-AAAA-BBBB-CCCC'}),env});
  assert.equal(result.status,200);
  assert.equal(redeems,1);
  assert.equal(accessReads,2);
}

{
  let redeems=0;
  globalThis.fetch=async(url)=>{
    const value=String(url);
    if(value.includes('/resolve_account_login_v2'))return response({state:'FOUND',userId:'admin',identity:{email:'admin@test.invalid'}});
    if(value.includes('/auth/v1/token'))return response({user:{id:'admin'},access_token:'a',refresh_token:'r'});
    if(value.includes('/service_get_user_learning_access_v2'))return response({canEnterLearning:true,reason:'OK',kind:'ADMIN'});
    if(value.includes('/redeem_activation_code')){redeems++;return response({})}
    throw new Error('unexpected '+url);
  };
  const result=await activate({request:request('/api/auth/activate-and-login',{account:'admin1',password:'111111',inviteCode:'EAST-AAAA-BBBB-CCCC'}),env});
  assert.equal(result.status,409);
  assert.equal(redeems,0);
}

console.log('unified auth and access tests passed');
