import {test} from "node:test";
import assert from "node:assert/strict";
import {createDriveWorker} from "../src/drive-worker.mjs";

const TX = "12ABC345DE6789FGH";
const ORIGIN = "https://fulfillment.example";
const baseEnv = {
  ENABLED: "true", PAYPAL_PDT_TOKEN: "test-pdt-token", PAYPAL_MERCHANT_ID: "MERCHANT123",
  PAYPAL_ITEM_NAME: "Subaru flasher", DOWNLOAD_SECRET: "test-download-secret-at-least-32-characters",
  PAYPAL_CHECKOUT_URL: "https://www.paypal.com/ncp/payment/ABCDEFGHIJKLM",
  DRIVE_DOWNLOAD_URL: "https://drive.google.com/file/d/TEST_ONLY_FILE_ID/view",
};
const payment = {txn_id: TX, payment_status: "Completed", mc_currency: "USD", mc_gross: "100.00", receiver_id: baseEnv.PAYPAL_MERCHANT_ID, item_name: "Subaru flasher", quantity: "1", payer_email: "buyer@example.com"};
function pdtBody(data = payment) {return "SUCCESS\n" + Object.entries(data).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("\n");}
function setup(data = payment) {
  let clock = Date.UTC(2026, 10, 25);
  let calls = 0;
  const worker = createDriveWorker({now: () => clock, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, "https://www.paypal.com/cgi-bin/webscr");
    assert.equal(options.redirect, "manual");
    return new Response(pdtBody(data), {status: 200});
  }});
  return {worker, advance: ms => {clock += ms;}, calls: () => calls};
}
function req(path, options) {return new Request(ORIGIN + path, options);}
async function claim(worker, env = baseEnv) {
  const result = await worker.fetch(req("/return?tx=" + TX), env);
  assert.equal(result.status, 303);
  return result.headers.get("Location");
}

