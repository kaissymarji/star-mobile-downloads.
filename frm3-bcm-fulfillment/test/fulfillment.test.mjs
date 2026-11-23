import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { DownloadClaim, handleRequest } from "../src/index.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const origin = "https://example.invalid";
const tx = "TRANSACTION123";
const returnPath = "/paypal/return?tx=" + tx;
const validPayment = {
  txn_id: tx,
  payment_status: "Completed",
  receiver_id: "MERCHANT_ID",
  mc_currency: "USD",
  mc_gross: "100.00",
  item_number: "FRM3_JLR_BCM_REPAIR",
  quantity: "1",
  hosted_button_id: "Z64WWV95SSXHQ",
};

function fixture(payment = validPayment, orders) {
  const objects = new Map();
  const calls = [];
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255]);
  const upstream = { driveStatus: 200, driveType: "application/zip", driveBytes: bytes };
  const env = {
    DELIVERY_ENABLED: "true",
    PAYPAL_ENVIRONMENT: "sandbox",
    PAYPAL_MERCHANT_ID: "MERCHANT_ID",
    PAYPAL_LINK_ID: "Z64WWV95SSXHQ",
    PAYPAL_PRODUCT_ITEM_NUMBER: "FRM3_JLR_BCM_REPAIR",
    PAYPAL_PDT_IDENTITY_TOKEN: "sandbox-fixture-identity-token",
    DELIVERY_FILE_ID: "private_drive_file",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: privateKey, client_email: "download@example.invalid" }),
    DOWNLOAD_CLAIMS: {
      idFromName: name => name,
      get(name) {
        if (!objects.has(name)) {
          const values = new Map();
          const storage = { kv: values, transactionSync: callback => callback() };
          // Cloudflare's synchronous KV uses put, while Map uses set.
          values.put = values.set.bind(values);
          objects.set(name, { values, object: new DownloadClaim({ storage }) });
        }
        return { fetch: (url, options) => objects.get(name).object.fetch(new Request(url, options)) };
      },
    },
  };
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    if (orders && url.startsWith("https://api-m.sandbox.paypal.com/")) {
      return orders.fetch(url, options, env);
    }
    switch (url) {
      case "https://www.paypal.com/cgi-bin/webscr":
      case "https://www.sandbox.paypal.com/cgi-bin/webscr":
        assert.equal(options.method, "POST");
        assert.deepEqual(Object.fromEntries(options.body), {
          cmd: "_notify-synch",
          tx,
          at: env.PAYPAL_PDT_IDENTITY_TOKEN,
        });
        return new Response(typeof payment === "string" ? payment : "SUCCESS\r\n" +
          Object.entries(payment).map(([key, value]) => key + "=" + encodeURIComponent(value)).join("\r\n") + "\r\n");
      case "https://oauth2.googleapis.com/token": {
        const [, claims] = options.body.get("assertion").split(".");
        const payload = JSON.parse(Buffer.from(claims, "base64url"));
        assert.equal(payload.scope, "https://www.googleapis.com/auth/drive.readonly");
        return Response.json({ access_token: "temporary_google_token" });
      }
      case "https://www.googleapis.com/drive/v3/files/private_drive_file?alt=media":
        assert.equal(options.headers.authorization, "Bearer temporary_google_token");
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(upstream.driveBytes.subarray(0, 2));
            controller.enqueue(upstream.driveBytes.subarray(2));
            controller.close();
          },
        }), { status: upstream.driveStatus, headers: { "content-type": upstream.driveType } });
      default:
        throw new Error("Unexpected request to " + url);
    }
  };
  const handle = (path, init) => handleRequest(new Request(origin + path, init), env, fetcher);
  const run = (path, headers) => handle(path, { headers });
  return { env, run, handle, calls, objects, bytes, upstream };
}

