import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import worker, { DeliveryQueue, handleCheckout, handleWebhook } from "../src/index.mjs";

const hostedId = "HOSTED_TEST_ITEM";
const email = "buyer@example.test";
const amount = { currency_code: "USD", value: "25.00" };
const env = {
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_CLIENT_ID: "test-id",
  PAYPAL_CLIENT_SECRET: "test-secret",
  PAYPAL_WEBHOOK_ID: "test-webhook",
  PAYPAL_MERCHANT_ID: "TESTMERCHANT",
  PAYPAL_LINK_ID: hostedId,
  DELIVERY_ENABLED: "true",
};

function payment() {
  const capture = {
    id: "TESTCAPTURE", status: "COMPLETED", amount,
    supplementary_data: { related_ids: { order_id: "TESTORDER" } },
  };
  const order = {
    id: "TESTORDER", status: "COMPLETED", payer: { email_address: email },
    purchase_units: [{
      payee: { merchant_id: env.PAYPAL_MERCHANT_ID },
      payment_link_id: hostedId,
      amount,
      payments: { captures: [{ id: "TESTCAPTURE" }] },
    }],
  };
  return { event: { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: structuredClone(capture) }, capture, order };
}

function webhook(event, headers = {
  "paypal-transmission-id": "transmission", "paypal-transmission-time": "2025-01-01T00:00:00Z",
  "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "test-signature",
}) {
  return new Request("https://example.test/webhooks/paypal", {
    method: "POST", headers, body: typeof event === "string" ? event : JSON.stringify(event),
  });
}

function fakePayPal({ capture, order }, success = true) {
  return async (url, options) => {
    assert.equal(new URL(url).hostname, "api-m.sandbox.paypal.com");
    if (url.endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: "test-token" });
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.webhook_id, env.PAYPAL_WEBHOOK_ID);
      return Response.json({ verification_status: success ? "SUCCESS" : "FAILURE" });
    }
    if (url.endsWith("/v2/payments/captures/TESTCAPTURE")) return Response.json(capture);
    if (url.endsWith("/v2/checkout/orders/TESTORDER")) return Response.json(order);
    assert.fail("Unexpected PayPal endpoint");
  };
}

function fakeQueue(attempts) {
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async (_, request) => {
        attempts.push(JSON.parse(request.body));
        return Response.json({ outcome: "delivered" });
      },
    }),
  };
}

test("completed capture for the exact merchant and product queues the verified buyer once", async () => {
  const details = payment();
  const deliveries = [];
  const response = await handleWebhook(
    webhook(details.event), { ...env, DELIVERY_QUEUE: fakeQueue(deliveries) }, fakePayPal(details),
  );
  assert.deepEqual(await response.json(), { outcome: "delivered" });
  assert.deepEqual(deliveries, [{ captureId: "TESTCAPTURE", buyer: email }]);
});

test("verify-only mode leaves Drive untouched", async () => {
  const details = payment();
  const response = await handleWebhook(
    webhook(details.event), { ...env, DELIVERY_ENABLED: "false" }, fakePayPal(details),
  );
  assert.deepEqual(await response.json(), { outcome: "verified_dry_run" });
});

test("signature verification preserves the original event whitespace and escapes", async () => {
  const details = payment();
  const raw = " \r\n" + JSON.stringify(details.event, null, 2).replace("COMPLETED", "COMPL\\u0045TED") + "\r\n";
  const upstream = fakePayPal(details);
  const fetcher = async (url, options) => {
    if (url.endsWith("/verify-webhook-signature")) {
      assert.ok(options.body.endsWith(',"webhook_event":' + raw + "}"));
      assert.deepEqual(JSON.parse(options.body).webhook_event, details.event);
    }
    return upstream(url, options);
  };
  const response = await handleWebhook(webhook(raw), { ...env, DELIVERY_ENABLED: "false" }, fetcher);
  assert.deepEqual(await response.json(), { outcome: "verified_dry_run" });
});

test("a signed minimal capture uses the PayPal capture and order amounts", async () => {
  const details = payment();
  delete details.event.resource.amount;
  const verifyOnly = { ...env, DELIVERY_ENABLED: "false" };
  const valid = await handleWebhook(webhook(details.event), verifyOnly, fakePayPal(details));
  assert.deepEqual(await valid.json(), { outcome: "verified_dry_run" });
  details.capture.amount = { ...amount, value: "24.99" };
  const invalid = await handleWebhook(webhook(details.event), verifyOnly, fakePayPal(details));
  assert.deepEqual(await invalid.json(), { outcome: "unattributed" });
});

