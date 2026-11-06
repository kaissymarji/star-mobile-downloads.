import test from 'node:test';
import assert from 'node:assert/strict';
import {guestTrialRoute} from '../src/guest-trial.mjs';
const ID='dv1_'+'a'.repeat(48);
const req=(path,obj,token='')=>new Request('https://example.workers.dev'+path,{method:'POST',
 headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(obj)});
const reply=(data,status)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function setup({dbState='reserved',paid=false}={}){
 const calls=[];
 const ctx={
  authenticate:async()=>({id:'11111111-1111-4111-8111-111111111111'}),
  adminRest:async(env,method,path,body)=>{calls.push({path,body});return path.includes('start')?{started:dbState!=='used',state:dbState}:{permitted:dbState==='reserved'||dbState==='active',state:dbState};},
  reply,parseJson:async req=>req.json(),fetcher:async()=>null,findPaid:async()=>paid,
  required:(env,keys)=>{for(const k of keys)if(!env[k])throw Error('missing '+k);},
  httpError:(status,message)=>Object.assign(new Error(message),{status}),
  deviceHash:async()=> 'b'.repeat(64),validDeviceId:id=>/^dv1_[a-f0-9]{48}$/.test(id),
  safeTrialDecision:result=>result,origin:''
 };
 return {ctx,calls};
}
const env={ACTIVATION_HMAC_KEY:'x'.repeat(64),SUPABASE_SECRET_KEY:'private'};
test('guest can reserve a free Auto Scan without sign-in',async()=>{
 const s=setup();const r=await guestTrialRoute(req('/api/trial/guest/authorize',{deviceId:ID,autoScan:true}),env,s.ctx);
 assert.equal((await r.json()).permitted,true);assert.equal(s.calls[0].path,'rpc/v200_guest_trial_preflight');
 assert.equal(s.calls[0].body.p_auto_scan,true);
});
test('server-refused used trial never grants a second Auto Scan',async()=>{
 const s=setup({dbState:'used'});const r=await guestTrialRoute(req('/api/trial/guest/authorize',{deviceId:ID,autoScan:true}),env,s.ctx);
 const d=await r.json();assert.equal(d.permitted,false);assert.equal(d.mode,'none');
});
test('verified purchase can bypass free-trial state',async()=>{
 const s=setup({dbState:'used',paid:true});const r=new Request('https://example.workers.dev/api/trial/guest/authorize',{
  method:'POST',headers:{Authorization:'Bearer valid-token','Content-Type':'application/json'},
  body:JSON.stringify({deviceId:ID,autoScan:true})});
 const d=await (await guestTrialRoute(r,env,s.ctx)).json();assert.equal(d.mode,'paid');assert.equal(s.calls.length,0);
});
test('ECU reply is recorded in service-role RPC only',async()=>{
 const s=setup({dbState:'active'});const d=await (await guestTrialRoute(req('/api/trial/guest/start',{deviceId:ID}),env,s.ctx)).json();
 assert.equal(d.started,true);assert.equal(s.calls[0].path,'rpc/v200_guest_trial_start');
});
test('malformed device ID and missing explicit autoScan are rejected',async()=>{
 const s=setup();await assert.rejects(()=>guestTrialRoute(req('/api/trial/guest/authorize',{deviceId:'bad',autoScan:true}),env,s.ctx));
 await assert.rejects(()=>guestTrialRoute(req('/api/trial/guest/authorize',{deviceId:ID}),env,s.ctx));
});
