const PRODUCT = "Bosch VIN Change";
const PRODUCT_AMOUNT = { currency_code: "USD", value: "25.00" };
const CAPTURE_EVENT = "PAYMENT.CAPTURE.COMPLETED";
const PAYPAL_CHECKOUT_ORIGIN = "https://www.paypal.com";
const CHECKOUT_STATE_LIFETIME = 6 * 60 * 60;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const MAX_EVENT_BYTES = 128 * 1024;
const SIGNATURE_HEADERS = {
  transmission_id: "paypal-transmission-id",
  transmission_time: "paypal-transmission-time",
  cert_url: "paypal-cert-url",
  auth_algo: "paypal-auth-algo",
  transmission_sig: "paypal-transmission-sig",
};
const PAYPAL_CHECKOUT_FAILURES = new Set([
  "INVALID_CLIENT", "INVALID_REQUEST", "INVALID_PARAMETER_SYNTAX", "INVALID_PARAMETER_VALUE",
  "INVALID_STRING_LENGTH", "MISSING_REQUIRED_PARAMETER", "INVALID_RESOURCE_ID", "NOT_AUTHORIZED",
  "PERMISSION_DENIED", "PAYEE_ACCOUNT_INVALID", "PAYEE_ACCOUNT_RESTRICTED", "PAYEE_NOT_CONSENTED",
  "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING", "CURRENCY_NOT_SUPPORTED_BY_PAYEE", "UNPROCESSABLE_ENTITY",
  "PAYPAL_REQUEST_ID_REQUIRED", "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE",
]);

class UpstreamRequestError extends Error {
  constructor(response) {
    super("Upstream request failed");
    this.response = response;
  }
}

class InvalidPayPalApproval extends Error {}

function reply(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function paypalBase(env) {
  if (env.PAYPAL_ENVIRONMENT === "live") return "https://api-m.paypal.com";
  if (env.PAYPAL_ENVIRONMENT === "sandbox") return "https://api-m.sandbox.paypal.com";
  throw new Error("PayPal environment is unavailable");
}

function isConfigured(env) {
  return (env.PAYPAL_ENVIRONMENT === "live" || env.PAYPAL_ENVIRONMENT === "sandbox")
    && Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_WEBHOOK_ID
      && env.PAYPAL_MERCHANT_ID && (env.PAYPAL_LINK_ID || env.PAYPAL_PRODUCT_CUSTOM_ID));
}

function deliverEnabled(env) {
  return env.DELIVERY_ENABLED === "true";
}

function id(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value);
}

function email(value) {
  return typeof value === "string" && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
}

function priceMatches(amount) {
  return amount?.currency_code === "USD" && typeof amount.value === "string"
    && /^25(?:\.0{1,2})?$/.test(amount.value);
}

function deliveryFileIds(env) {
  const files = (env.DELIVERY_FILE_IDS || "").split(",").map(value => value.trim());
  return files.length === 2 && new Set(files).size === 2 && files.every(id) ? files : null;
}

function serviceAccount(credentialJson) {
  const account = JSON.parse(credentialJson);
  if (!email(account?.client_email) || typeof account.private_key !== "string"
      || !account.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("Drive key unavailable");
  return account;
}

function checkoutReady(env) {
  if (env.PAYPAL_ENVIRONMENT !== "live" || !isConfigured(env) || !deliverEnabled(env)
      || !id(env.PAYPAL_MERCHANT_ID) || !id(env.PAYPAL_PRODUCT_CUSTOM_ID)
      || typeof env.CHECKOUT_STATE_SECRET !== "string" || !/^[A-Za-z0-9_-]{43,}$/.test(env.CHECKOUT_STATE_SECRET)
      || !deliveryFileIds(env) || !env.DELIVERY_QUEUE) return false;
  try {
    const origin = new URL(env.CHECKOUT_ORIGIN);
    serviceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return origin.protocol === "https:" && origin.origin === env.CHECKOUT_ORIGIN;
  } catch {
    return false;
  }
}

async function readEvent(request) {
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_EVENT_BYTES) throw new RangeError("Event exceeds size limit");
  if (!request.body) throw new SyntaxError("Event body is empty");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let raw = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EVENT_BYTES) throw new RangeError("Event exceeds size limit");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return { raw, event: JSON.parse(raw) };
  } finally {
    await reader.cancel();
  }
}