test("a conflicting amount in the signed event is rejected even if readback would match", async () => {
  const details = payment();
  details.event.resource.amount = { ...amount, value: "24.99" };
  const response = await handleWebhook(webhook(details.event), env, fakePayPal(details));
  assert.deepEqual(await response.json(), { outcome: "ignored" });
});

test("unsigned or forged webhook fails", async () => {
  const details = payment();
  assert.equal((await handleWebhook(webhook(details.event, {}), env, fakePayPal(details))).status, 403);
  assert.equal((await handleWebhook(webhook(details.event), env, fakePayPal(details, false))).status, 403);
});

const rejected = [
  ["a different $25 product", ({ order }) => { order.purchase_units[0].payment_link_id = "OTHER"; }],
  ["unidentified hosted checkout", ({ order }) => { delete order.purchase_units[0].payment_link_id; }],
  ["pending or refunded capture", ({ capture }) => { capture.status = "REFUNDED"; }],
  ["a different merchant", ({ order }) => { order.purchase_units[0].payee.merchant_id = "OTHER"; }],
  ["wrong currency", ({ capture }) => { capture.amount = { ...amount, currency_code: "EUR" }; }],
  ["wrong amount", ({ capture }) => { capture.amount = { ...amount, value: "24.99" }; }],
  ["capture missing from order", ({ order }) => { order.purchase_units[0].payments.captures[0].id = "OTHER"; }],
  ["missing buyer", ({ order }) => { delete order.payer; }],
  ["another order", ({ order }) => { order.id = "OTHER"; }],
  ["multiple items", ({ order }) => { order.purchase_units.push(order.purchase_units[0]); }],
  ["conflicting hosted IDs", ({ capture }) => { capture.payment_resource_id = "OTHER"; }],
];
for (const [name, change] of rejected) {
  test("no release for " + name, async () => {
    const details = payment();
    change(details);
    const response = await handleWebhook(webhook(details.event), env, fakePayPal(details));
    assert.deepEqual(await response.json(), { outcome: "unattributed" });
  });
}

test("if the hosted ID is absent, a configured merchant custom ID can attribute the payment", async () => {
  const details = payment();
  delete details.order.purchase_units[0].payment_link_id;
  details.capture.custom_id = "BOSCH_VIN_CHANGE_TEST";
  const response = await handleWebhook(webhook(details.event), {
    ...env, DELIVERY_ENABLED: "false", PAYPAL_PRODUCT_CUSTOM_ID: "BOSCH_VIN_CHANGE_TEST",
  }, fakePayPal(details));
  assert.deepEqual(await response.json(), { outcome: "verified_dry_run" });
});

const productId = "BOSCH_VIN_CHANGE_TEST";
const skuEnv = { ...env, DELIVERY_ENABLED: "false", PAYPAL_PRODUCT_CUSTOM_ID: productId };

function paymentWithSku() {
  const details = payment();
  const unit = details.order.purchase_units[0];
  delete unit.payment_link_id;
  unit.items = [{ sku: productId, quantity: "1", unit_amount: amount }];
  return details;
}

test("if the hosted ID is absent, the exact SKU on the single $25 item can attribute the payment", async () => {
  const details = paymentWithSku();
  const response = await handleWebhook(webhook(details.event), skuEnv, fakePayPal(details));
  assert.deepEqual(await response.json(), { outcome: "verified_dry_run" });
});

const rejectedSku = [
  ["a different SKU", unit => { unit.items[0].sku = "OTHER"; }],
  ["a description matching the product ID", unit => {
    delete unit.items[0].sku;
    unit.items[0].description = productId;
  }],
  ["multiple items", unit => { unit.items.push({ ...unit.items[0] }); }],
  ["multiple copies", unit => { unit.items[0].quantity = "2"; }],
  ["a mismatched unit price", unit => { unit.items[0].unit_amount = { ...amount, value: "24.99" }; }],
  ["a mismatched unit currency", unit => { unit.items[0].unit_amount = { ...amount, currency_code: "EUR" }; }],
  ["a conflicting hosted ID", unit => { unit.payment_link_id = "OTHER"; }],
];
for (const [name, change] of rejectedSku) {
  test("SKU fallback rejects " + name, async () => {
    const details = paymentWithSku();
    change(details.order.purchase_units[0]);
    const response = await handleWebhook(webhook(details.event), skuEnv, fakePayPal(details));
    assert.deepEqual(await response.json(), { outcome: "unattributed" });
  });
}

