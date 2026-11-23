const PAYPAL = {
  live: "https://www.paypal.com/cgi-bin/webscr",
  sandbox: "https://www.sandbox.paypal.com/cgi-bin/webscr",
};
const PAYPAL_ORDERS = {
  live: { api: "https://api-m.paypal.com", wallet: "https://www.paypal.com" },
  sandbox: { api: "https://api-m.sandbox.paypal.com", wallet: "https://www.sandbox.paypal.com" },
};
const PRODUCT_NAME = "FRM3 and JLR BCM Repair";
const PRODUCT_SKU = "FRM3_JLR_BCM_REPAIR";
const PRODUCT_AMOUNT = { currency_code: "USD", value: "100.00" };
const CHECKOUT_SECONDS = 45 * 60;
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILENAME = "FRM3 and JLR BCM Repair.exe";
const COOKIE_NAME = "__Host-frm3-download";
const LIFETIME_SECONDS = 10 * 60;
const ENCODE = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,127}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const BASE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

class PayPalRequestError extends Error {
  constructor(status) {
    super("PayPal request failed");
    this.status = status;
  }
}

function reply(value, status) {
  return new Response(value, { status, headers: BASE_HEADERS });
}

function paymentConfirmation() {
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayPal payment confirmation</title>
<main>
  <h1>Check your PayPal receipt</h1>
  <p>If your payment completed, PayPal will email a receipt. You can also sign in to PayPal to view the transaction.</p>
  <p><a href="https://kaissymarji.github.io/star-mobile-downloads./">Return to Star Mobile Service</a></p>
</main>
</html>`, {
    headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

function serviceAccount(value) {
  const account = JSON.parse(value);
  if (typeof account?.client_email !== "string" || !account.client_email.includes("@")
      || typeof account.private_key !== "string" || !account.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("Google service-account credentials are incomplete");
  }
  return account;
}

function driveReady(env) {
  if (env.DELIVERY_ENABLED !== "true" || !Object.hasOwn(PAYPAL, env.PAYPAL_ENVIRONMENT)
      || !ID.test(env.PAYPAL_MERCHANT_ID || "") || !ID.test(env.DELIVERY_FILE_ID || "")
      || !env.DOWNLOAD_CLAIMS) return false;
  try {
    serviceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return true;
  } catch {
    return false;
  }
}

function pdtReady(env) {
  return driveReady(env) && ID.test(env.PAYPAL_LINK_ID || "")
    && (!env.PAYPAL_PRODUCT_ITEM_NUMBER || ID.test(env.PAYPAL_PRODUCT_ITEM_NUMBER))
    && /^[^\s]{20,1024}$/.test(env.PAYPAL_PDT_IDENTITY_TOKEN || "");
}

function ordersReady(env) {
  if (env.PAYPAL_ORDERS_ENABLED !== "true" || !driveReady(env)
      || !/^[A-Za-z0-9_-]{20,160}$/.test(env.PAYPAL_CLIENT_ID || "")
      || !/^[A-Za-z0-9_-]{20,160}$/.test(env.PAYPAL_CLIENT_SECRET || "")
      || !KEY.test(env.CHECKOUT_STATE_SECRET || "")) return false;
  try {
    const origin = new URL(env.CHECKOUT_ORIGIN);
    return origin.protocol === "https:" && origin.origin === env.CHECKOUT_ORIGIN;
  } catch {
    return false;
  }
}

function parsePdt(message) {
  const [result, ...lines] = message.trimEnd().split(/\r?\n/);
  if (message.length > 64 * 1024 || result !== "SUCCESS") return null;
  const fields = new Map();
  for (const line of lines) {
    const equals = line.indexOf("=");
    if (equals < 1) return null;
    const key = line.slice(0, equals);
    if (fields.has(key)) return null;
    const encoded = line.slice(equals + 1).replaceAll("&", "%26");
    fields.set(key, new URLSearchParams("value=" + encoded).get("value"));
  }
  return fields;
}

function matchesPurchase(fields, tx, env) {
  if (fields?.get("txn_id") !== tx || fields.get("payment_status") !== "Completed"
      || fields.get("receiver_id") !== env.PAYPAL_MERCHANT_ID || fields.get("mc_currency") !== "USD"
      || !/^100(?:\.0{1,2})?$/.test(fields.get("mc_gross") || "")) return false;
  const hostedLinkIds = ["hosted_button_id", "payment_link_id"].filter(key => fields.has(key));
  if (hostedLinkIds.some(key => fields.get(key) !== env.PAYPAL_LINK_ID)) return false;

  const itemNumbers = new Set([fields.get("item_number"), fields.get("item_number1")].filter(Boolean));
  const expectedItemNumber = env.PAYPAL_PRODUCT_ITEM_NUMBER;
  if (itemNumbers.size > 1 || (expectedItemNumber && itemNumbers.size && !itemNumbers.has(expectedItemNumber))) {
    return false;
  }
  const verifiedProduct = hostedLinkIds.length > 0 || itemNumbers.has(expectedItemNumber);
  const quantities = ["quantity", "quantity1"].filter(key => fields.has(key));
  const otherItems = [...fields.keys()].some(key => {
    const index = /^(?:item_name|item_number|quantity)(\d+)$/.exec(key)?.[1];
    return index !== undefined && index !== "1";
  });
  return verifiedProduct && !otherItems
    && (!fields.has("num_cart_items") || fields.get("num_cart_items") === "1")
    && quantities.length > 0 && quantities.every(key => fields.get(key) === "1");
}

async function verifyPurchase(tx, env, fetcher) {
  const response = await fetcher(PAYPAL[env.PAYPAL_ENVIRONMENT], {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cmd: "_notify-synch", tx, at: env.PAYPAL_PDT_IDENTITY_TOKEN }),
  });
  if (!response.ok) throw new Error("PayPal verification unavailable");
  return matchesPurchase(parsePdt(await response.text()), tx, env);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function digest(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODE.encode(value))));
}

function cookieValue(request, name) {
  const prefix = name + "=";
  return request.headers.get("cookie")?.split(/;\s*/)
    .find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
}

function browserClaim(request) {
  const [purchase, token, extra] = (cookieValue(request, COOKIE_NAME) || "").split(".");
  return KEY.test(purchase) && KEY.test(token || "") && extra === undefined ? { purchase, token } : null;
}

async function claimState(env, purchase, action, payload) {
  const object = env.DOWNLOAD_CLAIMS.get(env.DOWNLOAD_CLAIMS.idFromName(purchase));
  const response = await object.fetch("https://internal/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 204) return true;
  if (response.status === 403) return false;
  throw new Error("Download state unavailable");
}

async function issueDownload(env, purchase, token) {
  if (!await claimState(env, purchase, "claim", { hash: await digest(token) })) {
    return reply("The download window for this transaction has expired or was opened in another browser. Please contact support with your PayPal receipt.", 403);
  }
  return new Response(null, {
    status: 303,
    headers: {
      ...BASE_HEADERS,
      location: "/download",
      "set-cookie": `${COOKIE_NAME}=${purchase}.${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${LIFETIME_SECONDS}`,
    },
  });
}

async function handleReturn(url, request, env, fetcher) {
  const transactions = url.searchParams.getAll("tx");
  const [tx] = transactions;
  if (transactions.length !== 1 || !ID.test(tx || "")) return reply("PayPal did not supply a transaction ID.", 400);
  if (!await verifyPurchase(tx, env, fetcher)) return reply("PayPal did not verify a completed purchase for this download.", 403);
  const purchase = await digest(env.PAYPAL_MERCHANT_ID + ":" + tx);
  const browser = browserClaim(request);
  const token = browser?.purchase === purchase ? browser.token : base64url(crypto.getRandomValues(new Uint8Array(32)));
  return issueDownload(env, purchase, token);
}

async function signingKey(env) {
  return crypto.subtle.importKey("raw", ENCODE.encode(env.CHECKOUT_STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signingData(env, purpose, ...claims) {
  return ENCODE.encode(JSON.stringify([
    "frm3-paypal-orders-v1", env.CHECKOUT_ORIGIN, env.PAYPAL_ENVIRONMENT,
    env.PAYPAL_MERCHANT_ID, PRODUCT_SKU, purpose, ...claims,
  ]));
}

async function signature(env, key, purpose, ...claims) {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, signingData(env, purpose, ...claims))));
}

async function signedByWorker(env, key, value, purpose, ...claims) {
  if (!KEY.test(value || "")) return false;
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  return base64url(bytes) === value
    && crypto.subtle.verify("HMAC", key, bytes, signingData(env, purpose, ...claims));
}

function checkoutCookieName(orderId) {
  return "__Host-frm3-checkout-" + orderId;
}

function checkoutPage(title, content, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | ${PRODUCT_NAME}</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;background:#f5f7fa;color:#152030;margin:0}main{max-width:38rem;padding:3rem 1.5rem;margin:auto}button{font:inherit;font-weight:600;background:#003087;color:white;border:0;border-radius:.4rem;padding:.65rem 1rem;cursor:pointer}</style>
<main><h1>${title}</h1>${content}</main>
</html>`, {
    status,
    headers: {
      ...BASE_HEADERS, "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}

async function paypalJson(fetcher, url, options) {
  const response = await fetcher(url, { ...options, redirect: "manual" });
  if (!response.ok) throw new PayPalRequestError(response.status);
  return response.json();
}

async function paypalHeaders(env, api, fetcher) {
  const token = await paypalJson(fetcher, api + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("PayPal access token missing");
  return { authorization: "Bearer " + token.access_token, "content-type": "application/json" };
}

async function startOrder(env, key, paypal, headers, fetcher) {
  const reference = crypto.randomUUID().replace(/-/g, "");
  const expires = String(Math.floor(Date.now() / 1000) + CHECKOUT_SECONDS);
  const state = [reference, expires, await signature(env, key, "state", reference, expires)].join(".");
  const returnUrl = new URL("/checkout/return", env.CHECKOUT_ORIGIN);
  returnUrl.searchParams.set("state", state);
  const order = await paypalJson(fetcher, paypal.api + "/v2/checkout/orders", {
    method: "POST",
    headers: { ...headers, "paypal-request-id": reference },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: reference,
        custom_id: PRODUCT_SKU,
        description: PRODUCT_NAME,
        payee: { merchant_id: env.PAYPAL_MERCHANT_ID },
        amount: { ...PRODUCT_AMOUNT, breakdown: { item_total: PRODUCT_AMOUNT } },
        items: [{ name: PRODUCT_NAME, sku: PRODUCT_SKU, unit_amount: PRODUCT_AMOUNT, quantity: "1", category: "DIGITAL_GOODS" }],
      }],
      payment_source: { paypal: { experience_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        return_url: returnUrl.href,
        cancel_url: new URL("/checkout", env.CHECKOUT_ORIGIN).href,
      } } },
    }),
  });
  const approval = (order.links || []).find(link => link.rel === "payer-action" || link.rel === "approve");
  if (!ID.test(order.id || "") || !approval?.href || !URL.canParse(approval.href)) {
    throw new Error("PayPal approval is missing");
  }
  const target = new URL(approval.href);
  if (target.origin !== paypal.wallet || target.username || target.password || target.pathname !== "/checkoutnow"
      || target.searchParams.getAll("token").length !== 1 || target.searchParams.get("token") !== order.id) {
    throw new Error("PayPal returned an unexpected approval link");
  }
  const cookie = await signature(env, key, "browser", state, order.id);
  return new Response(null, {
    status: 303,
    headers: {
      ...BASE_HEADERS, location: target.href,
      "set-cookie": `${checkoutCookieName(order.id)}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CHECKOUT_SECONDS}`,
    },
  });
}