async function jsonResponse(fetcher, url, options) {
  // Workers supports manual redirects. A non-2xx response never forwards credentials.
  const response = await fetcher(url, { ...options, redirect: "manual" });
  if (!response.ok) throw new UpstreamRequestError(response);
  return response.json();
}

async function paypalToken(fetcher, base, env) {
  const data = await jsonResponse(fetcher, base + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!data.access_token) throw new Error("PayPal token unavailable");
  return data.access_token;
}

function hostedLink(object) {
  if (!object) return [];
  return [
    object.payment_link_id,
    object.payment_resource_id,
    object.supplementary_data?.payment_link_id,
    object.supplementary_data?.payment_resource_id,
  ].filter(value => value !== undefined && value !== null);
}

function buyerEmail(order) {
  return order.payer?.email_address || order.payment_source?.paypal?.email_address;
}

export function entitlement(eventCapture, capture, order, env) {
  if (capture?.id !== eventCapture.id || capture.status !== "COMPLETED"
      || order?.status !== "COMPLETED" || !priceMatches(capture.amount)
      || !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) return null;
  const unit = order.purchase_units[0];
  if (unit.payee?.merchant_id !== env.PAYPAL_MERCHANT_ID
      || (capture.payee?.merchant_id && capture.payee.merchant_id !== env.PAYPAL_MERCHANT_ID)
      || !priceMatches(unit.amount)
      || (unit.payments?.captures || []).length !== 1
      || unit.payments.captures[0]?.id !== capture.id) return null;

  const directLinks = [eventCapture, capture, order, unit].flatMap(hostedLink);
  const productId = env.PAYPAL_PRODUCT_CUSTOM_ID;
  const item = Array.isArray(unit.items) && unit.items.length === 1 ? unit.items[0] : null;
  const productMatches = Boolean(productId)
    && (capture.custom_id === productId || unit.custom_id === productId
      || (item?.sku === productId && item.quantity === "1" && priceMatches(item.unit_amount)));
  if (directLinks.length ? directLinks.some(value => value !== env.PAYPAL_LINK_ID) : !productMatches) return null;

  const buyer = buyerEmail(order);
  return email(buyer) ? { captureId: capture.id, buyer } : null;
}

function queueDelivery(env, purchase) {
  const queue = env.DELIVERY_QUEUE.get(env.DELIVERY_QUEUE.idFromName(PRODUCT));
  return queue.fetch("https://internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(purchase),
  });
}

