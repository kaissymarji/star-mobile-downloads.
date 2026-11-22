import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { DeliveryQueue, handleWebhook } from "../src/index.mjs";

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
    method: "POST", headers, body: JSON.stringify(event),
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

test("if hosted ID is absent, only the configured merchant custom ID can attribute the payment", async () => {
  const details = payment();
  delete details.order.purchase_units[0].payment_link_id;
  details.capture.custom_id = "BOSCH_VIN_CHANGE_TEST";
  const response = await handleWebhook(webhook(details.event), {
    ...env, DELIVERY_ENABLED: "false", PAYPAL_PRODUCT_CUSTOM_ID: "BOSCH_VIN_CHANGE_TEST",
  }, fakePayPal(details));
  assert.deepEqual(await response.json(), { outcome: "verified_dry_run" });
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
