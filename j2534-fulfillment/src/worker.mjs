// Isolated ISO delivery. No public Drive URL or PayPal secrets in source.
const PRICE = "100.00";
const MAX_SALES = 3;
const FILE = "J2534_July2024.iso";
const FILE_BYTES = 2732261376;
const DOWNLOAD_TTL = 24 * 60 * 60;
const enc = new TextEncoder();
const secretKeys = ["PAYPAL_PDT_TOKEN", "PAYPAL_MERCHANT_ID", "PAYPAL_ITEM_NAME", "DOWNLOAD_SECRET"];
function ready(env) {
  return env.ENABLED === "true" && secretKeys.every(k => !!env[k]) &&
    env.DOWNLOAD_SECRET.length >= 32 && !!env.SALES && !!env.ISO;
}
function response(body, status = 200, headers = {}) {
  return new Response(body, {status, headers: {"Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff", ...headers}});
}
function html(title, content, status=200) {
  return response('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><style>body{font:16px system-ui;max-width:36rem;padding:2rem;margin:auto}label,input{display:block;margin:.6rem 0}input,button,a{font:inherit}input{padding:.6rem;width:90%}button,a{color:#0757a6}small{color:#555}</style><h1>'+title+'</h1>'+content+'</html>',status,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
}
function validTx(tx) {return typeof tx === "string" && /^[A-Z0-9]{10,32}$/.test(tx);}
function cleanEmail(email) {return String(email||"").trim().toLowerCase();}
export function parsePdt(body) {
  if(typeof body!=="string") return null;
  const lines=body.trim().split(/\r?\n/);
  if(lines.shift()!=="SUCCESS") return null;
  const data={};
  for(const l of lines) {
    const i=l.indexOf("=");
    if(i<1) continue;
    let key,val;
    try {
      [key,val]=[l.slice(0,i),l.slice(i+1)].map(x=>decodeURIComponent(x.replace(/\+/g," ")));
    } catch {return null;}
    if(Object.prototype.hasOwnProperty.call(data,key)) return null;
    data[key]=val;
  }
  return data;
}
export function verifiedPayment(data, tx, env) {
  return !!data && typeof env?.PAYPAL_MERCHANT_ID==="string" && !!env.PAYPAL_MERCHANT_ID.trim() &&
    typeof env.PAYPAL_ITEM_NAME==="string" && !!env.PAYPAL_ITEM_NAME.trim() &&
    validTx(tx) && data.txn_id===tx &&
    data.payment_status==="Completed" && data.mc_currency==="USD" &&
    /^(100|100\.0|100\.00)$/.test(data.mc_gross||"") &&
    data.receiver_id===env.PAYPAL_MERCHANT_ID &&
    data.item_name===env.PAYPAL_ITEM_NAME &&
    (!env.PAYPAL_ITEM_NUMBER || data.item_number===env.PAYPAL_ITEM_NUMBER) &&
    (!data.quantity || data.quantity==="1") &&
    !!cleanEmail(data.payer_email);
}
export async function pdt(tx, env, fetcher=fetch) {
  if(!validTx(tx) || typeof env?.PAYPAL_PDT_TOKEN!=="string" || !env.PAYPAL_PDT_TOKEN.trim()) throw Error("Invalid PayPal verification configuration");
  const res=await fetcher("https://www.paypal.com/cgi-bin/webscr",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({cmd:"_notify-synch",tx,at:env.PAYPAL_PDT_TOKEN}),redirect:"manual"
  });
  // Workers supports manual redirects. Never follow a redirect with the PDT token.
  if(res.status>=300 && res.status<400) throw Error("Unexpected PayPal redirect");
  if(res.status!==200) throw Error("PayPal unavailable");
  return parsePdt(await res.text());
}
async function hmacKey(env) {return crypto.subtle.importKey("raw",enc.encode(env.DOWNLOAD_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);}
function hex(bytes) {return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,"0")).join("");}
function fromHex(s) {return Uint8Array.from(s.match(/../g).map(x=>parseInt(x,16)));}
async function issue(tx,env) {
  const expiry=Math.floor(Date.now()/1000)+DOWNLOAD_TTL;
  const payload=tx+"."+expiry;
  const mac=hex(await crypto.subtle.sign("HMAC",await hmacKey(env),enc.encode(payload)));
  return payload+"."+mac;
}
async function checkToken(token,env) {
  const m=/^([A-Z0-9]{10,32})\.(\d{10})\.([a-f0-9]{64})$/.exec(token);
  if(!m || Number(m[2])<Math.floor(Date.now()/1000)) return null;
  const ok=await crypto.subtle.verify("HMAC",await hmacKey(env),fromHex(m[3]),enc.encode(m[1]+"."+m[2]));
  return ok?m[1]:null;
}
async function record(tx,env) {
  // Single atomic statement: repeated requests for the same sale do not consume inventory.
  await env.SALES.prepare("INSERT OR IGNORE INTO sales(tx, created_at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM sales) < ?").bind(tx,Date.now(),MAX_SALES).run();
  return await env.SALES.prepare("SELECT tx FROM sales WHERE tx = ?").bind(tx).first();
}
async function claim(tx,email,env) {
  if(!validTx(tx)) return html("Verify your purchase","<p>Enter the transaction ID from your PayPal receipt.</p><a href='/recover'>Recover purchase</a>",400);
  const data=await pdt(tx,env);
  if(!verifiedPayment(data,tx,env) || (email!==null && cleanEmail(email)!==cleanEmail(data.payer_email))) {
    return html("Payment not verified","<p>We could not confirm this completed ISO purchase. Do not pay again. Check your receipt or contact support.</p><a href='/recover'>Try again</a>",403);
  }
  const object=await env.ISO.head(FILE);
  if(!object || object.size!==FILE_BYTES) return html("Download temporarily unavailable","<p>Your payment was received. The file is not ready. Do not pay again; try recovery later or contact support.</p>",503);
  if(!await record(tx,env)) return html("Contact support","<p>The three-copy fulfillment limit was reached. Please contact the seller with your payment receipt. Do not pay again.</p>",409);
  const token=await issue(tx,env);
  return response(null,303,{"Location":"/ready/"+token});
}
function recoverForm() {
  return html("Recover ISO purchase","<p>Use the PayPal transaction ID and email from your receipt. Do not pay again.</p><form method='post' action='/recover'><label>Transaction ID<input name='tx' required maxlength='32' autocomplete='off'></label><label>PayPal email<input type='email' name='email' required maxlength='254'></label><button>Verify and download</button></form>");
}
async function download(req,env,tx) {
  if(!await env.SALES.prepare("SELECT tx FROM sales WHERE tx = ?").bind(tx).first()) return response("Not authorized",403);
  const meta=await env.ISO.head(FILE);
  if(!meta || meta.size!==FILE_BYTES) return response("File unavailable",503);
  const headers={"Content-Type":"application/octet-stream","Content-Disposition":'attachment; filename="'+FILE+'"',"Accept-Ranges":"bytes","Cache-Control":"private, no-store","ETag":meta.httpEtag};
  if(req.method==="HEAD") return response(null,200,{...headers,"Content-Length":String(meta.size)});
  let range;
  const raw=req.headers.get("Range");
  if(raw) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(raw);
    if(!m || (!m[1]&&!m[2])) return response(null,416,{"Content-Range":"bytes */"+meta.size});
    let start,end;
    if(!m[1]) {
      const n=Number(m[2]); if(!Number.isSafeInteger(n)||n<=0)return response(null,416,{"Content-Range":"bytes */"+meta.size});
      start=Math.max(0,meta.size-n);end=meta.size-1;
    } else {
      start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),meta.size-1):meta.size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=meta.size||end<start)return response(null,416,{"Content-Range":"bytes */"+meta.size});
    }
    range={offset:start,length:end-start+1};
    headers["Content-Range"]="bytes "+start+"-"+end+"/"+meta.size;
    headers["Content-Length"]=String(range.length);
  } else headers["Content-Length"]=String(meta.size);
  const obj=await env.ISO.get(FILE,range?{range}:undefined);
  if(!obj) return response("File unavailable",503);
  return response(obj.body,range?206:200,headers);
}
export default {async fetch(req,env) {
  const u=new URL(req.url);
  try {
    if(req.method==="GET"&&u.pathname==="/health") {
      const meta=env.ISO?await env.ISO.head(FILE):null;
      return response(JSON.stringify({ok:true,enabled:ready(env),fileReady:meta?.size===FILE_BYTES}),200,{"Content-Type":"application/json"});
    }
    if(!ready(env)) return html("Checkout not open","<p>Delivery is not activated. Please do not pay yet.</p>",503);
    if(req.method==="GET"&&u.pathname==="/recover")return recoverForm();
    if(req.method==="POST"&&u.pathname==="/recover"){
      const len=Number(req.headers.get("Content-Length")||0);
      if(len>2048)return response("Invalid request",400);
      const form=new URLSearchParams(await req.text());
      if(!cleanEmail(form.get("email")))return response("Email required",400);
      return await claim(form.get("tx"),form.get("email"),env);
    }
    if(req.method==="GET"&&u.pathname==="/return")return await claim(u.searchParams.get("tx"),null,env);
    if(req.method==="GET"&&u.pathname.startsWith("/ready/")){
      const token=u.pathname.slice(7);if(!await checkToken(token,env))return html("Link expired","<a href='/recover'>Recover your purchase</a>",403);
      return html("Payment verified","<p>Your ISO is ready. This link expires in 24 hours.</p><a href='/download/"+token+"' download>Download J2534 July 2024 ISO (2.73 GB)</a><p><small>You can recover your purchase later with your PayPal receipt.</small></p>");
    }
    if(["GET","HEAD"].includes(req.method)&&u.pathname.startsWith("/download/")){
      const tx=await checkToken(u.pathname.slice(10),env);if(!tx)return response("Expired or invalid download link",403);
      return await download(req,env,tx);
    }
    return response("Not found",404);
  } catch {return html("Temporarily unavailable","<p>Please try again. If you paid, do not pay again.</p><a href='/recover'>Recover purchase</a>",503);}
}};