export async function handleWebhook(request, env, fetcher = fetch) {
  if (!isConfigured(env)) return reply({ error: "Verification is not configured" }, 503);
  const signature = Object.fromEntries(Object.entries(SIGNATURE_HEADERS)
    .map(([field, name]) => [field, request.headers.get(name)]));
  if (Object.values(signature).some(value => !value)) return reply({ error: "Signature required" }, 403);

  let raw, event;
  try {
    ({ raw, event } = await readEvent(request));
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new SyntaxError("Invalid event");
  } catch (error) {
    return reply({ error: "Invalid webhook body" }, error instanceof RangeError ? 413 : 400);
  }
  try {
    const base = paypalBase(env);
    const token = await paypalToken(fetcher, base, env);
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    // PayPal verifies the original event serialization, including whitespace and escapes.
    const verificationFields = JSON.stringify({ ...signature, webhook_id: env.PAYPAL_WEBHOOK_ID });
    const verification = await jsonResponse(fetcher, base + "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers,
      body: verificationFields.slice(0, -1) + ',"webhook_event":' + raw + "}",
    });
    if (verification.verification_status !== "SUCCESS") return reply({ error: "Invalid signature" }, 403);
    const eventCapture = event.resource;
    if (event.event_type !== CAPTURE_EVENT || !eventCapture || !id(eventCapture.id)
        || eventCapture.status !== "COMPLETED"
        || (Object.hasOwn(eventCapture, "amount") && !priceMatches(eventCapture.amount))) {
      return reply({ outcome: "ignored" });
    }

    const capture = await jsonResponse(fetcher, base + "/v2/payments/captures/" + eventCapture.id, { headers });
    const eventOrderId = eventCapture.supplementary_data?.related_ids?.order_id;
    const captureOrderId = capture.supplementary_data?.related_ids?.order_id;
    if (eventOrderId && captureOrderId && eventOrderId !== captureOrderId) return reply({ outcome: "ignored" });
    const orderId = captureOrderId || eventOrderId;
    if (!id(orderId)) return reply({ outcome: "unattributed" });
    const order = await jsonResponse(fetcher, base + "/v2/checkout/orders/" + orderId, { headers });
    const paidFor = order.id === orderId && entitlement(eventCapture, capture, order, env);
    if (!paidFor) return reply({ outcome: "unattributed" });
    if (!deliverEnabled(env)) return reply({ outcome: "verified_dry_run" });

    return await queueDelivery(env, paidFor);
  } catch {
    return reply({ error: "Verification or delivery unavailable" }, 503);
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function checkoutKey(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.CHECKOUT_STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function checkoutStateData(env, reference, expires) {
  return new TextEncoder().encode(["bosch-vin-change-checkout-v1", env.CHECKOUT_ORIGIN,
    env.PAYPAL_MERCHANT_ID, env.PAYPAL_PRODUCT_CUSTOM_ID, reference, expires].join("\n"));
}

async function newCheckoutState(env, reference) {
  const expires = Math.floor(Date.now() / 1000) + CHECKOUT_STATE_LIFETIME;
  const signature = await crypto.subtle.sign("HMAC", await checkoutKey(env), checkoutStateData(env, reference, expires));
  return [reference, expires, base64url(new Uint8Array(signature))].join(".");
}

async function checkoutReference(env, state) {
  const match = /^([a-f0-9]{32})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(state || "");
  if (!match) return null;
  const [, reference, expires, signature] = match;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return null;
  const signatureBytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  if (base64url(signatureBytes) !== signature) return null;
  const valid = await crypto.subtle.verify("HMAC", await checkoutKey(env), signatureBytes,
    checkoutStateData(env, reference, expires));
  return valid ? reference : null;
}

function checkoutPage(title, content, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | ${PRODUCT}</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;background:#f5f7fa;color:#152030;margin:0}main{max-width:38rem;padding:3rem 1.5rem;margin:auto}button{font:inherit;font-weight:600;background:#003087;color:white;border:0;border-radius:.4rem;padding:.65rem 1rem;cursor:pointer}button:focus-visible{outline:3px solid #4789de;outline-offset:3px}</style>
</head><body><main><h1>${title}</h1>${content}</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://www.paypal.com",
    },
  });
}

function checkoutOrderMatches(order, orderId, reference, env) {
  const unit = order?.purchase_units?.[0];
  return order?.id === orderId && order.intent === "CAPTURE" && order.purchase_units?.length === 1
    && unit?.reference_id === reference && unit.custom_id === env.PAYPAL_PRODUCT_CUSTOM_ID
    && unit.payee?.merchant_id === env.PAYPAL_MERCHANT_ID && priceMatches(unit.amount) && email(buyerEmail(order));
}