test("a verified sale starts the private attachment and grants a short retry window", async () => {
  const { run, calls, bytes, objects } = fixture();
  const response = await run(returnPath + "&st=Completed&amt=100.00");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/download");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const attributes = response.headers.get("set-cookie");
  assert.match(attributes, /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.ok(!attributes.includes(tx));
  const cookie = attributes.split(";")[0];

  const download = await run("/download", { cookie });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="FRM3 and JLR BCM Repair.zip"');
  assert.equal(download.headers.get("content-type"), "application/zip");
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await run("/download", { cookie })).status, 200);
  assert.equal((await run(returnPath, { cookie })).status, 303);
  assert.equal((await run(returnPath)).status, 403);
  assert.equal((await run("/download")).status, 403);
  assert.equal((await run("/download", { cookie: cookie.replace(/.$/, cookie.endsWith("X") ? "Y" : "X") })).status, 403);

  const [{ values }] = objects.values();
  const current = values.get("claim");
  values.set("claim", { ...current, expires: Date.now() - 1 });
  assert.equal((await run("/download", { cookie })).status, 403);
  assert.equal((await run(returnPath, { cookie })).status, 403);
  assert.equal(calls.filter(url => url.includes("drive/v3")).length, 2);
});

test("only one browser can claim a verified transaction concurrently", async () => {
  const { run } = fixture();
  const responses = await Promise.all([run(returnPath), run(returnPath)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 403]);
});

test("a transient Drive failure leaves the verified browser able to retry", async () => {
  const { run, upstream, bytes } = fixture();
  const checkout = await run(returnPath);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  upstream.driveStatus = 503;
  assert.equal((await run("/download", { cookie })).status, 503);
  upstream.driveStatus = 200;
  const download = await run("/download", { cookie });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
});

test("a verified browser never receives an executable or incomplete ZIP labeled as the ZIP", async () => {
  const { run, upstream, bytes } = fixture();
  const checkout = await run(returnPath);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  upstream.driveType = "application/x-msdownload";
  assert.equal((await run("/download", { cookie })).status, 503);
  upstream.driveType = "application/zip";
  upstream.driveBytes = new Uint8Array([77, 90, 0, 255]);
  assert.equal((await run("/download", { cookie })).status, 503);
  upstream.driveBytes = bytes.subarray(0, 3);
  assert.equal((await run("/download", { cookie })).status, 503);
  upstream.driveBytes = bytes;
  assert.equal((await run("/download", { cookie })).status, 200);
});

test("the public counter includes each verified live purchase once when its ZIP is ready", async () => {
  const { env, handle, run, upstream } = fixture();
  env.PAYPAL_ENVIRONMENT = "live";
  const stats = await run("/stats");
  assert.equal(stats.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await stats.json(), { downloads: 0 });
  assert.equal((await handle("/stats", { method: "POST" })).status, 404);
  assert.equal((await handle("/record-download", { method: "POST" })).status, 404);
  assert.equal((await run("/download")).status, 403);

  const checkout = await run(returnPath);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  upstream.driveStatus = 503;
  assert.equal((await run("/download", { cookie })).status, 503);
  assert.deepEqual(await (await run("/stats")).json(), { downloads: 0 });
  upstream.driveStatus = 200;
  const downloads = await Promise.all([run("/download", { cookie }), run("/download", { cookie })]);
  assert.deepEqual(downloads.map(response => response.status), [200, 200]);
  assert.deepEqual(await (await run("/stats")).json(), { downloads: 1 });
});

test("sandbox purchases never affect the live counter, including downloads after an environment switch", async () => {
  const { env, run } = fixture();
  const checkout = await run(returnPath);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  assert.equal((await run("/download", { cookie })).status, 200);
  env.PAYPAL_ENVIRONMENT = "live";
  assert.equal((await run("/download", { cookie })).status, 200);
  assert.deepEqual(await (await run("/stats")).json(), { downloads: 0 });
});

test("download counter failures leave the validated ZIP available", async () => {
  const { env, run, bytes } = fixture();
  env.PAYPAL_ENVIRONMENT = "live";
  const stub = env.DOWNLOAD_CLAIMS.get;
  env.DOWNLOAD_CLAIMS.get = name => {
    if (name === "frm3-verified-download-counter") throw new Error("Counter unavailable");
    return stub(name);
  };
  const checkout = await run(returnPath);
  const cookie = checkout.headers.get("set-cookie").split(";")[0];
  const download = await run("/download", { cookie });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await run("/stats")).status, 503);
});

