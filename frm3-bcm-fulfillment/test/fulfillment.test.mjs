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

function fixture(payment = validPayment) {
  const objects = new Map();
  const calls = [];
  const upstream = { driveStatus: 200 };
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
  const bytes = new Uint8Array([77, 90, 0, 255]);
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    switch (url) {
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
        return new Response(bytes, { status: upstream.driveStatus });
      default:
        throw new Error("Unexpected request to " + url);
    }
  };
  const run = (path, headers) => handleRequest(new Request(origin + path, { headers }), env, fetcher);
  return { env, run, calls, objects, bytes, upstream };
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
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="FRM3 and JLR BCM Repair.exe"');
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
    assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true });
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
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: true });
  env.DELIVERY_ENABLED = "false";
  assert.equal((await run(returnPath)).status, 503);
  assert.deepEqual(await (await run("/health")).json(), { deliveryReady: false });
  assert.deepEqual(calls, []);
});
