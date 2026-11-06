import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {activationCode,verifyStripeSignature,handle} from '../src/index.mjs';

const user={id:'22222222-2222-4222-8222-222222222222',email:'paid@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'};
const origin='https://kaissymarji.github.io';
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_PAYMENT_LINK_URL:'https://buy.stripe.com/9B600j4NB6e4aQZ9k76g801',STRIPE_PAYMENT_LINK_ID:'plink_correct',STRIPE_WEBHOOK_SECRET:'whsec_test',STRIPE_SECRET_KEY:'sk_test_fake',ACTIVATION_HMAC_KEY:'correct horse battery staple very long secret for testing',ALLOWED_ORIGINS:origin+',https://community.v200.invalid'};
const device='22222222-2222-4222-8222-222222222233';
function mock(){
 const intents=[],purchases=[],profiles=[{id:user.id,role:'member',last_seen_at:null}],activity=[];
 let stripe=null;
 let paymentIntent={id:'pi_abc',status:'succeeded',amount_received:500,currency:'usd',latest_charge:{id:'ch_test',paid:true,refunded:false,disputed:false,amount_refunded:0}};
 const result=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
 const fetcher=async(raw,options={})=>{
  const url=new URL(raw);const path=url.pathname;const method=options.method||'GET';
  if(path==='/auth/v1/user')return options.headers?.Authorization==='Bearer valid' ?result(user):result({},401);
  if(path.startsWith('/v1/checkout/sessions/'))return stripe?result(stripe):result({},404);
  if(path.startsWith('/v1/payment_intents/'))return paymentIntent?result(paymentIntent):result({},404);
  if(path.endsWith('/releases'))return result([]);
  const body=options.body?JSON.parse(options.body):null;
  if(path.startsWith('/rest/v1/checkout_intents')){
   if(method==='POST'){intents.push(...body.map((x,i)=>({id:`33333333-3333-4333-8333-33333333333${i}`,status:'pending',...x})));return result(intents.slice(-body.length),201);}
   if(method==='PATCH'){const r=intents.find(x=>x.client_reference===url.searchParams.get('client_reference').replace('eq.',''));if(r)Object.assign(r,body);return new Response(null,{status:204});}
   const ref=url.searchParams.get('client_reference')?.replace('eq.','');return result(intents.filter(x=>x.client_reference===ref));
  }
  if(path.startsWith('/rest/v1/purchases')){
   if(method==='POST'){
    for(const x of body)if(!purchases.find(p=>p.stripe_session_id===x.stripe_session_id))purchases.push(x);
    return result(body,201);
   }
   if(method==='PATCH'){
    const pi=url.searchParams.get('stripe_payment_intent')?.replace('eq.','');purchases.filter(x=>x.stripe_payment_intent===pi).forEach(x=>Object.assign(x,body));return new Response(null,{status:204});
   }
   const uid=url.searchParams.get('user_id')?.replace('eq.','');const status=url.searchParams.get('status')?.replace('eq.','');const sid=url.searchParams.get('stripe_session_id')?.replace('eq.','');
   const rows=purchases.filter(p=>(!uid||p.user_id===uid)&&(!status||p.status===status)&&(!sid||p.stripe_session_id===sid));
   return result(rows,200,{'content-range':'0-'+Math.max(0,rows.length-1)+'/'+rows.length});
  }
  if(path.startsWith('/rest/v1/profiles')){
   if(method==='PATCH'){const x=profiles[0];Object.assign(x,body);return new Response(null,{status:204});}
   let rows=profiles;if(url.searchParams.has('role'))rows=rows.filter(p=>p.role==='admin'||p.role==='moderator');
   if(url.searchParams.has('id'))rows=rows.filter(p=>p.id===url.searchParams.get('id').replace('eq.',''));
   return result(rows,200,{'content-range':'0-0/'+rows.length});
  }
  if(path.startsWith('/rest/v1/app_activity')){
   if(method==='POST'){activity.push(...body);return new Response(null,{status:204});}
   return result(activity,200,{'content-range':'0-0/'+activity.length});
  }
  return result({message:'Unknown mock endpoint: '+url},404);
 };
 return {fetcher,intents,purchases,profiles,activity,setStripe(v){stripe=v;},setPaymentIntent(v){paymentIntent=v;}};
}
function req(path,method='GET',data,token='valid',headers={}){
 const head={Origin:origin,...headers};if(token!==null)head.Authorization='Bearer '+token;
 if(data!==undefined)head['Content-Type']='application/json';
 return new Request('https://worker.example'+path,{method,headers:head,body:data===undefined?undefined:JSON.stringify(data)});
}
async function body(r){return r.json();}
function signedWebhook(event,secret=env.STRIPE_WEBHOOK_SECRET,t=Math.floor(Date.now()/1000)){
 const raw=JSON.stringify(event);const sig=createHmac('sha256',secret).update(t+'.'+raw).digest('hex');
 return new Request('https://worker.example/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':`t=${t},v1=${sig}`,'content-type':'application/json'},body:raw});
}
function session(ref,overrides={}){
 return {id:'cs_test_abcdefghijklmnop',mode:'payment',payment_status:'paid',currency:'usd',amount_subtotal:500,amount_total:500,payment_link:'plink_correct',client_reference_id:ref,payment_intent:'pi_abc',customer_details:{email:user.email},...overrides};
}