test("unverified, mismatched, or ambiguous transactions do not contact Drive", async () => {
  const { item_number, hosted_button_id, ...withoutProduct } = validPayment;
  const invalid = [
    "FAILURE\n",
    "SUCCESS\ntxn_id=" + tx + "\ntxn_id=" + tx + "\n",
    { ...validPayment, payment_status: "Pending" },
    { ...validPayment, payment_status: "Refunded" },
    { ...validPayment, mc_gross: "99.00" },
    { ...validPayment, mc_currency: "EUR" },
    { ...validPayment, receiver_id: "OTHER_MERCHANT" },
    { ...validPayment, txn_id: "OTHER_TRANSACTION" },
    { ...validPayment, item_number: "OTHER_PRODUCT" },
    { ...validPayment, item_number1: "OTHER_PRODUCT" },
    { ...validPayment, hosted_button_id: "OTHER_BUTTON" },
    { ...validPayment, payment_link_id: "OTHER_BUTTON" },
    { ...validPayment, quantity: "2" },
    { ...validPayment, quantity1: "" },
    { ...validPayment, num_cart_items: "2" },
    { ...validPayment, item_number2: "OTHER_PRODUCT" },
    withoutProduct,
  ];
  for (const payment of invalid) {
    const { run, calls } = fixture(payment);
    assert.equal((await run(returnPath + "&st=Completed&amt=100&cm=FRM3_JLR_BCM_REPAIR")).status, 403);
    assert.deepEqual(calls, ["https://www.sandbox.paypal.com/cgi-bin/webscr"]);
  }
});

test("a verified hosted link ID proves the product without an item number", async () => {
  const { hosted_button_id, item_number, ...fields } = validPayment;
  for (const key of ["hosted_button_id", "payment_link_id"]) {
    const { env, run } = fixture({ ...fields, [key]: hosted_button_id });
    env.PAYPAL_PRODUCT_ITEM_NUMBER = "";
    assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true, checkoutReady: false });
    assert.equal((await run(returnPath)).status, 303);
  }
});

test("item numbers without a hosted link ID require a configured matching item", async () => {
  const { hosted_button_id, ...fields } = validPayment;
  const { env, run, calls } = fixture(fields);
  env.PAYPAL_PRODUCT_ITEM_NUMBER = "";
  assert.equal((await run(returnPath + "&hosted_button_id=" + hosted_button_id)).status, 403);
  assert.deepEqual(calls, ["https://www.sandbox.paypal.com/cgi-bin/webscr"]);
});

test("PayPal can report a verified, single-item indexed product number without a hosted link ID", async () => {
  const { hosted_button_id, item_number, quantity, ...fields } = validPayment;
  const { run } = fixture({ ...fields, item_number1: item_number, quantity1: quantity, num_cart_items: "1" });
  assert.equal((await run(returnPath)).status, 303);
});

test("missing transaction ID or deployment configuration stays closed", async () => {
  const { env, run, calls } = fixture();
  assert.equal((await run("/paypal/return")).status, 400);
  assert.equal((await run(returnPath + "&tx=OTHER")).status, 400);
  assert.equal((await run("/download?file=private_drive_file")).status, 403);
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true, checkoutReady: false });
  env.DELIVERY_ENABLED = "false";
  assert.equal((await run(returnPath)).status, 503);
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: false, checkoutReady: false });
  assert.deepEqual(calls, []);
});

test("the general PayPal return provides receipt guidance without authorizing a download", async () => {
  const { env, run, calls } = fixture();
  env.DELIVERY_ENABLED = "false";
  const result = await run("/paypal/confirmation?tx=EXAMPLE");
  assert.equal(result.status, 200);
  assert.match(await result.text(), /PayPal will email a receipt/);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(calls, []);
});

const orderId = "ORDER123";
const captureId = "CAPTURE123";
const paypalApi = "https://api-m.sandbox.paypal.com";
const apiOrderUrl = paypalApi + "/v2/checkout/orders/" + orderId;
const apiCaptureUrl = paypalApi + "/v2/payments/captures/" + captureId;
const orderAmount = { currency_code: "USD", value: "100.00" };
const product = "FRM3_JLR_BCM_REPAIR";

