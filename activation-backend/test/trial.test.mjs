import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deviceHash,safeTrialDecision,validDeviceId,validHash} from '../src/trial.mjs';

const secret='test secret with at least thirty two bytes total';
test('trial hash stable across repeated app launches on same device',async()=>{
 const id='dv1_xjUPRxJb8eNTpiS_9-1m2-3e4Fad_';
 assert.equal(validDeviceId(id),true);
 const a=await deviceHash(secret,id),b=await deviceHash(secret,id);
 assert.equal(a,b);assert.ok(validHash(a));
 assert.notEqual(a,await deviceHash(secret,'dv1_otherDevice_1234567890'));
});
test('invalid client device IDs rejected, no raw device ID leaked as hash',async()=>{
 for(const x of [null,'','androidId','bad/URL','a'.repeat(91)])assert.equal(validDeviceId(x),false);
 await assert.rejects(()=>deviceHash(secret,'invalid/123'));
 assert.equal(validHash('dv1_anAndroidIdentifier'),false);
});
test('backend refuses unexpected database trial states',()=>{
 assert.deepEqual(safeTrialDecision({permitted:true,state:'reserved'}),{permitted:true,state:'reserved'});
 assert.deepEqual(safeTrialDecision([{permitted:false,state:'used'}]),{permitted:false,state:'used'});
 assert.throws(()=>safeTrialDecision([{state:'unlimited',permitted:true}]));
 assert.throws(()=>safeTrialDecision({state:'active',permitted:'true'}));
});

// Endpoint tests use a fake Supabase network. They do not create accounts, charges,
// vehicle sessions, or touch the deployed Worker.
import {handle} from '../src/index.mjs';
const sampleUser={id:'22222222-2222-4222-8222-222222222222',email:'test@example.com',email_confirmed_at:'2026-11-01T00:00:00Z'};
const sampleDevice='dv1_1234567890abcdef1234567890abcdef1234567890abcdef';
const sampleEnv={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_testing',SUPABASE_SECRET_KEY:'sb_secret_testing',ACTIVATION_HMAC_KEY:secret,ALLOWED_ORIGINS:'https://kaissymarji.github.io'};
function makeRequest(route,device=sampleDevice,token=true){return new Request('https://api.example.workers.dev'+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'Authorization':'Bearer sample.jwt.signature'}:{})},body:JSON.stringify({deviceId:device})});}
function fakeDb(state='reserved',paid=false){
 const calls=[];
 async function fetcher(input){
   const url=String(input);calls.push(url);
   if(url.includes('/auth/v1/user'))return new Response(JSON.stringify(sampleUser),{status:200});
   if(url.includes('/rest/v1/purchases'))return new Response(JSON.stringify(paid?[{id:'paid-id'}]:[]),{status:200});
   if(url.includes('/rest/v1/rpc/v200_trial_authorize'))return new Response(JSON.stringify({permitted:state!=='used',state}),{status:200});
   if(url.includes('/rest/v1/rpc/v200_trial_start'))return new Response(JSON.stringify({started:true,state:'active'}),{status:200});
   if(url.includes('/rest/v1/rpc/v200_trial_finish'))return new Response(JSON.stringify({finished:true,state:'used'}),{status:200});
   throw Error('Unexpected fake API: '+url);
 }
 return {calls,fetcher};
}
test('native free trial authorize requires confirmed Supabase user and uses hashed device key',async()=>{
 const db=fakeDb();
 const unauth=await handle(makeRequest('/api/trial/authorize',sampleDevice,false),sampleEnv,db.fetcher);
 assert.equal(unauth.status,401);assert.equal(db.calls.length,0);
 const res=await handle(makeRequest('/api/trial/authorize'),sampleEnv,db.fetcher);
 assert.equal(res.status,200);assert.deepEqual(await res.json(),{permitted:true,mode:'trial',state:'reserved'});
 assert.equal(db.calls.some(x=>x.includes('v200_trial_authorize')),true);
 assert.equal(db.calls.some(x=>x.includes(sampleDevice)),false);
});
test('exhausted trial denies access; verified purchased account bypasses reservation',async()=>{
 const denied=await handle(makeRequest('/api/trial/authorize'),sampleEnv,fakeDb('used').fetcher);
 assert.deepEqual(await denied.json(),{permitted:false,mode:'none',state:'used'});
 const db=fakeDb('used',true);
 const paid=await handle(makeRequest('/api/trial/authorize'),sampleEnv,db.fetcher);
 assert.deepEqual(await paid.json(),{permitted:true,mode:'paid',active:true});
 assert.equal(db.calls.some(x=>x.includes('/rpc/')),false);
});
test('trial start/end use only the service-role RPC with server-verified identity',async()=>{
 const db=fakeDb();
 const started=await handle(makeRequest('/api/trial/start'),sampleEnv,db.fetcher);
 assert.deepEqual(await started.json(),{started:true,state:'active'});
 const ended=await handle(makeRequest('/api/trial/end'),sampleEnv,db.fetcher);
 assert.deepEqual(await ended.json(),{finished:true,state:'used'});
 const invalid=await handle(makeRequest('/api/trial/authorize','wrong/device/id'),sampleEnv,db.fetcher);
 assert.equal(invalid.status,400);
});