test("SKU fallback requires a configured product ID", async () => {
  const details = paymentWithSku();
  const response = await handleWebhook(webhook(details.event), env, fakePayPal(details));
  assert.deepEqual(await response.json(), { outcome: "unattributed" });
});

const checkoutOrigin = "https://checkout.example.test";
const liveOrderId = "TESTLIVEORDER";
const checkoutEnv = {
  ...env,
  PAYPAL_ENVIRONMENT: "live",
  PAYPAL_LINK_ID: undefined,
  PAYPAL_PRODUCT_CUSTOM_ID: productId,
  CHECKOUT_ORIGIN: checkoutOrigin,
  CHECKOUT_STATE_SECRET: "test-secret-for-checkout-state-with-more-than-forty-three-characters",
  DELIVERY_FILE_IDS: "WINDOWSFILE,ANDROIDFILE",
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "fulfillment@example.test", private_key: "-----BEGIN PRIVATE KEY-----\ntest",
  }),
  DELIVERY_QUEUE: fakeQueue([]),
};

function checkoutStart(origin = checkoutOrigin) {
  return new Request(checkoutOrigin + "/checkout", { method: "POST", headers: { origin } });
}

function mockCheckout() {
  const mock = {
    returnUrl: null,
    order: null,
    captureRequests: [],
    approvalUrl: "https://www.paypal.com/checkoutnow?token=" + liveOrderId,
    failBeforeCapture: false,
    loseCaptureResponse: false,
  };
  mock.fetcher = async (url, options) => {
    assert.equal(new URL(url).origin, "https://api-m.paypal.com");
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "checkout-token" });
    assert.equal(options.headers.authorization, "Bearer checkout-token");
    if (url.endsWith("/v2/checkout/orders")) {
      assert.equal(options.method, "POST");
      const payload = JSON.parse(options.body);
      const [unit] = payload.purchase_units;
      const context = payload.payment_source.paypal.experience_context;
      assert.equal(options.headers["paypal-request-id"], unit.reference_id);
      assert.equal(payload.intent, "CAPTURE");
      assert.equal(payload.purchase_units.length, 1);
      assert.equal(unit.custom_id, productId);
      assert.equal(unit.payee, undefined);
      assert.deepEqual(unit.amount, amount);
      assert.equal(context.shipping_preference, "NO_SHIPPING");
      assert.equal(context.user_action, "PAY_NOW");
      assert.equal(context.cancel_url, checkoutOrigin + "/checkout");
      mock.returnUrl = new URL(context.return_url);
      assert.equal(mock.returnUrl.origin, checkoutOrigin);
      assert.equal(mock.returnUrl.pathname, "/checkout/return");
      mock.returnUrl.searchParams.set("token", liveOrderId);
      mock.order = {
        id: liveOrderId, intent: payload.intent, status: "APPROVED",
        purchase_units: [{ ...unit, payee: { merchant_id: checkoutEnv.PAYPAL_MERCHANT_ID } }],
        payment_source: { paypal: { email_address: email } },
      };
      return Response.json({ id: liveOrderId, links: [{ rel: "payer-action", href: mock.approvalUrl }] });
    }
    if (url.endsWith("/v2/checkout/orders/" + liveOrderId)) return Response.json(mock.order);
    if (url.endsWith("/v2/checkout/orders/" + liveOrderId + "/capture")) {
      assert.equal(options.method, "POST");
      assert.equal(options.body, "{}");
      mock.captureRequests.push(options.headers["paypal-request-id"]);
      if (mock.failBeforeCapture) return new Response(null, { status: 503 });
      mock.order.status = "COMPLETED";
      mock.order.purchase_units[0].payments = { captures: [{ id: "TESTCAPTURE" }] };
      if (mock.loseCaptureResponse) throw new Error("Payment response lost after capture");
      return Response.json(mock.order);
    }
    if (url.endsWith("/v2/payments/captures/TESTCAPTURE")) {
      return Response.json({
        id: "TESTCAPTURE", status: "COMPLETED", amount,
        supplementary_data: { related_ids: { order_id: liveOrderId } },
      });
    }
    assert.fail("Unexpected PayPal endpoint " + url);
  };
  return mock;
}