async function readCheckout(request, url, env, key) {
  const [state, extraState] = url.searchParams.getAll("state");
  const [orderId, extraOrder] = url.searchParams.getAll("token");
  if (extraState !== undefined || extraOrder !== undefined || !ID.test(orderId || "")) return null;
  const parsed = /^([a-f0-9]{32})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(state || "");
  if (!parsed) return null;
  const [, reference, expires, stateSignature] = parsed;
  if (Number(expires) <= Math.floor(Date.now() / 1000)
      || !await signedByWorker(env, key, stateSignature, "state", reference, expires)
      || !await signedByWorker(env, key, cookieValue(request, checkoutCookieName(orderId)), "browser", state, orderId)) {
    return null;
  }
  return { orderId, reference, state };
}

function priceMatches(amount) {
  return amount?.currency_code === "USD" && typeof amount.value === "string" && /^100(?:\.0{1,2})?$/.test(amount.value);
}

function matchingUnit(order, orderId, reference, env) {
  if (order?.id !== orderId || order.intent !== "CAPTURE" || !Array.isArray(order.purchase_units)
      || order.purchase_units.length !== 1) return null;
  const [unit] = order.purchase_units;
  if (unit?.reference_id !== reference || unit.custom_id !== PRODUCT_SKU
      || unit.payee?.merchant_id !== env.PAYPAL_MERCHANT_ID || !priceMatches(unit.amount)
      || !Array.isArray(unit.items) || unit.items.length !== 1) return null;
  const [item] = unit.items;
  return item?.sku === PRODUCT_SKU && item.quantity === "1" && priceMatches(item.unit_amount) ? unit : null;
}

