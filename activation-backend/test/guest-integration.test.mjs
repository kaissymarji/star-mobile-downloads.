import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/index.mjs';

const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_dummy',
 SUPABASE_SECRET_KEY:'sb_secret_dummy',ACTIVATION_HMAC_KEY:'A-test-only-hmac-key-longer-than-32-characters',
 ALLOWED_ORIGINS:'https://kaissymarji.github.io',STRIPE_WEBHOOK_SECRET:'whsec_notreal'};
const id='dv1_'+'e'.repeat(48);
function request(path,data,method='POST'){
 return new Request('https://v200-tech-activation.example.workers.dev'+path,{method,
 ...(data?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
}
function database(state='reserved'){
 const calls=[];
 const fetcher=async(url,opts)=>{
  const path=String(url);calls.push({path,method:opts.method,body:opts.body||''});
  if(path.includes('/rpc/v200_guest_trial_preflight'))return new Response(JSON.stringify({permitted:state!=='used',state}),{status:200});
  if(path.includes('/rpc/v200_guest_trial_start'))return new Response(JSON.stringify({started:state!=='used',state:state==='used'?'used':'active'}),{status:200});
  throw Error('Unexpected downstream call: '+path);
 };
 return {calls,fetcher};
}
test('public health reports guest-trial API without secrets',async()=>{
 const response=await handle(request('/health',null,'GET'),env);
 const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.guestTrialApi,true);assert.equal(data.guestTrialVersion,'1');
 assert.equal(JSON.stringify(data).includes(env.ACTIVATION_HMAC_KEY),false);
});
test('browser GET of trial endpoint cannot write a trial',async()=>{
 const db=database();const response=await handle(request('/api/trial/guest/authorize',null,'GET'),env,db.fetcher);
 assert.equal(response.status,405);assert.equal(db.calls.length,0);
});
test('guest POST routes through worker, hashes device ID and records no raw ID',async()=>{
 const db=database();const response=await handle(request('/api/trial/guest/authorize',{deviceId:id,autoScan:true}),env,db.fetcher);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{permitted:true,mode:'trial',state:'reserved'});
 assert.equal(db.calls.length,1);assert.match(db.calls[0].path,/v200_guest_trial_preflight/);
 assert.equal(db.calls[0].body.includes(id),false);assert.match(db.calls[0].body,/"p_hash":"[0-9a-f]{64}"/);
 const started=await handle(request('/api/trial/guest/start',{deviceId:id}),env,db.fetcher);
 assert.equal((await started.json()).started,true);
});
test('used trial remains denied by worker',async()=>{
 const db=database('used');const response=await handle(request('/api/trial/guest/authorize',{deviceId:id,autoScan:true}),env,db.fetcher);
 assert.deepEqual(await response.json(),{permitted:false,mode:'none',state:'used'});
});