function orderFixture() {
  const order = {
    status: "APPROVED",
    captureStatus: "COMPLETED",
    loseCaptureResponse: false,
    modifyUnit: unit => unit,
    modifyCapture: capture => capture,
    approvalHost: "www.sandbox.paypal.com",
    async fetch(url, options, env) {
      if (url.endsWith("/v1/oauth2/token")) {
        assert.equal(options.headers.authorization, "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET));
        assert.equal(options.body, "grant_type=client_credentials");
        return Response.json({ access_token: "sandbox-oauth-token" });
      }
      assert.equal(options.headers.authorization, "Bearer sandbox-oauth-token");
      if (url === paypalApi + "/v2/checkout/orders") {
        const orderRequest = JSON.parse(options.body);
        assert.equal(orderRequest.intent, "CAPTURE");
        const experience = orderRequest.payment_source.paypal.experience_context;
        assert.equal(experience.shipping_preference, "NO_SHIPPING");
        assert.equal(experience.user_action, "PAY_NOW");
        assert.equal(experience.cancel_url, origin + "/checkout");
        this.returnUrl = new URL(experience.return_url);
        assert.equal(this.returnUrl.origin, origin);
        assert.equal(this.returnUrl.pathname, "/checkout/return");
        assert.equal(orderRequest.purchase_units.length, 1);
        this.unit = orderRequest.purchase_units[0];
        assert.equal(this.unit.reference_id, options.headers["paypal-request-id"]);
        assert.deepEqual(this.unit.payee, { merchant_id: env.PAYPAL_MERCHANT_ID });
        assert.equal(this.unit.custom_id, product);
        assert.deepEqual(this.unit.amount, { ...orderAmount, breakdown: { item_total: orderAmount } });
        assert.equal(this.unit.items.length, 1);
        assert.deepEqual(this.unit.items[0], {
          name: "FRM3 and JLR BCM Repair", sku: product, unit_amount: orderAmount,
          quantity: "1", category: "DIGITAL_GOODS",
        });
        return Response.json({
          id: orderId,
          links: [{ rel: "payer-action", href: "https://" + this.approvalHost + "/checkoutnow?token=" + orderId }],
        }, { status: 201 });
      }
      if (url === apiOrderUrl) {
        const unit = structuredClone(this.unit);
        if (this.status === "COMPLETED") {
          unit.payments = { captures: [{ id: captureId, status: this.captureStatus, amount: orderAmount }] };
        }
        return Response.json({ id: orderId, intent: "CAPTURE", status: this.status, purchase_units: [this.modifyUnit(unit)] });
      }
      if (url === apiOrderUrl + "/capture") {
        assert.equal(options.method, "POST");
        assert.equal(options.headers["paypal-request-id"], this.unit.reference_id + "-C");
        this.status = "COMPLETED";
        return Response.json({}, { status: this.loseCaptureResponse ? 503 : 201 });
      }
      if (url === apiCaptureUrl) {
        return Response.json(this.modifyCapture({
          id: captureId, status: this.captureStatus, amount: orderAmount, final_capture: true,
          supplementary_data: { related_ids: { order_id: orderId } },
          payee: { merchant_id: env.PAYPAL_MERCHANT_ID }, custom_id: product,
        }));
      }
      throw new Error("Unexpected PayPal API URL " + url);
    },
  };
  const base = fixture(validPayment, order);
  Object.assign(base.env, {
    PAYPAL_PDT_IDENTITY_TOKEN: "",
    PAYPAL_ORDERS_ENABLED: "true",
    PAYPAL_CLIENT_ID: "sandbox-client-fixture-id",
    PAYPAL_CLIENT_SECRET: "sandbox-client-fixture-secret",
    CHECKOUT_STATE_SECRET: "a".repeat(43),
    CHECKOUT_ORIGIN: origin,
  });
  const request = base.handle;
  const start = async () => {
    const response = await request("/checkout", { method: "POST", headers: { origin } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://www.sandbox.paypal.com/checkoutnow?token=" + orderId);
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-frm3-checkout-ORDER123=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2700$/);
    const cookie = setCookie.split(";")[0];
    const returning = order.returnUrl.pathname + order.returnUrl.search + "&token=" + orderId;
    return { cookie, returning };
  };
  return { ...base, order, start, request };
}

test("Orders checkout verifies an idempotent $100 capture and streams the private file on return", async () => {
  const { order, run, calls, bytes, start } = orderFixture();
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true, checkoutReady: true });
  const checkoutPage = await run("/checkout");
  assert.match(await checkoutPage.text(), /Pay \$100 USD with PayPal/);
  assert.equal(checkoutPage.headers.get("referrer-policy"), "same-origin");
  assert.match(checkoutPage.headers.get("content-security-policy"), /form-action 'self' https:\/\/www\.sandbox\.paypal\.com$/);
  assert.equal((await run("/paypal/return?tx=" + tx)).status, 503);
  assert.equal((await run("/download")).status, 403);
  order.loseCaptureResponse = true;
  const { cookie, returning } = await start();
  const completed = await run(returning, { cookie });
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get("location"), "/download");
  const downloadCookie = completed.headers.get("set-cookie").split(";")[0];
  const download = await run("/download", { cookie: downloadCookie });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  const retry = await run(returning, { cookie });
  assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("set-cookie").split(";")[0], downloadCookie);
  assert.equal(calls.filter(url => url === apiOrderUrl + "/capture").length, 1);
  assert.equal(calls.filter(url => url === apiCaptureUrl).length, 2);
});

