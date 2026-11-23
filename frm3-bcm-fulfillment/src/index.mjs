const PAYPAL = {
  live: "https://www.paypal.com/cgi-bin/webscr",
  sandbox: "https://www.sandbox.paypal.com/cgi-bin/webscr",
};
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

function ready(env) {
  if (env.DELIVERY_ENABLED !== "true" || !Object.hasOwn(PAYPAL, env.PAYPAL_ENVIRONMENT)
      || !ID.test(env.PAYPAL_MERCHANT_ID || "") || !ID.test(env.PAYPAL_LINK_ID || "")
      || (env.PAYPAL_PRODUCT_ITEM_NUMBER && !ID.test(env.PAYPAL_PRODUCT_ITEM_NUMBER))
      || !ID.test(env.DELIVERY_FILE_ID || "")
      || !/^[^\s]{20,1024}$/.test(env.PAYPAL_PDT_IDENTITY_TOKEN || "") || !env.DOWNLOAD_CLAIMS) return false;
  try {
    serviceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return true;
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

function browserClaim(request) {
  const prefix = COOKIE_NAME + "=";
  const value = request.headers.get("cookie")?.split(/;\s*/).find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
  const [purchase, token, extra] = (value || "").split(".");
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

async function handleReturn(url, request, env, fetcher) {
  const transactions = url.searchParams.getAll("tx");
  const [tx] = transactions;
  if (transactions.length !== 1 || !ID.test(tx || "")) return reply("PayPal did not supply a transaction ID.", 400);
  if (!await verifyPurchase(tx, env, fetcher)) return reply("PayPal did not verify a completed purchase for this download.", 403);
  const purchase = await digest(env.PAYPAL_MERCHANT_ID + ":" + tx);
  const browser = browserClaim(request);
  const token = browser?.purchase === purchase ? browser.token : base64url(crypto.getRandomValues(new Uint8Array(32)));
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
  if (request.method !== "GET") return reply("Not found", 404);
  if (url.pathname === "/health") {
    return Response.json({ deliveryReady: ready(env) }, { headers: BASE_HEADERS });
  }
  if (url.pathname === "/paypal/confirmation") return paymentConfirmation();
  if (url.pathname !== "/paypal/return" && url.pathname !== "/download") return reply("Not found", 404);
  if (!ready(env)) return reply("Automatic delivery is not configured.", 503);
  try {
    return url.pathname === "/paypal/return"
      ? await handleReturn(url, request, env, fetcher)
      : await handleDownload(request, env, fetcher);
  } catch {
    return reply("Automatic delivery is temporarily unavailable. Please retry in the same browser or contact support with your PayPal receipt.", 503);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
