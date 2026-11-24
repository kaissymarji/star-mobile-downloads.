import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.mjs";

const origin = "https://nissan-service-checkout.kaissymarji.workers.dev";
const paypalUrl = "https://www.paypal.com/ncp/payment/EXAMPLE123456";
const configured = { PAYPAL_CHECKOUT_URL: paypalUrl };

function get(path, env = configured) {
  return worker.fetch(new Request(origin + path), env);
}

function post(body, env = configured, requestOrigin = origin) {
  return worker.fetch(new Request(origin + "/checkout", {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" },
    body,
  }), env);
}

test("checkout shows the $5 review fee and authorization requirement when it is ready", async () => {
  const checkout = await get("/checkout");
  assert.equal(checkout.status, 200);
  const html = await checkout.text();
  assert.match(html, /\$5 USD/);
  assert.match(html, /proof of ownership or authorization/);
  assert.match(html, /name="authorized" value="yes" required/);
  assert.doesNotMatch(html, /EXAMPLE123456/);

  const health = await get("/health");
  assert.deepEqual(await health.json(), { checkoutReady: true });
  const offline = await get("/checkout", {});
  assert.equal(offline.status, 503);
  assert.doesNotMatch(await offline.text(), /<form/);
});

test("checkout only redirects a same-origin confirmed request to the configured PayPal URL", async () => {
  const approved = await post("authorized=yes&returnUrl=https://example.org/");
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get("location"), paypalUrl);

  for (const body of ["", "authorized=no", "authorized=yes&authorized=no"]) {
    const denied = await post(body);
    assert.equal(denied.status, 400);
    assert.equal(denied.headers.get("location"), null);
  }

  const crossOrigin = await post("authorized=yes", configured, "https://example.org");
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("location"), null);
});

test("missing and noncanonical payment URLs leave checkout disabled", async () => {
  const invalid = [undefined, "http://www.paypal.com/ncp/payment/EXAMPLE123456",
    "https://www.paypal.com.example.org/ncp/payment/EXAMPLE123456",
    "https://www.paypal.com@evil.example/ncp/payment/EXAMPLE123456",
    paypalUrl + "?returnUrl=https://example.org/", paypalUrl + "\n"];

  for (const url of invalid) {
    const env = { PAYPAL_CHECKOUT_URL: url };
    const response = await post("authorized=yes", env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
    const health = await get("/health", env);
    assert.deepEqual(await health.json(), { checkoutReady: false });
  }
});

test("the return page gives manual follow-up even if a visitor adds fake status parameters", async () => {
  const response = await get("/return?status=COMPLETED&tx=UNVERIFIED123", {});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /verify payment/);
  assert.match(html, /sms:\+19252789301/);
  assert.doesNotMatch(html, /UNVERIFIED123|payment confirmed/i);
});