test("Orders checkout rejects a forged or cross-browser return before contacting PayPal", async () => {
  const { run, calls, start, request } = orderFixture();
  assert.equal((await request("/checkout", { method: "POST", headers: { origin: "https://elsewhere.invalid" } })).status, 400);
  assert.deepEqual(calls, []);
  const { cookie, returning } = await start();
  const callCount = calls.length;
  const signedState = new URL(origin + returning).searchParams.get("state");
  const tamperedReturn = returning.replace(signedState, signedState.replace(/^./, signedState[0] === "0" ? "1" : "0"));
  assert.equal((await run(returning)).status, 400);
  assert.equal((await run(returning.replace(orderId, "ANOTHER_ORDER"), { cookie })).status, 400);
  assert.equal((await run(returning + "&token=ANOTHER_ORDER", { cookie })).status, 400);
  assert.equal((await run(tamperedReturn, { cookie })).status, 400);
  assert.equal(calls.length, callCount);
});

test("production checkout uses a separate pair of live PayPal credentials", async () => {
  const { env, run } = orderFixture();
  env.PAYPAL_ENVIRONMENT = "live";
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: false, checkoutReady: false });
  env.PAYPAL_LIVE_CLIENT_ID = "live-merchant-app-id-fixture";
  env.PAYPAL_LIVE_CLIENT_SECRET = "live-merchant-app-secret-fixture";
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true, checkoutReady: true });
  const page = await run("/checkout");
  assert.doesNotMatch(await page.text(), /sandbox test/);
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/www\.paypal\.com$/);
});

test("Orders checkout never captures the wrong merchant, amount, product, or quantity", async () => {
  const mutations = [
    unit => ({ ...unit, payee: { merchant_id: "WRONG" } }),
    unit => ({ ...unit, custom_id: "OTHER_PRODUCT" }),
    unit => ({ ...unit, amount: { currency_code: "USD", value: "99.00" } }),
    unit => ({ ...unit, items: [{ ...unit.items[0], quantity: "2" }] }),
  ];
  for (const changeUnit of mutations) {
    const { order, calls, run, start } = orderFixture();
    const { cookie, returning } = await start();
    order.modifyUnit = changeUnit;
    assert.equal((await run(returning, { cookie })).status, 400);
    assert.ok(!calls.includes(apiOrderUrl + "/capture"));
    assert.ok(!calls.includes(apiCaptureUrl));
  }
});

test("Orders checkout keeps pending payments and inconsistent PayPal capture details locked", async () => {
  const mutations = [
    capture => ({ ...capture, status: "PENDING" }),
    capture => ({ ...capture, amount: { currency_code: "EUR", value: "100.00" } }),
    capture => ({ ...capture, supplementary_data: { related_ids: { order_id: "OTHER" } } }),
    capture => ({ ...capture, final_capture: false }),
  ];
  for (const changeCapture of mutations) {
    const { order, run, start, calls } = orderFixture();
    const { cookie, returning } = await start();
    order.modifyCapture = changeCapture;
    assert.equal((await run(returning, { cookie })).status, 409);
    assert.equal((await run("/download")).status, 403);
    assert.ok(!calls.includes("https://oauth2.googleapis.com/token"));
  }
});

test("Orders checkout refuses a PayPal approval link on another origin", async () => {
  const { request, order } = orderFixture();
  order.approvalHost = "paypal.invalid";
  const result = await request("/checkout", { method: "POST", headers: { origin } });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("location"), null);
  assert.equal(result.headers.get("set-cookie"), null);
});
