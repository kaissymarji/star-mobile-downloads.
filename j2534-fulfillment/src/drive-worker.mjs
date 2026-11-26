// Keep account credentials and the Drive URL in Worker secrets, outside source.
import { pdt, verifiedPayment } from "./worker.mjs";

const TTL = 24 * 60 * 60;
const encoder = new TextEncoder();
const TX = /^[A-Z0-9]{10,32}$/;
const CHECKOUT = /^https:\/\/www\.paypal\.com\/ncp\/payment\/[A-Z0-9]{13}$/;
const DRIVE = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}\/view(?:\?usp=(?:drivesdk|sharing|drive_link))?$/;
const REQUIRED = ["PAYPAL_PDT_TOKEN", "PAYPAL_MERCHANT_ID", "PAYPAL_ITEM_NAME", "DOWNLOAD_SECRET", "PAYPAL_CHECKOUT_URL", "DRIVE_DOWNLOAD_URL"];

function configured(env) {
  return REQUIRED.every(key => typeof env[key] === "string" && !!env[key].trim()) &&
    env.DOWNLOAD_SECRET.trim().length >= 32 &&
    env.PAYPAL_CHECKOUT_URL === env.PAYPAL_CHECKOUT_URL.trim() && CHECKOUT.test(env.PAYPAL_CHECKOUT_URL) &&
    !!driveDestination(env.DRIVE_DOWNLOAD_URL);
}
function driveDestination(value) {
  if (typeof value !== "string" || value !== value.trim() || !DRIVE.test(value)) return null;
  const url = new URL(value);
  url.search = "";
  return url.href;
}
function validPayment(data, tx, env) {return verifiedPayment(data, tx, env) && data.quantity === "1";}
function response(body, status = 200, headers = {}) {
  return new Response(body, {status, headers: {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  }});
}
function html(title, content, status = 200) {
  return response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{font:16px system-ui;max-width:36rem;margin:auto;padding:2rem;line-height:1.5}label,input{display:block;margin:.6rem 0}input{font:inherit;padding:.6rem;max-width:95%}button,a{font:inherit}button{padding:.6rem 1rem}a{color:#0757a6}</style></head><body><h1>' + title + '</h1>' + content + '</body></html>', status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}
function redirect(location) {return response(null, 303, {Location: location});}
function email(value) {return String(value || "").trim().toLowerCase();}
function paymentDenied() {
  return html("Payment not verified", "<p>We could not verify this completed ISO purchase. If you paid, do not pay again.</p><p><a href='/recover'>Recover your purchase</a></p>", 403);
}
function recoverForm() {
  return html("Recover your ISO purchase", "<p>Use the transaction ID and PayPal email from your receipt. Do not pay again.</p><form method='post' action='/recover'><label>PayPal transaction ID<input name='tx' required maxlength='32' autocomplete='off'></label><label>PayPal email<input name='email' type='email' required maxlength='254' autocomplete='email'></label><button>Verify purchase</button></form>");
}
async function key(env) {
  return crypto.subtle.importKey("raw", encoder.encode(env.DOWNLOAD_SECRET), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
}
function hex(bytes) {return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");}
async function issue(tx, env, now) {
  const payload = tx + "." + (Math.floor(now() / 1000) + TTL);
  const signature = await crypto.subtle.sign("HMAC", await key(env), encoder.encode(payload));
  return payload + "." + hex(signature);
}
async function verify(token, env, now) {
  const match = /^([A-Z0-9]{10,32})\.([1-9]\d{9,10})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const current = Math.floor(now() / 1000);
  const expires = Number(match[2]);
  if (!Number.isSafeInteger(expires) || expires <= current || expires > current + TTL) return null;
  const signature = Uint8Array.from(match[3].match(/../g), value => parseInt(value, 16));
  const valid = await crypto.subtle.verify("HMAC", await key(env), signature, encoder.encode(match[1] + "." + match[2]));
  return valid ? match[1] : null;
}
async function boundedForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers.get("Content-Type") || "")) return null;
  const declared = req.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {await reader.cancel(); return null;}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

export function createDriveWorker({fetcher = fetch, now = Date.now} = {}) {
  async function claim(tx, payerEmail, env) {
    if (!TX.test(tx || "")) return paymentDenied();
    const data = await pdt(tx, env, fetcher);
    if (!validPayment(data, tx, env) || (payerEmail !== null && email(payerEmail) !== email(data.payer_email))) return paymentDenied();
    return redirect("/ready/" + await issue(tx, env, now));
  }
  return {async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const isConfigured = configured(env);
      if (req.method === "GET" && url.pathname === "/health") {
        return response(JSON.stringify({ok: true, configured: isConfigured, enabled: env.ENABLED === "true" && isConfigured}), 200, {"Content-Type": "application/json"});
      }
      if (env.ENABLED !== "true" || !isConfigured) return html("Delivery not available", "<p>Automatic delivery is not activated. Please do not pay yet.</p>", 503);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/checkout")) {
        return html("Subaru flasher — $100 USD", "<p>J2534 July 2024 ISO with calibration files.</p><p><a href='" + env.PAYPAL_CHECKOUT_URL + "' rel='noreferrer'>Pay $100 with PayPal</a></p><p>After payment, return here to receive your download.</p><p><a href='/recover'>Already paid? Recover your purchase</a></p>");
      }
      if (req.method === "GET" && url.pathname === "/return") {
        if (url.searchParams.getAll("tx").length !== 1) return paymentDenied();
        return await claim(url.searchParams.get("tx"), null, env);
      }
      if (req.method === "GET" && url.pathname === "/recover") return recoverForm();
      if (req.method === "POST" && url.pathname === "/recover") {
        const origin = req.headers.get("Origin");
        if (origin !== null && origin !== url.origin) return response("Invalid recovery origin", 403);
        const form = await boundedForm(req);
        if (!form || form.getAll("tx").length !== 1 || form.getAll("email").length !== 1 || !email(form.get("email")) || email(form.get("email")).length > 254) return response("Invalid recovery request", 400);
        return await claim(form.get("tx"), form.get("email"), env);
      }
      if (req.method === "GET" && url.pathname.startsWith("/ready/")) {
        const token = url.pathname.slice(7);
        if (!await verify(token, env, now)) return html("Download link expired", "<p><a href='/recover'>Recover your purchase</a></p>", 403);
        return html("Payment verified", "<p>Your ISO download is ready. This link expires in 24 hours.</p><p><a href='/download/" + token + "' rel='noreferrer'>Download J2534 July 2024 ISO (2.73 GB)</a></p><p><a href='/recover'>Recover your purchase later</a></p>");
      }
      if (req.method === "GET" && url.pathname.startsWith("/download/")) {
        const tx = await verify(url.pathname.slice(10), env, now);
        if (!tx) return response("Expired or invalid download link", 403);
        // Recheck payment status before revealing the configured Drive destination.
        if (!validPayment(await pdt(tx, env, fetcher), tx, env)) return paymentDenied();
        return redirect(driveDestination(env.DRIVE_DOWNLOAD_URL));
      }
      return response("Not found", 404);
    } catch {
      return html("Temporarily unavailable", "<p>Please try again. If you already paid, do not pay again.</p><p><a href='/recover'>Recover your purchase</a></p>", 503);
    }
  }};
}

export default createDriveWorker();