async function startCheckout(env, fetcher, base, headers) {
  const reference = crypto.randomUUID().replace(/-/g, "");
  const returnUrl = new URL("/checkout/return", env.CHECKOUT_ORIGIN);
  returnUrl.searchParams.set("state", await newCheckoutState(env, reference));
  const order = await jsonResponse(fetcher, base + "/v2/checkout/orders", {
    method: "POST",
    headers: { ...headers, "paypal-request-id": reference },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: reference,
        custom_id: env.PAYPAL_PRODUCT_CUSTOM_ID,
        description: PRODUCT,
        amount: PRODUCT_AMOUNT,
      }],
      payment_source: { paypal: { experience_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        return_url: returnUrl.href,
        cancel_url: new URL("/checkout", env.CHECKOUT_ORIGIN).href,
      } } },
    }),
  });
  const approval = order.links?.find(link => link.rel === "payer-action" || link.rel === "approve");
  if (!approval?.href || !URL.canParse(approval.href)) throw new InvalidPayPalApproval();
  const redirect = new URL(approval.href);
  if (!id(order.id) || redirect.origin !== PAYPAL_CHECKOUT_ORIGIN || redirect.username || redirect.password
      || redirect.pathname !== "/checkoutnow" || redirect.searchParams.getAll("token").length !== 1
      || redirect.searchParams.get("token") !== order.id) throw new InvalidPayPalApproval();
  return new Response(null, { status: 303, headers: {
    location: redirect.href, "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

async function unavailableCheckout(stage, error) {
  const page = checkoutPage("Checkout unavailable",
    "<p>Return to checkout and try again.</p><p><a href=\"/checkout\">Back to checkout</a></p>", 503);
  if (error instanceof InvalidPayPalApproval) {
    page.headers.set("x-checkout-failure", "approval-link");
  } else if (error instanceof UpstreamRequestError) {
    const payload = await error.response.json().catch(() => null);
    const issues = Array.isArray(payload?.details) ? payload.details.map(detail => detail?.issue) : [];
    const code = [...issues, payload?.name, payload?.error].find(
      value => typeof value === "string" && PAYPAL_CHECKOUT_FAILURES.has(value.toUpperCase()),
    );
    const label = [stage, error.response.status, code?.toUpperCase()].filter(Boolean).join(":");
    page.headers.set("x-checkout-failure", label);
  } else {
    page.headers.set("x-checkout-failure", stage);
  }
  return page;
}

function invalidCheckout() {
  return checkoutPage("Checkout link unavailable", "<p>This checkout link is invalid or expired.</p>", 400);
}

async function finishCheckout(orderId, reference, env, fetcher, base, headers) {
  const orderUrl = base + "/v2/checkout/orders/" + orderId;
  let order = await jsonResponse(fetcher, orderUrl, { headers });
  if (!checkoutOrderMatches(order, orderId, reference, env)) return invalidCheckout();
  if (order.status === "APPROVED") {
    try {
      await jsonResponse(fetcher, orderUrl + "/capture", {
        method: "POST",
        headers: { ...headers, "paypal-request-id": "bvc-capture-" + orderId },
        body: "{}",
      });
    } catch {
      // The capture may have succeeded even if PayPal's response did not arrive.
    }
    order = await jsonResponse(fetcher, orderUrl, { headers });
    if (!checkoutOrderMatches(order, orderId, reference, env)) return invalidCheckout();
  }

  const captureId = order.purchase_units[0].payments?.captures?.[0]?.id;
  if (order.status !== "COMPLETED" || !id(captureId)) {
    return checkoutPage("Payment confirmation pending", "<p>Refresh this page to check the same PayPal order.</p>", 409);
  }
  const capture = await jsonResponse(fetcher, base + "/v2/payments/captures/" + captureId, { headers });
  const captureOrderId = capture.supplementary_data?.related_ids?.order_id;
  const paidFor = (!captureOrderId || captureOrderId === orderId) && entitlement({ id: captureId }, capture, order, env);
  if (!paidFor) {
    return checkoutPage("Payment confirmation pending", "<p>Refresh this page to check the same PayPal order.</p>", 409);
  }
  const delivery = await queueDelivery(env, paidFor);
  const outcome = delivery.ok && (await delivery.json()).outcome;
  if (outcome !== "delivered" && outcome !== "already_delivered") {
    return checkoutPage("Payment received", "<p>Download delivery is pending. Refresh this page to retry delivery for this payment.</p>", 503);
  }
  const [windowsFile, androidFile] = deliveryFileIds(env);
  return checkoutPage("Payment complete", `<p>Both downloads are ready. Sign in to Google Drive with the email address you used to pay with PayPal. Google Drive emails an invitation when access is first granted.</p>
<ul><li><a href="https://drive.google.com/file/d/${windowsFile}/view">Download for Windows (EXE)</a></li>
<li><a href="https://drive.google.com/file/d/${androidFile}/view">Download for Android (APK)</a></li></ul>`);
}

export async function handleCheckout(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (!checkoutReady(env) || url.origin !== env.CHECKOUT_ORIGIN) {
    return checkoutPage("Checkout unavailable", "<p>Checkout is temporarily unavailable.</p>", 503);
  }
  if (url.pathname === "/checkout" && request.method === "GET") {
    return checkoutPage(PRODUCT, `<p>Buy the Windows and Android downloads for $25 USD. Use a PayPal email address you can also use to sign in to Google Drive.</p>
<form method="post" action="/checkout"><button type="submit">Pay $25 USD with PayPal</button></form>`);
  }
  const returning = url.pathname === "/checkout/return" && request.method === "GET";
  const starting = url.pathname === "/checkout" && request.method === "POST"
    && request.headers.get("origin") === env.CHECKOUT_ORIGIN;
  if (!returning && !starting) return invalidCheckout();
  let stage = "sign-in";
  try {
    const orderId = url.searchParams.get("token");
    const reference = returning && await checkoutReference(env, url.searchParams.get("state"));
    if (returning && (!reference || !id(orderId) || url.searchParams.getAll("state").length !== 1
        || url.searchParams.getAll("token").length !== 1)) return invalidCheckout();
    const base = paypalBase(env);
    const token = await paypalToken(fetcher, base, env);
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    if (starting) {
      stage = "create-order";
      return await startCheckout(env, fetcher, base, headers);
    }
    return await finishCheckout(orderId, reference, env, fetcher, base, headers);
  } catch (error) {
    return returning
      ? checkoutPage("Payment status unavailable", "<p>Refresh this page to check the same PayPal order.</p>", 503)
      : unavailableCheckout(stage, error);
  }
}

async function driveToken(fetcher, credentialJson) {
  const account = serviceAccount(credentialJson);
  const pem = account.private_key.replace(/-----[A-Z ]+-----|\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), value => value.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const encode = data => base64url(new TextEncoder().encode(JSON.stringify(data)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 300,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  const data = await jsonResponse(fetcher, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + base64url(new Uint8Array(signature)),
    }),
  });
  if (!data.access_token) throw new Error("Drive token unavailable");
  return data.access_token;
}

async function ensureDriveReader(fetcher, token, fileId, buyer) {
  const base = DRIVE_API + "/" + fileId + "/permissions";
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const query = new URLSearchParams({
    fields: "nextPageToken,permissions(type,emailAddress,role,deleted)",
    pageSize: "100",
    supportsAllDrives: "true",
  });
  for (;;) {
    const current = await jsonResponse(fetcher, base + "?" + query, { headers });
    if ((current.permissions || []).some(permission => permission.type === "user" && !permission.deleted
        && permission.emailAddress?.toLowerCase() === buyer.toLowerCase())) return;
    if (!current.nextPageToken) break;
    query.set("pageToken", current.nextPageToken);
  }
  const options = new URLSearchParams({
    sendNotificationEmail: "true",
    supportsAllDrives: "true",
    emailMessage: "Thanks for purchasing Bosch VIN Change. Your download is ready in Google Drive.",
    fields: "id",
  });
  await jsonResponse(fetcher, base + "?" + options, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "user", role: "reader", emailAddress: buyer }),
  });
}