function pendingCheckout() {
  return checkoutPage("Payment confirmation pending",
    "<p>Refresh this page to check the same PayPal order. Contact support with your PayPal receipt if the download is still unavailable.</p>", 409);
}

function invalidCheckout() {
  return checkoutPage("Checkout link unavailable",
    '<p>Open the return page in the browser where you started the checkout. <a href="/checkout">Return to checkout</a>.</p>', 400);
}

async function finishOrder(checkout, env, key, api, headers, fetcher) {
  const { orderId, reference, state } = checkout;
  const orderUrl = api + "/v2/checkout/orders/" + orderId;
  let order = await paypalJson(fetcher, orderUrl, { headers });
  let unit = matchingUnit(order, orderId, reference, env);
  if (!unit) return invalidCheckout();
  if (order.status === "APPROVED") {
    try {
      await paypalJson(fetcher, orderUrl + "/capture", {
        method: "POST",
        headers: { ...headers, "paypal-request-id": reference + "-C" },
        body: "{}",
      });
    } catch {
      // PayPal may have completed the capture before returning an error.
    }
    order = await paypalJson(fetcher, orderUrl, { headers });
    unit = matchingUnit(order, orderId, reference, env);
    if (!unit) return invalidCheckout();
  }
  const captures = unit.payments?.captures;
  if (order.status !== "COMPLETED" || !Array.isArray(captures) || captures.length !== 1
      || !ID.test(captures[0]?.id || "") || captures[0].status !== "COMPLETED"
      || !priceMatches(captures[0].amount)) return pendingCheckout();

  const captureId = captures[0].id;
  const capture = await paypalJson(fetcher, api + "/v2/payments/captures/" + captureId, { headers });
  const relatedOrder = capture.supplementary_data?.related_ids?.order_id;
  if (capture.id !== captureId || capture.status !== "COMPLETED" || !priceMatches(capture.amount)
      || (relatedOrder !== undefined && relatedOrder !== orderId)
      || (capture.payee?.merchant_id !== undefined && capture.payee.merchant_id !== env.PAYPAL_MERCHANT_ID)
      || (capture.custom_id !== undefined && capture.custom_id !== PRODUCT_SKU)
      || capture.final_capture === false) return pendingCheckout();

  const purchase = await digest(env.PAYPAL_MERCHANT_ID + ":" + captureId);
  // Keep the same browser claim if a completed return response needs to be retried.
  const token = await signature(env, key, "download", state, orderId, captureId);
  return issueDownload(env, purchase, token);
}