test("checkout readiness requires live configuration and two distinct delivery files", async () => {
  const health = new Request(checkoutOrigin + "/health");
  assert.deepEqual(await (await worker.fetch(health, checkoutEnv)).json(), {
    configured: true, deliveryEnabled: true, checkoutReady: true,
  });
  const landing = await worker.fetch(new Request(checkoutOrigin + "/checkout"), checkoutEnv);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Pay \$25 USD with PayPal/);
  for (const configuration of [
    { PAYPAL_ENVIRONMENT: "sandbox" }, { DELIVERY_ENABLED: "false" }, { CHECKOUT_STATE_SECRET: "" },
    { DELIVERY_FILE_IDS: "WINDOWSFILE" }, { DELIVERY_FILE_IDS: "WINDOWSFILE,WINDOWSFILE" },
  ]) {
    const incomplete = { ...checkoutEnv, ...configuration };
    assert.equal((await worker.fetch(new Request(checkoutOrigin + "/checkout"), incomplete)).status, 503);
    assert.equal((await (await worker.fetch(health, incomplete)).json()).checkoutReady, false);
  }
});

test("live checkout only accepts its same-origin form and a PayPal approval redirect", async () => {
  const mock = mockCheckout();
  const crossOrigin = await handleCheckout(checkoutStart("https://elsewhere.example"), checkoutEnv, mock.fetcher);
  assert.equal(crossOrigin.status, 400);
  assert.equal(mock.order, null);
  mock.approvalUrl = "https://www.paypal.com.evil.example/checkoutnow?token=" + liveOrderId;
  const wrongHost = await handleCheckout(checkoutStart(), checkoutEnv, mock.fetcher);
  assert.equal(wrongHost.status, 503);
  assert.equal(wrongHost.headers.get("location"), null);
  assert.equal(wrongHost.headers.get("x-checkout-failure"), "approval-link");
  mock.approvalUrl = "https://www.paypal.com/checkoutnow?token=UNRELATEDORDER";
  const wrongOrder = await handleCheckout(checkoutStart(), checkoutEnv, mock.fetcher);
  assert.equal(wrongOrder.status, 503);
  assert.equal(wrongOrder.headers.get("location"), null);
});

test("checkout diagnostics report the PayPal failure stage without echoing response details", async () => {
  const response = await handleCheckout(checkoutStart(), checkoutEnv, async url => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "checkout-token" });
    return Response.json({
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED", description: "private provider details" }],
    }, { status: 422 });
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-checkout-failure"), "create-order:422:PAYEE_ACCOUNT_RESTRICTED");
  assert.doesNotMatch(await response.text(), /private provider details/);
});

test("checkout rejects an upstream redirect without forwarding PayPal credentials", async () => {
  const requests = [];
  const response = await handleCheckout(checkoutStart(), checkoutEnv, async (url, options) => {
    requests.push({ url, redirect: options.redirect });
    return new Response(null, { status: 302, headers: { location: "https://unexpected.example/" } });
  });
  assert.deepEqual(requests, [{ url: "https://api-m.paypal.com/v1/oauth2/token", redirect: "manual" }]);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-checkout-failure"), "sign-in:302");
  assert.equal(response.headers.get("location"), null);
});

test("live checkout verifies a buyer-approved $25 order and delivers its authenticated capture", async () => {
  const mock = mockCheckout();
  const deliveries = [];
  const ready = { ...checkoutEnv, DELIVERY_QUEUE: fakeQueue(deliveries) };
  const start = await handleCheckout(checkoutStart(), ready, mock.fetcher);
  assert.equal(start.status, 303);
  assert.equal(start.headers.get("location"), mock.approvalUrl);

  const tampered = new URL(mock.returnUrl);
  const state = tampered.searchParams.get("state");
  tampered.searchParams.set("state", (state[0] === "0" ? "1" : "0") + state.slice(1));
  const rejected = await handleCheckout(new Request(tampered), ready, () => assert.fail("Invalid state reached PayPal"));
  assert.equal(rejected.status, 400);

  mock.loseCaptureResponse = true;
  const completed = await handleCheckout(new Request(mock.returnUrl), ready, mock.fetcher);
  assert.equal(completed.status, 200);
  assert.match(await completed.text(), /Payment complete/);
  assert.deepEqual(deliveries, [{ captureId: "TESTCAPTURE", buyer: email }]);
  assert.deepEqual(mock.captureRequests, ["bvc-capture-" + liveOrderId]);

  const refreshed = await handleCheckout(new Request(mock.returnUrl), ready, mock.fetcher);
  assert.equal(refreshed.status, 200);
  assert.equal(mock.captureRequests.length, 1);
});

