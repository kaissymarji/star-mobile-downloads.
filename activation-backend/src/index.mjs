/**
 * V200 Tech Activation / Statistics API — Cloudflare Worker.
 * This is the ONLY component allowed to hold Supabase secret keys,
 * Stripe webhook signing secrets, Stripe API credentials or license HMAC keys.
 * A checkout redirect or claimed payment screenshot NEVER grants entitlements.
 */
import {deviceHash,validDeviceId,safeTrialDecision} from './trial.mjs';
import {guestTrialRoute} from './guest-trial.mjs';
const enc=new TextEncoder();
const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const PAYMENT_CENTS=500, CURRENCY='usd';
const GITHUB_REPO='kaissymarji/star-mobile-downloads.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE=/^[a-z0-9_-]{12,90}$/i;
const SESSION=/^cs_(test|live)_[A-Za-z0-9]{8,240}$/;

export function allowedOrigin(request,env){
  const origin=request.headers.get('Origin')||'';
  const origins=(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  return origins.includes(origin)?origin:'';
}
function headersFor(origin){return {...jsonHeaders,...(origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})};}
function reply(payload,status=200,origin=''){return new Response(JSON.stringify(payload),{status,headers:headersFor(origin)});}
function httpError(code,message){return Object.assign(new Error(message),{status:code});}
function required(env,keys){for(const key of keys)if(!env[key])throw httpError(503,`Service configuration missing: ${key}`);}
function secureUrl(raw){const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)throw httpError(503,'Invalid backend URL configuration');return url;}
async function parseJson(request,max=16_384){
  if(Number(request.headers.get('content-length')||0)>max)throw httpError(413,'Request is too large');
  const raw=await request.text();if(raw.length>max)throw httpError(413,'Request is too large');
  try{return raw?JSON.parse(raw):{};}catch{throw httpError(400,'Invalid JSON');}
}
function tokenFrom(request){const auth=request.headers.get('Authorization')||'';const value=/^Bearer ([\w.-]+)$/.exec(auth);if(!value)throw httpError(401,'Sign in required');return value[1];}
export async function authenticate(request,env,fetcher=fetch){
  required(env,['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY']);
  const token=tokenFrom(request);
  const base=secureUrl(env.SUPABASE_URL).origin;
  const res=await fetcher(base+'/auth/v1/user',{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+token,Accept:'application/json'}});
  if(!res.ok)throw httpError(401,'Your session is invalid or expired. Sign in again.');
  const user=await res.json();
  if(!UUID.test(user.id||'')||!user.email||!user.email_confirmed_at)throw httpError(403,'A confirmed email account is required');
  return user;
}
async function adminRest(env,method,path,body,options={},fetcher=fetch){
  required(env,['SUPABASE_URL','SUPABASE_SECRET_KEY']);
  const root=secureUrl(env.SUPABASE_URL).origin+'/rest/v1/';
  const headers={apikey:env.SUPABASE_SECRET_KEY,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...(options.prefer?{'Prefer':options.prefer}:{})};
  const res=await fetcher(root+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  if(!res.ok){
    const text=(await res.text()).slice(0,350);
    // No secret values, bearer tokens or customer data in error text.
    throw httpError(502,'Database request failed ('+res.status+'): '+text.replace(/[\r\n]/g,' '));
  }
  if(options.count)return Number(res.headers.get('content-range')?.split('/')?.[1]||0);
  if(res.status===204)return [];
  const text=await res.text();return text?JSON.parse(text):[];
}
const eq=value=>encodeURIComponent(String(value));
function userId(user){if(!UUID.test(user.id))throw httpError(401,'Invalid user identity');return user.id;}
async function findPaid(env,id,fetcher){
  const rows=await adminRest(env,'GET','purchases?select=id&user_id=eq.'+eq(id)+'&status=eq.paid&limit=1',undefined,{},fetcher);
  return rows.length>0;
}
function paymentLinkUrl(env,reference){
  required(env,['STRIPE_PAYMENT_LINK_URL','STRIPE_PAYMENT_LINK_ID']);
  const url=secureUrl(env.STRIPE_PAYMENT_LINK_URL);
  if(url.hostname!=='buy.stripe.com')throw httpError(503,'Payment URL must be hosted by Stripe');
  url.searchParams.set('client_reference_id',reference);
  return url.toString();
}
function hexToBytes(str){if(!/^(?:[0-9a-f]{2})+$/i.test(str))return null;const bytes=new Uint8Array(str.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(str.slice(i*2,i*2+2),16);return bytes;}
function keyBytes(secret){return enc.encode(secret);}
async function hmacKey(secret){return crypto.subtle.importKey('raw',keyBytes(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
/** Exact raw-body signature verification, timestamp tolerance and constant-time crypto verify. */
export async function verifyStripeSignature(raw,signature,secret,now=Math.floor(Date.now()/1000)){
  if(!secret||!signature||typeof raw!=='string')return false;
  const parts=Object.create(null);
  for(const item of signature.split(',')){
    const i=item.indexOf('=');if(i>0){const k=item.slice(0,i).trim();(parts[k]??=[]).push(item.slice(i+1).trim());}
  }
  const t=Number(parts.t?.[0]);if(!Number.isSafeInteger(t)||Math.abs(now-t)>300)return false;
  const signed=enc.encode(t+'.'+raw);const key=await hmacKey(secret);
  for(const hex of parts.v1||[]){const bytes=hexToBytes(hex);if(bytes?.length===32&&await crypto.subtle.verify('HMAC',key,bytes,signed))return true;}
  return false;
}
function base32(bytes){const letters='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let bits=0,buffer=0,out='';for(const b of bytes){buffer=(buffer<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=letters[(buffer>>bits)&31];buffer&=(1<<bits)-1;}}return out;}
/** Deterministic per-user/per-device code. Never store the shared signing key in clients. */
export async function activationCode(secret,user,device){
  if(!secret||!UUID.test(user)||!DEVICE.test(device))throw httpError(400,'Invalid activation input');
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),enc.encode('V200:license:v1:'+user+':'+device)));
  const chars=base32(digest.slice(0,9)).slice(0,12);
  return 'V2-'+chars.slice(0,4)+'-'+chars.slice(4,8)+'-'+chars.slice(8,12);
}
function equalCode(a,b){if(typeof a!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function validatePayment(session,env){
  if(!session||typeof session!=='object')return false;
  const linked=typeof session.payment_link==='string'?session.payment_link:session.payment_link?.id;
  const subtotal=Number(session.amount_subtotal);
  return session.mode==='payment'&&session.payment_status==='paid'&&linked===env.STRIPE_PAYMENT_LINK_ID&&session.currency===CURRENCY&&subtotal===PAYMENT_CENTS&&Number(session.amount_total)>=PAYMENT_CENTS&&typeof session.id==='string'&&session.id.startsWith('cs_');
}
async function recordPaidSession(session,eventId,env,intent,fetcher){
  const data={user_id:intent.user_id,checkout_intent_id:intent.id,stripe_session_id:session.id,
    stripe_payment_intent:typeof session.payment_intent==='string'?session.payment_intent:null,
    stripe_payment_link:env.STRIPE_PAYMENT_LINK_ID,amount_total:session.amount_total,currency:session.currency,status:'paid',stripe_event_id:eventId};
  const saved=await adminRest(env,'POST','purchases?on_conflict=stripe_session_id',[data],{prefer:'resolution=ignore-duplicates,return=representation'},fetcher);
  // Never change ownership of an existing session: if same ID was previously linked, keep original.
  await adminRest(env,'PATCH','checkout_intents?client_reference=eq.'+eq(intent.client_reference),{status:'completed',processed_at:new Date().toISOString()}, {prefer:'return=minimal'},fetcher);
  return saved;
}
async function findIntent(env,reference,fetcher){
  if(!/^[A-Za-z0-9_-]{20,80}$/.test(reference||''))return null;
  const rows=await adminRest(env,'GET','checkout_intents?select=id,user_id,client_reference,status,created_at&client_reference=eq.'+eq(reference)+'&limit=1',undefined,{},fetcher);
  return rows[0]||null;
}
async function stripeGetSession(env,id,fetcher){
  required(env,['STRIPE_SECRET_KEY']);
  if(!SESSION.test(id))throw httpError(400,'Invalid checkout session ID');
  const res=await fetcher('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY}});
  if(!res.ok)throw httpError(res.status===404?404:502,'Unable to verify that Checkout Session at Stripe.');
  return res.json();
}
/** Recheck earlier payments against Stripe before restoring a purchase. A Checkout
 * Session can still say 'paid' after its charge has been refunded or disputed.
 * Fail closed on Stripe API failure or a non-expanded charge.
 */
async function verifyUnrefundedPaymentIntent(env,id,fetcher){
  required(env,['STRIPE_SECRET_KEY']);
  if(!/^pi_[A-Za-z0-9]{3,160}$/.test(id||''))throw httpError(403,'Payment intent is missing or invalid');
  const url='https://api.stripe.com/v1/payment_intents/'+encodeURIComponent(id)+'?expand%5B%5D=latest_charge';
  const response=await fetcher(url,{headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY}});
  if(!response.ok)throw httpError(502,'Could not check the current Stripe payment status');
  const pi=await response.json(),charge=pi.latest_charge;
  if(pi.status!=='succeeded'||pi.currency!==CURRENCY||Number(pi.amount_received)<PAYMENT_CENTS||
     !charge||typeof charge!=='object'||charge.paid!==true||charge.refunded===true||
     charge.disputed===true||Number(charge.amount_refunded||0)>0){
    throw httpError(403,'This payment is not currently eligible for activation');
  }
}
async function stripeWebhook(request,env,fetcher){
  required(env,['STRIPE_WEBHOOK_SECRET','STRIPE_PAYMENT_LINK_ID','SUPABASE_SECRET_KEY']);
  const raw=await request.text();if(raw.length>1_000_000)throw httpError(413,'Event too large');
  const ok=await verifyStripeSignature(raw,request.headers.get('Stripe-Signature'),env.STRIPE_WEBHOOK_SECRET);
  if(!ok)throw httpError(400,'Invalid Stripe signature');
  let event;try{event=JSON.parse(raw);}catch{throw httpError(400,'Invalid event payload');}
  const obj=event.data?.object;if(!obj||!event.id)throw httpError(400,'Missing event data');
  const paid=['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type);
  if(paid&&obj.payment_status==='paid'){
    if(!validatePayment(obj,env))return {received:true,fulfilled:false,reason:'product_not_verified'};
    const intent=await findIntent(env,obj.client_reference_id,fetcher);
    if(!intent)return {received:true,fulfilled:false,reason:'unlinked_payment_requires_manual_claim'};
    if(intent.status==='failed')return {received:true,fulfilled:false,reason:'intent_marked_failed'};
    await recordPaidSession(obj,event.id,env,intent,fetcher);
    return {received:true,fulfilled:true};
  }
  if(event.type==='checkout.session.async_payment_failed'&&obj.client_reference_id){
    const intent=await findIntent(env,obj.client_reference_id,fetcher);
    if(intent&&intent.status==='pending')await adminRest(env,'PATCH','checkout_intents?client_reference=eq.'+eq(intent.client_reference),{status:'failed',processed_at:new Date().toISOString()},{prefer:'return=minimal'},fetcher);
  }
  if(['charge.refunded','charge.dispute.created'].includes(event.type)){
    const pi=typeof obj.payment_intent==='string'?obj.payment_intent:null;
    if(pi){
      // Refunds and disputes revoke paid entitlement by payment_intent identifier.
      const status=event.type==='charge.refunded'?'refunded':'disputed';
      await adminRest(env,'PATCH','purchases?stripe_payment_intent=eq.'+eq(pi),{status},{prefer:'return=minimal'},fetcher);
    }
  }
  return {received:true,fulfilled:false};
}
async function adminProfile(env,id,fetcher){
  const rows=await adminRest(env,'GET','profiles?select=id,role&role=in.(admin,moderator)&id=eq.'+eq(id)+'&limit=1',undefined,{},fetcher);
  return rows[0]||null;
}
async function staff(request,env,fetcher){
  const user=await authenticate(request,env,fetcher);
  const staff=await adminProfile(env,user.id,fetcher);
  if(!staff)throw httpError(403,'Administrator access required');
  return {user,role:staff.role};
}
async function count(env,path,fetcher){
  return adminRest(env,'GET',path,undefined,{count:true,prefer:'count=exact'},fetcher);
}
async function metrics(env,fetcher){
  const day=new Date().toISOString().slice(0,10),ago=new Date(Date.now()-29*86400_000).toISOString().slice(0,10),now=new Date(Date.now()-120_000).toISOString();
  const [today,month,online,paid,reports,github]=await Promise.all([
    count(env,'app_activity?select=user_id&activity_date=eq.'+day,fetcher),
    count(env,'app_activity?select=user_id&activity_date=gte.'+ago,fetcher),
    count(env,'profiles?select=id&last_seen_at=gte.'+eq(now),fetcher),
    count(env,'purchases?select=id&status=eq.paid',fetcher),
    count(env,'reports?select=id&status=eq.open',fetcher),
    fetcher('https://api.github.com/repos/'+GITHUB_REPO+'/releases?per_page=100',{headers:{Accept:'application/vnd.github+json','User-Agent':'V200-Tech-Community'}}).then(async res=>{
      if(!res.ok)return null;const releases=await res.json();return releases.flatMap(r=>(r.assets||[]).filter(a=>/\.apk$/i.test(a.name))).reduce((n,a)=>n+Number(a.download_count||0),0);
    }).catch(()=>null)
  ]);
  return {activeToday:today,active30Days:month,recentOnline:online,paidActivations:paid,openReports:reports,githubDownloads:github,
    note:'Active counts are signed-in community accounts; raw APK downloads are not unique installs.'};
}
export async function handle(request,env,fetcher=fetch){
  const origin=allowedOrigin(request,env),url=new URL(request.url);
  if(request.method==='OPTIONS'){
    if(!origin)return new Response(null,{status:403});
    return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin'}});
  }
  try{
    if(url.pathname==='/health'&&request.method==='GET')return reply({ok:true,service:'v200-tech',configured:!!(env.SUPABASE_URL&&env.STRIPE_WEBHOOK_SECRET),guestTrialApi:true,guestTrialVersion:'1'},200,origin);
    if(url.pathname==='/api/stripe/webhook'&&request.method==='POST')return reply(await stripeWebhook(request,env,fetcher),200,'');
    // Browser requests from unknown Origin are rejected; curl/mobile clients still require JWT.
    if(request.headers.has('Origin')&&!origin)throw httpError(403,'Origin not permitted');
    // V200 guest Auto Scan is checked server-side; the first successful scan
    // starts a reserved trial, while subsequent Auto Scans require paid status.
    // Only service-role RPCs can read or change trial state.
    if(['/api/trial/authorize','/api/trial/start','/api/trial/end'].includes(url.pathname)&&request.method==='POST'){
      const user=await authenticate(request,env,fetcher);
      const input=await parseJson(request,1024);
      if(!validDeviceId(input.deviceId))throw httpError(400,'Invalid device ID');
      required(env,['ACTIVATION_HMAC_KEY']);
      const hash=await deviceHash(env.ACTIVATION_HMAC_KEY,input.deviceId);
      if(await findPaid(env,userId(user),fetcher))return reply({permitted:true,mode:'paid',active:true},200,origin);
      const rpc=url.pathname==='/api/trial/authorize'?'v200_trial_authorize':
        url.pathname==='/api/trial/start'?'v200_trial_start':'v200_trial_finish';
      const raw=await adminRest(env,'POST','rpc/'+rpc,{p_hash:hash,p_owner:user.id},{},fetcher);
      const decision=safeTrialDecision(raw);
      if(url.pathname==='/api/trial/authorize')return reply({permitted:decision.permitted===true,mode:decision.permitted?'trial':'none',state:decision.state},200,origin);
      if(url.pathname==='/api/trial/start')return reply({started:decision.started===true,state:decision.state},200,origin);
      return reply({finished:decision.finished===true,state:decision.state},200,origin);
    }
    if(url.pathname.startsWith('/api/trial/guest/')){
      return await guestTrialRoute(request,env,{authenticate,adminRest,reply,parseJson,fetcher,findPaid,required,httpError,
        deviceHash,validDeviceId,safeTrialDecision,origin});
    }
    if(url.pathname==='/api/checkout/start'&&request.method==='POST'){
      required(env,['STRIPE_PAYMENT_LINK_ID','STRIPE_PAYMENT_LINK_URL']);
      const user=await authenticate(request,env,fetcher);userId(user);
      if(await findPaid(env,user.id,fetcher))return reply({error:'This account already has a verified purchase.'},409,origin);
      const reference=crypto.randomUUID().replace(/-/g,'');
      await adminRest(env,'POST','checkout_intents',[{user_id:user.id,client_reference:reference}],{prefer:'return=representation'},fetcher);
      return reply({checkoutUrl:paymentLinkUrl(env,reference)},200,origin);
    }
    if(url.pathname==='/api/activation'&&request.method==='GET'){
      const user=await authenticate(request,env,fetcher);const device=url.searchParams.get('device_id')||'';
      if(!DEVICE.test(device))throw httpError(400,'A stable device identifier is required');
      const paid=await findPaid(env,userId(user),fetcher);
      if(!paid)return reply({active:false,code:null},200,origin);
      let code=null;
      if(url.searchParams.get('reveal')==='1'){
        required(env,['ACTIVATION_HMAC_KEY']);code=await activationCode(env.ACTIVATION_HMAC_KEY,user.id,device);
      }
      return reply({active:true,code,deviceSpecific:true},200,origin);
    }
    if(url.pathname==='/api/license/check'&&request.method==='POST'){
      const user=await authenticate(request,env,fetcher),data=await parseJson(request);
      required(env,['ACTIVATION_HMAC_KEY']);
      if(!DEVICE.test(data.deviceId)||typeof data.code!=='string')throw httpError(400,'Invalid code or device ID');
      const paid=await findPaid(env,userId(user),fetcher);
      const expected=await activationCode(env.ACTIVATION_HMAC_KEY,user.id,data.deviceId);
      return reply({valid:paid&&equalCode(data.code,expected)},200,origin);
    }
    if(url.pathname==='/api/claim-previous'&&request.method==='POST'){
      const user=await authenticate(request,env,fetcher),data=await parseJson(request);
      const session=await stripeGetSession(env,data.sessionId,fetcher);
      if(!validatePayment(session,env))throw httpError(403,'Payment cannot be verified for this activation link');
      if((session.customer_details?.email||'').toLowerCase()!==user.email.toLowerCase())throw httpError(403,'Checkout email does not match this verified account');
      await verifyUnrefundedPaymentIntent(env,session.payment_intent,fetcher);
      const existing=await adminRest(env,'GET','purchases?select=id,user_id&stripe_session_id=eq.'+eq(session.id),undefined,{},fetcher);
      if(existing.length){if(existing[0].user_id!==user.id)throw httpError(409,'Payment already assigned to another account');return reply({claimed:true,alreadyLinked:true},200,origin);}
      const ref=await findIntent(env,session.client_reference_id,fetcher);
      if(ref&&ref.user_id!==user.id)throw httpError(409,'Payment belongs to another checkout account');
      await adminRest(env,'POST','purchases?on_conflict=stripe_session_id',[{user_id:user.id,checkout_intent_id:ref?.id||null,
        stripe_session_id:session.id,stripe_payment_intent:typeof session.payment_intent==='string'?session.payment_intent:null,
        stripe_payment_link:env.STRIPE_PAYMENT_LINK_ID,amount_total:session.amount_total,currency:session.currency,status:'paid',stripe_event_id:'claimed_after_stripe_verification'}],{prefer:'resolution=ignore-duplicates,return=representation'},fetcher);
      return reply({claimed:true},200,origin);
    }
    if(url.pathname==='/api/activity'&&request.method==='POST'){
      const user=await authenticate(request,env,fetcher),data=await parseJson(request);
      const source=data.source==='android'?'android':'community';
      const day=new Date().toISOString().slice(0,10);
      await adminRest(env,'POST','app_activity?on_conflict=user_id,activity_date',[{user_id:user.id,activity_date:day,source,updated_at:new Date().toISOString()}],{prefer:'resolution=merge-duplicates,return=minimal'},fetcher);
      await adminRest(env,'PATCH','profiles?id=eq.'+eq(user.id),{last_seen_at:new Date().toISOString()},{prefer:'return=minimal'},fetcher);
      return reply({recorded:true},200,origin);
    }
    if(url.pathname==='/api/admin/metrics'&&request.method==='GET'){
      await staff(request,env,fetcher);return reply(await metrics(env,fetcher),200,origin);
    }
    if(url.pathname==='/api/admin/reports'&&request.method==='GET'){
      await staff(request,env,fetcher);
      const rows=await adminRest(env,'GET','reports?select=id,target_type,target_id,reason,created_at&status=eq.open&order=created_at.desc&limit=100',undefined,{},fetcher);
      return reply({reports:rows},200,origin);
    }
    if(url.pathname==='/api/admin/report/resolve'&&request.method==='POST'){
      await staff(request,env,fetcher);const data=await parseJson(request);
      if(!UUID.test(data.id||''))throw httpError(400,'Invalid report ID');
      await adminRest(env,'PATCH','reports?id=eq.'+eq(data.id),{status:'resolved',resolved_at:new Date().toISOString()},{prefer:'return=minimal'},fetcher);
      return reply({resolved:true},200,origin);
    }
    if(url.pathname==='/api/admin/moderate'&&request.method==='POST'){
      await staff(request,env,fetcher);const data=await parseJson(request);
      if(!UUID.test(data.id||'')||data.hidden!==true||!['post','comment','chat'].includes(data.type))throw httpError(400,'Invalid moderation request');
      const table=({post:'posts',comment:'comments',chat:'chat_messages'})[data.type];
      await adminRest(env,'PATCH',table+'?id=eq.'+eq(data.id),{is_hidden:true},{prefer:'return=minimal'},fetcher);
      return reply({hidden:true},200,origin);
    }
    return reply({error:'Not found'},404,origin);
  }catch(err){
    const status=Number(err.status)||500;
    if(status>=500)console.error('V200 backend request failed:',status,err.message);
    // Avoid exposing DB errors, tokens, secrets or email addresses in 5xx responses.
    return reply({error:status>=500?'Service temporarily unavailable':err.message},status,origin);
  }
}
export default {fetch(request,env){return handle(request,env);}};
