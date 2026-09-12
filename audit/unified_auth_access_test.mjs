import assert from 'node:assert/strict';
import { canonicalLoginKey } from '../supabase/functions/_shared/login-identity.js';
import { publicAuthFailure } from '../supabase/functions/_shared/auth-errors.js';

let edgeHandler;
globalThis.Deno={env:{get:name=>({SUPABASE_URL:'https://project.test',SUPABASE_SERVICE_ROLE_KEY:'service'})[name]||''},serve:handler=>{edgeHandler=handler}};
await import('../supabase/functions/learner-auth/index.ts');
const request=body=>new Request('https://project.test/functions/v1/learner-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const response=(body,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:status===204?{}:{'Content-Type':'application/json'}});

assert.equal(canonicalLoginKey('198 8256 8394'),'19882568394');
assert.equal(canonicalLoginKey('+86 198 8256 8394'),'19882568394');
assert.equal(canonicalLoginKey('00123456'),'00123456');
assert.equal(canonicalLoginKey('Alpha.User'),'alpha.user');
assert.equal(canonicalLoginKey('账号'),'');
assert.deepEqual(publicAuthFailure({message:'ACTIVATION_CODE_EXPIRED',status:400}),[409,'ACTIVATION_CODE_EXPIRED']);

let mode='success',accessReads=0,discarded=0,redeems=0,grantBody=null;
globalThis.fetch=async(url,init={})=>{
  const value=String(url);
  if(value.includes('/resolve_account_login_v2')){
    if(mode==='service-error')return response({message:'database unavailable'},503);
    return response({state:'FOUND',userId:mode==='admin'?'admin':'user-1',identity:{email:'mapped@test.invalid'}});
  }
  if(value.includes('/auth/v1/token')){grantBody=JSON.parse(init.body);return response({user:{id:mode==='admin'?'admin':'user-1'},access_token:'access',refresh_token:'refresh'})}
  if(value.includes('/service_get_user_learning_access_v2')){
    accessReads+=1;
    if(mode==='expired'||mode==='activate-invalid')return response({canEnterLearning:false,canPlay:false,reason:'VIP_EXPIRED',kind:'LEARNER',expiresAt:'2026-01-01T00:00:00Z'});
    if(mode==='activate')return response(accessReads===1?{canEnterLearning:false,reason:'VIP_EXPIRED',kind:'LEARNER'}:{canEnterLearning:true,canPlay:true,reason:'OK',kind:'LEARNER',expiresAt:'2099-01-01T00:00:00Z'});
    if(mode==='role')return response({canEnterLearning:false,canPlay:false,reason:'ROLE_FORBIDDEN',kind:'NONE'});
    if(mode==='admin')return response({canEnterLearning:true,canPlay:true,reason:'OK',kind:'ADMIN'});
    return response({canEnterLearning:true,canPlay:true,reason:'OK',kind:'LEARNER',expiresAt:'2099-01-01T00:00:00Z'});
  }
  if(value.includes('/redeem_activation_code')){redeems+=1;return mode==='activate-invalid'?response({message:'ACTIVATION_CODE_EXPIRED'},400):response([{product_id:'eastudy_pro'}])}
  if(value.includes('/auth/v1/logout')){discarded+=1;return response(null,204)}
  throw new Error('unexpected '+url);
};

let result=await edgeHandler(request({account:'19882568394',password:'111111'}));
assert.equal(result.status,200);
assert.deepEqual(grantBody,{email:'mapped@test.invalid',password:'111111'});

mode='expired';accessReads=discarded=0;
result=await edgeHandler(request({account:'12345678',password:'111111'}));
assert.equal(result.status,403);assert.equal((await result.json()).error,'VIP_EXPIRED');assert.equal(discarded,1);

mode='service-error';discarded=0;
result=await edgeHandler(request({account:'12345678',password:'111111'}));
assert.equal(result.status,503);assert.equal((await result.json()).error,'LOGIN_SERVICE_UNAVAILABLE');assert.equal(discarded,0);

mode='activate';accessReads=redeems=discarded=0;
result=await edgeHandler(request({action:'activate',account:'12345678',password:'111111',inviteCode:'EAST-AAAA-BBBB-CCCC'}));
assert.equal(result.status,200);assert.equal(redeems,1);assert.equal(accessReads,2);assert.equal(discarded,0);

mode='activate-invalid';accessReads=redeems=discarded=0;
result=await edgeHandler(request({action:'activate',account:'12345678',password:'111111',inviteCode:'EAST-AAAA-BBBB-CCCC'}));
assert.equal(result.status,409);assert.equal((await result.json()).error,'ACTIVATION_CODE_EXPIRED');assert.equal(discarded,1);

mode='admin';accessReads=redeems=discarded=0;
result=await edgeHandler(request({action:'activate',account:'admin1',password:'111111',inviteCode:'EAST-AAAA-BBBB-CCCC'}));
assert.equal(result.status,409);assert.equal(redeems,0);assert.equal(discarded,1);

mode='role';accessReads=discarded=0;
result=await edgeHandler(request({account:'staff1',password:'111111'}));
assert.equal(result.status,403);assert.equal((await result.json()).error,'ROLE_FORBIDDEN');assert.equal(discarded,1);

console.log('Production learner auth and access tests passed.');