async function handleCheckout(request, url, env, fetcher) {
  if (!ordersReady(env) || url.origin !== env.CHECKOUT_ORIGIN) {
    return checkoutPage("Checkout unavailable", "<p>Checkout is temporarily unavailable.</p>", 503);
  }
  const checkoutPath = url.pathname === "/checkout";
  if (checkoutPath && request.method === "GET") {
    const sandbox = env.PAYPAL_ENVIRONMENT === "sandbox" ? "<p>PayPal sandbox test. No real payment will be collected.</p>" : "";
    return checkoutPage(PRODUCT_NAME, sandbox +
      '<p>The Windows download starts in this browser after PayPal confirms your $100 USD payment.</p>' +
      '<form action="/checkout" method="post"><button type="submit">Pay $100 USD with PayPal</button></form>');
  }
  const returning = !checkoutPath && request.method === "GET";
  const starting = checkoutPath && request.method === "POST" && request.headers.get("origin") === env.CHECKOUT_ORIGIN;
  if (!returning && !starting) return invalidCheckout();
  let stage = "checkout-state";
  try {
    const key = await signingKey(env);
    const checkout = returning ? await readCheckout(request, url, env, key) : null;
    if (returning && !checkout) return invalidCheckout();
    const paypal = PAYPAL_ORDERS[env.PAYPAL_ENVIRONMENT];
    stage = "paypal-auth";
    const headers = await paypalHeaders(env, paypal.api, fetcher);
    stage = returning ? "confirm-order" : "create-order";
    return returning
      ? await finishOrder(checkout, env, key, paypal.api, headers, fetcher)
      : await startOrder(env, key, paypal, headers, fetcher);
  } catch (error) {
    const failure = returning
      ? checkoutPage("Payment status unavailable", "<p>Refresh this page to check the same PayPal order.</p>", 503)
      : checkoutPage("Checkout unavailable", '<p><a href="/checkout">Return to checkout</a> and try again.</p>', 503);
    failure.headers.set("x-checkout-failure", error instanceof PayPalRequestError ? stage + ":" + error.status : stage);
    return failure;
  }
}