test('stripe signatures require unmodified body, valid timestamp, and correct secret',async()=>{
 const text='{"data":{"object":{"payment_status":"paid"}}}';const t=Math.floor(Date.now()/1000);const sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(t+'.'+text).digest('hex');
 assert.equal(await verifyStripeSignature(text,`t=${t},v1=${sig}`,env.STRIPE_WEBHOOK_SECRET),true);
 assert.equal(await verifyStripeSignature(text+' ',`t=${t},v1=${sig}`,env.STRIPE_WEBHOOK_SECRET),false);
 assert.equal(await verifyStripeSignature(text,`t=${t},v1=${sig}`,'wrong'),false);
 assert.equal(await verifyStripeSignature(text,`t=${t-601},v1=${sig}`,env.STRIPE_WEBHOOK_SECRET),false);
});
test('no paid license for unauthenticated, invalid origin or unconfirmed account',async()=>{
 const m=mock();
 assert.equal((await handle(req('/api/activation?device_id='+device),env,m.fetcher)).status,200);
 assert.equal((await body(await handle(req('/api/activation?device_id='+device),env,m.fetcher))).active,false);
 assert.equal((await handle(req('/api/activation?device_id='+device,'GET',undefined,'invalid'),env,m.fetcher)).status,401);
 const foreign=new Request('https://worker.example/api/activation?device_id='+device,{headers:{Origin:'https://evil.example',Authorization:'Bearer valid'}});
 assert.equal((await handle(foreign,env,m.fetcher)).status,403);
});
test('checkout creates random reference and only verified Stripe session grants device license',async()=>{
 const m=mock(),checkout=await body(await handle(req('/api/checkout/start','POST',{}),env,m.fetcher));
 assert.ok(checkout.checkoutUrl.startsWith('https://buy.stripe.com/'));
 const reference=new URL(checkout.checkoutUrl).searchParams.get('client_reference_id');
 assert.match(reference,/^[A-Za-z0-9_-]{20,80}$/);
 assert.equal(m.intents[0].user_id,user.id);
 const paid=session(reference);
 const event={id:'evt_true',type:'checkout.session.completed',data:{object:paid}};
 let response=await handle(signedWebhook(event,'wrong-secret'),env,m.fetcher);
 assert.equal(response.status,400);assert.equal(m.purchases.length,0);
 response=await handle(signedWebhook({...event,data:{object:{...paid,payment_status:'unpaid'}}}),env,m.fetcher);
 assert.equal(response.status,200);assert.equal(m.purchases.length,0);
 response=await handle(signedWebhook({...event,data:{object:{...paid,payment_link:'plink_wrong'}}}),env,m.fetcher);
 assert.equal(m.purchases.length,0);
 response=await handle(signedWebhook(event),env,m.fetcher);
 assert.equal(response.status,200);assert.equal((await body(response)).fulfilled,true);
 assert.equal(m.purchases.length,1);
 await handle(signedWebhook(event),env,m.fetcher);assert.equal(m.purchases.length,1,'duplicate webhook must not create second purchase');
 const status=await body(await handle(req('/api/activation?device_id='+device),env,m.fetcher));assert.equal(status.active,true);assert.equal(status.code,null);
 const visible=await body(await handle(req('/api/activation?device_id='+device+'&reveal=1'),env,m.fetcher));
 assert.match(visible.code,/^V2-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
 assert.notEqual(visible.code,await activationCode(env.ACTIVATION_HMAC_KEY,user.id,'44444444-4444-4444-8444-444444444444'));
 assert.deepEqual(await body(await handle(req('/api/license/check','POST',{deviceId:device,code:visible.code}),env,m.fetcher)),{valid:true});
 assert.deepEqual(await body(await handle(req('/api/license/check','POST',{deviceId:device,code:'V2-AAAAAAAAAAAA'}),env,m.fetcher)),{valid:false});
 const already=await handle(req('/api/checkout/start','POST',{}),env,m.fetcher);assert.equal(already.status,409);
});
test('a purchase without a linked checkout intent is never fulfilled automatically',async()=>{
 const m=mock(),ev={id:'evt_unlinked',type:'checkout.session.completed',data:{object:session('not-linked-to-a-user')}};
 const res=await body(await handle(signedWebhook(ev),env,m.fetcher));
 assert.equal(res.fulfilled,false);assert.equal(m.purchases.length,0);
});
test('previous paid sessions can be claimed only by account with matching verified email',async()=>{
 const m=mock();m.setStripe(session(null,{client_reference_id:null,id:'cs_test_priorpurchase123',customer_details:{email:user.email}}));
 const ok=await handle(req('/api/claim-previous','POST',{sessionId:'cs_test_priorpurchase123'}),env,m.fetcher);
 assert.equal(ok.status,200);assert.equal(m.purchases.length,1);
 const again=await handle(req('/api/claim-previous','POST',{sessionId:'cs_test_priorpurchase123'}),env,m.fetcher);
 assert.equal((await body(again)).alreadyLinked,true);
 const m2=mock();m2.setStripe(session(null,{client_reference_id:null,id:'cs_test_priorpurchase123',customer_details:{email:'different@example.test'}}));
 const no=await handle(req('/api/claim-previous','POST',{sessionId:'cs_test_priorpurchase123'}),env,m2.fetcher);
 assert.equal(no.status,403);assert.equal(m2.purchases.length,0);
});
test('previous checkout session no longer grants a code if its charge was refunded or disputed',async()=>{
 const m=mock();m.setStripe(session(null,{client_reference_id:null,id:'cs_test_refunded12345678'}));
 m.setPaymentIntent({id:'pi_abc',status:'succeeded',amount_received:500,currency:'usd',latest_charge:{paid:true,refunded:true,amount_refunded:500}});
 const response=await handle(req('/api/claim-previous','POST',{sessionId:'cs_test_refunded12345678'}),env,m.fetcher);
 assert.equal(response.status,403);assert.equal(m.purchases.length,0);
});
test('refund revokes entitlement and admin endpoints are server-restricted',async()=>{
 const m=mock();const checkout=await body(await handle(req('/api/checkout/start','POST',{}),env,m.fetcher));
 await handle(signedWebhook({id:'evt_paid',type:'checkout.session.completed',data:{object:session(new URL(checkout.checkoutUrl).searchParams.get('client_reference_id'))}}),env,m.fetcher);
 const noAdmin=await handle(req('/api/admin/reports'),env,m.fetcher);assert.equal(noAdmin.status,403);
 const refund=await handle(signedWebhook({id:'evt_refund',type:'charge.refunded',data:{object:{payment_intent:'pi_abc'}}}),env,m.fetcher);
 assert.equal(refund.status,200);assert.equal(m.purchases[0].status,'refunded');
 assert.equal((await body(await handle(req('/api/activation?device_id='+device),env,m.fetcher))).active,false);
});
