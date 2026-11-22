const PRODUCT = "Bosch VIN Change";
const CAPTURE_EVENT = "PAYMENT.CAPTURE.COMPLETED";
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
      && env.PAYPAL_MERCHANT_ID && env.PAYPAL_LINK_ID);
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
  const response = await fetcher(url, { redirect: "error", ...options });
  if (!response.ok) throw new Error("Upstream request failed");
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

  const buyer = order.payer?.email_address || order.payment_source?.paypal?.email_address;
  return email(buyer) ? { captureId: capture.id, buyer } : null;
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

    const queue = env.DELIVERY_QUEUE.get(env.DELIVERY_QUEUE.idFromName(PRODUCT));
    return await queue.fetch("https://internal/deliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(paidFor),
    });
  } catch {
    return reply({ error: "Verification or delivery unavailable" }, 503);
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function driveToken(fetcher, credentialJson) {
  const account = JSON.parse(credentialJson);
  if (!email(account.client_email) || typeof account.private_key !== "string"
      || !account.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("Drive key unavailable");
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
    const fileIds = [...new Set((this.env.DELIVERY_FILE_IDS || "").split(",").map(value => value.trim()))];
    if (!fileIds.length || fileIds.some(value => !id(value))) throw new Error("Delivery files unavailable");
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
    if (request.method === "GET" && path === "/health") {
      return reply({ configured: isConfigured(env), deliveryEnabled: deliverEnabled(env) });
    }
    return reply({ error: "Not found" }, 404);
  },
};