async function driveToken(fetcher, credentials) {
  const account = serviceAccount(credentials);
  const pem = account.private_key.replace(/-----[A-Z ]+-----|\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), value => value.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const encode = data => base64url(ENCODE.encode(JSON.stringify(data)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 300,
  });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, ENCODE.encode(unsigned));
  const response = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + base64url(new Uint8Array(signature)),
    }),
  });
  if (!response.ok) throw new Error("Google authentication unavailable");
  const data = await response.json();
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Google access token missing");
  return data.access_token;
}

async function handleDownload(request, env, fetcher) {
  const browser = browserClaim(request);
  if (!browser || !await claimState(env, browser.purchase, "verify", { hash: await digest(browser.token) })) {
    return reply("Open the download in the browser used for your completed PayPal purchase.", 403);
  }
  const token = await driveToken(fetcher, env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const response = await fetcher(DRIVE_FILES + "/" + env.DELIVERY_FILE_ID + "?alt=media", {
    headers: { authorization: "Bearer " + token },
    redirect: "manual",
  });
  if (response.status !== 200 || !response.body) throw new Error("Drive download unavailable");
  return new Response(response.body, {
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${FILENAME}"`,
    },
  });
}

export class DownloadClaim {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/claim" && path !== "/verify")) return reply("Not found", 404);
    const { hash } = await request.json();
    if (typeof hash !== "string" || !KEY.test(hash)) return reply("Invalid claim", 400);
    const allowed = this.storage.transactionSync(() => {
      const current = this.storage.kv.get("claim");
      const now = Date.now();
      if (current) return current.expires > now && current.hash === hash;
      if (path !== "/claim") return false;
      this.storage.kv.put("claim", { hash, expires: now + LIFETIME_SECONDS * 1000 });
      return true;
    });
    return reply(null, allowed ? 204 : 403);
  }
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/checkout" || url.pathname === "/checkout/return") {
    return handleCheckout(request, url, env, fetcher);
  }
  if (request.method !== "GET") return reply("Not found", 404);
  if (url.pathname === "/health") {
    const checkoutReady = ordersReady(env);
    return Response.json({ deliveryReady: pdtReady(env) || checkoutReady, checkoutReady }, { headers: BASE_HEADERS });
  }
  if (url.pathname === "/paypal/confirmation") return paymentConfirmation();
  if (url.pathname !== "/paypal/return" && url.pathname !== "/download") return reply("Not found", 404);
  const enabled = pdtReady(env) || (url.pathname === "/download" && ordersReady(env));
  if (!enabled) return reply("Automatic delivery is not configured.", 503);
  try {
    return url.pathname === "/paypal/return"
      ? await handleReturn(url, request, env, fetcher)
      : await handleDownload(request, env, fetcher);
  } catch {
    return reply("Automatic delivery is temporarily unavailable. Please retry in the same browser or contact support with your PayPal receipt.", 503);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