test("health exposes readiness without any secret values", async () => {
  const {worker, calls} = setup();
  const result = await worker.fetch(req("/health"), baseEnv);
  assert.deepEqual(await result.json(), {ok: true, configured: true, enabled: true});
  assert.equal(calls(), 0);
});
test("disabled delivery remains closed even with all settings", async () => {
  const {worker, calls} = setup();
  const env = {...baseEnv, ENABLED: "false"};
  assert.equal((await worker.fetch(req("/checkout"), env)).status, 503);
  assert.deepEqual(await (await worker.fetch(req("/health"), env)).json(), {ok: true, configured: true, enabled: false});
  assert.equal(calls(), 0);
});
for (const key of Object.keys(baseEnv).filter(key => key !== "ENABLED")) {
  test("missing runtime " + key + " fails closed", async () => {
    const {worker, calls} = setup();
    const env = {...baseEnv}; delete env[key];
    assert.equal((await worker.fetch(req("/return?tx=" + TX), env)).status, 503);
    assert.equal(calls(), 0);
  });
}
test("checkout exposes only the validated original PayPal link", async () => {
  const {worker} = setup();
  const result = await worker.fetch(req("/checkout"), baseEnv);
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.ok(body.includes(baseEnv.PAYPAL_CHECKOUT_URL));
  assert.ok(!body.includes(baseEnv.DRIVE_DOWNLOAD_URL));
  assert.ok(!body.includes(baseEnv.PAYPAL_PDT_TOKEN));
});
for (const [key, value] of [
  ["PAYPAL_CHECKOUT_URL", "https://www.paypal.com.evil.example/ncp/payment/ABCDEFGHIJKLM"],
  ["PAYPAL_CHECKOUT_URL", "https://www.paypal.com/ncp/payment/ABCDEFGHIJKLM?return=evil"],
  ["DRIVE_DOWNLOAD_URL", "https://drive.google.com.evil.example/file/d/TEST_ONLY_FILE_ID/view"],
  ["DRIVE_DOWNLOAD_URL", "https://user:secret@drive.google.com/file/d/TEST_ONLY_FILE_ID/view"],
  ["DRIVE_DOWNLOAD_URL", "https://drive.google.com/file/d/TEST_ONLY_FILE_ID/view?redirect=evil"],
  ["DRIVE_DOWNLOAD_URL", "https://drive.google.com/file/d/TEST_ONLY_FILE_ID/view?usp=drivesdk&redirect=evil"],
  ["DRIVE_DOWNLOAD_URL", "javascript:alert(1)"],
  ["DOWNLOAD_SECRET", "too-short"],
]) {
  test("reject unsafe " + key + ": " + value, async () => {
    const {worker, calls} = setup();
    assert.equal((await worker.fetch(req("/checkout"), {...baseEnv, [key]: value})).status, 503);
    assert.equal(calls(), 0);
  });
}
test("verified return issues a signed link; download reverifies before Drive redirect", async () => {
  const {worker, calls} = setup();
  const path = await claim(worker);
  assert.match(path, /^\/ready\/[A-Z0-9]+\.\d+\.[a-f0-9]{64}$/);
  assert.equal(calls(), 1);
  const ready = await worker.fetch(req(path), baseEnv);
  assert.equal(ready.status, 200);
  const body = await ready.text();
  assert.ok(!body.includes(baseEnv.DRIVE_DOWNLOAD_URL));
  assert.ok(!body.includes(payment.payer_email));
  const download = await worker.fetch(req(path.replace("/ready/", "/download/")), baseEnv);
  assert.equal(download.status, 303);
  assert.equal(download.headers.get("Location"), baseEnv.DRIVE_DOWNLOAD_URL);
  assert.equal(download.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(download.headers.get("Cache-Control"), "private, no-store");
  assert.equal(calls(), 2);
});
for (const usp of ["drivesdk", "sharing", "drive_link"]) {
  test("accept supplied Drive sharing shape and remove safe usp=" + usp, async () => {
    const {worker} = setup();
    const env = {...baseEnv, DRIVE_DOWNLOAD_URL: baseEnv.DRIVE_DOWNLOAD_URL + "?usp=" + usp};
    assert.equal((await (await worker.fetch(req("/health"), env)).json()).configured, true);
    const path = await claim(worker, env);
    const result = await worker.fetch(req(path.replace("/ready/", "/download/")), env);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get("Location"), baseEnv.DRIVE_DOWNLOAD_URL);
  });
}
test("missing quantity is not accepted as a verified single copy", async () => {
  const data = {...payment}; delete data.quantity;
  const {worker} = setup(data);
  assert.equal((await worker.fetch(req("/return?tx=" + TX), baseEnv)).status, 403);
});
for (const [key, value] of Object.entries({payment_status: "Pending", mc_currency: "EUR", mc_gross: "99.99", receiver_id: "OTHER", item_name: "Other $100 product", quantity: "2", txn_id: "OTHERTRANSACTION", payer_email: ""})) {
  test("return rejects incorrect " + key, async () => {
    const {worker} = setup({...payment, [key]: value});
    const result = await worker.fetch(req("/return?tx=" + TX), baseEnv);
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("Location"), null);
    assert.ok(!(await result.text()).includes(baseEnv.DRIVE_DOWNLOAD_URL));
  });
}
test("refund or reversal after token issuance prevents download", async () => {
  const mutable = {...payment};
  const {worker} = setup(mutable);
  const path = await claim(worker);
  mutable.payment_status = "Refunded";
  const result = await worker.fetch(req(path.replace("/ready/", "/download/")), baseEnv);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("Location"), null);
});
test("tampered and expired tokens cannot trigger PayPal verification or download", async () => {
  const {worker, advance, calls} = setup();
  const path = await claim(worker);
  const downloadPath = path.replace("/ready/", "/download/");
  const last = downloadPath.slice(-1);
  assert.equal((await worker.fetch(req(downloadPath.slice(0, -1) + (last === "0" ? "1" : "0")), baseEnv)).status, 403);
  advance(24 * 60 * 60 * 1000);
  assert.equal((await worker.fetch(req(downloadPath), baseEnv)).status, 403);
  assert.equal((await worker.fetch(req(path), baseEnv)).status, 403);
  assert.equal(calls(), 1);
});
test("recovery requires receipt email and treats casing consistently", async () => {
  const {worker} = setup();
  const options = email => ({method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({tx: TX, email})});
  assert.equal((await worker.fetch(req("/recover", options("wrong@example.com")), baseEnv)).status, 403);
  assert.equal((await worker.fetch(req("/recover", options(" BUYER@EXAMPLE.COM ")), baseEnv)).status, 303);
});
test("cross-origin recovery forms are rejected before PayPal verification", async () => {
  const {worker, calls} = setup();
  const result = await worker.fetch(req("/recover", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded", Origin: "https://untrusted.example"}, body: new URLSearchParams({tx: TX, email: payment.payer_email})}), baseEnv);
  assert.equal(result.status, 403);
  assert.equal(calls(), 0);
});
test("malformed, duplicate, or oversized recovery requests do not call PayPal", async () => {
  const {worker, calls} = setup();
  for (const options of [
    {method: "POST", body: "tx=" + TX + "&email=buyer%40example.com"},
    {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: "tx=" + TX + "&tx=" + TX + "&email=buyer%40example.com"},
    {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: "tx=" + TX + "&email=" + "a".repeat(3000)},
  ]) assert.equal((await worker.fetch(req("/recover", options), baseEnv)).status, 400);
  assert.equal(calls(), 0);
});
test("invalid or duplicate return transaction IDs never call PayPal", async () => {
  const {worker, calls} = setup();
  for (const path of ["/return", "/return?tx=bad", "/return?tx=" + TX + "&tx=" + TX]) assert.equal((await worker.fetch(req(path), baseEnv)).status, 403);
  assert.equal(calls(), 0);
});
test("gateway redirects cannot leak the PDT token or reveal the Drive URL", async () => {
  let calls = 0;
  const worker = createDriveWorker({fetcher: async () => {calls++; return new Response(null, {status: 302, headers: {Location: "https://untrusted.example/collect"}});}});
  const result = await worker.fetch(req("/return?tx=" + TX), baseEnv);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("Location"), null);
  const body = await result.text();
  assert.ok(!body.includes(baseEnv.DRIVE_DOWNLOAD_URL));
  assert.ok(!body.includes(baseEnv.PAYPAL_PDT_TOKEN));
  assert.equal(calls, 1);
});