test("live checkout rejects unrelated approved orders without attempting to capture", async () => {
  const mock = mockCheckout();
  const start = await handleCheckout(checkoutStart(), checkoutEnv, mock.fetcher);
  assert.equal(start.status, 303);
  const unit = mock.order.purchase_units[0];
  for (const [field, invalid] of [
    ["reference_id", "unrelated-ref"], ["custom_id", "OTHER"], ["payee", { merchant_id: "OTHER" }],
    ["amount", { ...amount, value: "24.99" }],
  ]) {
    const original = unit[field];
    unit[field] = invalid;
    const result = await handleCheckout(new Request(mock.returnUrl), checkoutEnv, mock.fetcher);
    assert.equal(result.status, 400);
    unit[field] = original;
  }
  mock.order.payment_source.paypal.email_address = "";
  assert.equal((await handleCheckout(new Request(mock.returnUrl), checkoutEnv, mock.fetcher)).status, 400);
  assert.deepEqual(mock.captureRequests, []);
});

test("retrying a failed capture uses the same PayPal idempotency key", async () => {
  const mock = mockCheckout();
  const start = await handleCheckout(checkoutStart(), checkoutEnv, mock.fetcher);
  assert.equal(start.status, 303);
  mock.failBeforeCapture = true;
  assert.equal((await handleCheckout(new Request(mock.returnUrl), checkoutEnv, mock.fetcher)).status, 409);
  mock.failBeforeCapture = false;
  assert.equal((await handleCheckout(new Request(mock.returnUrl), checkoutEnv, mock.fetcher)).status, 200);
  assert.deepEqual(mock.captureRequests, ["bvc-capture-" + liveOrderId, "bvc-capture-" + liveOrderId]);
});

function deliveryRequest(captureId = "TESTCAPTURE") {
  return new Request("https://internal/deliver", {
    method: "POST",
    body: JSON.stringify({ captureId, buyer: email }),
  });
}

test("Drive delivery grants individual access to both files and deduplicates a retry", async t => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const googleAccount = JSON.stringify({
    client_email: "fulfillment@example.test",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
  const grants = [];
  let failAndroidOnce = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = new URL(url);
    if (target.hostname === "oauth2.googleapis.com") {
      assert.equal(options.body.get("assertion").split(".").length, 3);
      return Response.json({ access_token: "drive-token" });
    }
    assert.equal(target.hostname, "www.googleapis.com");
    const file = target.pathname.split("/")[4];
    if (options.method === "POST") {
      if (file === "ANDROIDFILE" && failAndroidOnce) {
        failAndroidOnce = false;
        return new Response(null, { status: 503 });
      }
      assert.equal(target.searchParams.get("sendNotificationEmail"), "true");
      assert.deepEqual(JSON.parse(options.body), { type: "user", role: "reader", emailAddress: email });
      grants.push(file);
      return Response.json({ id: "test-permission-id" });
    }
    return Response.json({ permissions: grants.includes(file)
      ? [{ type: "user", role: "reader", emailAddress: email }]
      : [] });
  });
  const store = new Map();
  const queue = new DeliveryQueue(
    { storage: { get: key => store.get(key), put: (key, value) => store.set(key, value) } },
    { ...env, DELIVERY_FILE_IDS: "WINDOWSFILE,ANDROIDFILE", GOOGLE_SERVICE_ACCOUNT_JSON: googleAccount },
  );
  const first = await queue.fetch(deliveryRequest());
  assert.equal(first.status, 503);
  assert.deepEqual(grants, ["WINDOWSFILE"]);
  const retry = await queue.fetch(deliveryRequest());
  assert.deepEqual(await retry.json(), { outcome: "delivered" });
  assert.deepEqual(grants, ["WINDOWSFILE", "ANDROIDFILE"]);
  const duplicate = await queue.fetch(deliveryRequest());
  assert.deepEqual(await duplicate.json(), { outcome: "already_delivered" });
  assert.deepEqual(grants, ["WINDOWSFILE", "ANDROIDFILE"]);
});