export class DeliveryQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.tail = Promise.resolve();
  }

  async fetch(request) {
    if (request.method !== "POST" || !deliverEnabled(this.env)) return reply({ error: "Unavailable" }, 503);
    const purchase = await request.json();
    if (!id(purchase.captureId) || !email(purchase.buyer)) return reply({ error: "Invalid purchase" }, 400);
    // Queue permission mutations across buyers so Drive never receives concurrent
    // permission writes for the same file. Its API does not support those writes.
    const job = this.tail.then(() => this.deliver(purchase));
    this.tail = job.catch(() => {});
    try {
      return reply({ outcome: await job });
    } catch {
      return reply({ error: "Delivery unavailable" }, 503);
    }
  }

  async deliver({ captureId, buyer }) {
    const storedKey = "delivered:" + captureId;
    if (await this.state.storage.get(storedKey)) return "already_delivered";
    const fileIds = deliveryFileIds(this.env);
    if (!fileIds) throw new Error("Both delivery files are required");
    const token = await driveToken(fetch, this.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    for (const fileId of fileIds) await ensureDriveReader(fetch, token, fileId, buyer);
    await this.state.storage.put(storedKey, true);
    return "delivered";
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/webhooks/paypal") return handleWebhook(request, env);
    if (path === "/checkout" || path === "/checkout/return") return handleCheckout(request, env);
    if (request.method === "GET" && path === "/health") {
      return reply({ configured: isConfigured(env), deliveryEnabled: deliverEnabled(env), checkoutReady: checkoutReady(env) });
    }
    return reply({ error: "Not found" }, 404);
  },
};
