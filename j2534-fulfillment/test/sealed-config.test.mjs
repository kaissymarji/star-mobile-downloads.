import {test} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {createConfigResolver, publicKeyDescriptor, sealRuntimeConfig, setupKey} from "../src/sealed-config.mjs";
import {createDriveWorker} from "../src/drive-worker.mjs";
import {bootstrapRuntime} from "../scripts/bootstrap-runtime.mjs";

const pair = generateKeyPairSync("rsa", {modulusLength: 4096, publicExponent: 65537});
const privateKey = pair.privateKey.export({type: "pkcs8", format: "der"}).toString("base64url");
const publicKey = pair.publicKey.export({format: "jwk"});
const descriptor = await publicKeyDescriptor(publicKey);
const config = {PAYPAL_PDT_TOKEN: "test-token-that-must-never-be-public", PAYPAL_MERCHANT_ID: "TESTMERCHANT", PAYPAL_ITEM_NAME: "Subaru flasher", PAYPAL_CHECKOUT_URL: "https://www.paypal.com/ncp/payment/ABCDEFGHIJKLM", DRIVE_DOWNLOAD_URL: "https://drive.google.com/file/d/TEST_ONLY_PRIVATE_FILE/view?usp=drivesdk", ENABLED: "true"};
const env = {DOWNLOAD_SECRET: "test-runtime-only-signing-secret-32-characters", ISO_CONFIG_PRIVATE_KEY: privateKey, ISO_CONFIG_PUBLIC_KEY: JSON.stringify(descriptor)};
const envelope = await sealRuntimeConfig(config, descriptor);
const request = path => new Request("https://fulfillment.example" + path);
const accountId = "a".repeat(32);
const token = "test-api-token-not-for-logs";
function cfResult(result, status = 200) {return new Response(JSON.stringify({success: true, result}), {status});}
function bootstrapOptions(fetcher, extra = {}) {return {token, accountId, fetcher, generate: () => ({privateKey, publicKey}), signingSecret: () => "new-test-signing-secret-at-least-32-characters", ...extra};}

test("null sealed config preserves direct runtime configuration", async () => {
  assert.equal(await createConfigResolver(null)(env), env);
});
test("sealed config roundtrip preserves runtime secrets without exposing plaintext in its source", async () => {
  const serialized = JSON.stringify(envelope);
  for (const sensitive of [config.PAYPAL_PDT_TOKEN, config.DRIVE_DOWNLOAD_URL, env.DOWNLOAD_SECRET, privateKey]) assert.equal(serialized.includes(sensitive), false);
  const resolved = await createConfigResolver(envelope)(env);
  assert.deepEqual(resolved, {...env, ...config});
  assert.equal(env.PAYPAL_PDT_TOKEN, undefined);
});
test("public setup key is usable while delivery is disabled and contains no private configuration", async () => {
  const worker = createDriveWorker();
  const result = await worker.fetch(request("/setup-key"), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), descriptor);
  const publicText = JSON.stringify(await setupKey(env));
  for (const sensitive of [privateKey, env.DOWNLOAD_SECRET, config.PAYPAL_PDT_TOKEN, config.DRIVE_DOWNLOAD_URL]) assert.equal(publicText.includes(sensitive), false);
});
test("setup key unavailable without a complete valid runtime key pair", async () => {
  const worker = createDriveWorker();
  for (const changed of [{...env, ISO_CONFIG_PRIVATE_KEY: ""}, {...env, ISO_CONFIG_PUBLIC_KEY: "{"}, {...env, ISO_CONFIG_PUBLIC_KEY: JSON.stringify({...descriptor, keyId: "0".repeat(64)})}]) {
    const result = await worker.fetch(request("/setup-key"), changed);
    assert.equal(result.status, 503);
    const body = await result.text();
    assert.equal(body.includes(privateKey), false);
  }
});
test("sealed configuration drives the real return/download flow and never bypasses payment verification", async () => {
  const tx = "12ABC345DE6789FGH";
  let calls = 0;
  const worker = createDriveWorker({envelope, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, "https://www.paypal.com/cgi-bin/webscr");
    assert.equal(new URLSearchParams(options.body).get("at"), config.PAYPAL_PDT_TOKEN);
    return new Response("SUCCESS\n" + new URLSearchParams({txn_id: tx, payment_status: "Completed", mc_currency: "USD", mc_gross: "100.00", receiver_id: config.PAYPAL_MERCHANT_ID, item_name: config.PAYPAL_ITEM_NAME, quantity: "1", payer_email: "buyer@example.com"}).toString().replace(/&/g, "\n"));
  }});
  assert.deepEqual(await (await worker.fetch(request("/health"), env)).json(), {ok: true, configured: true, enabled: true});
  const returned = await worker.fetch(request("/return?tx=" + tx), env);
  assert.equal(returned.status, 303);
  const ready = await worker.fetch(request(returned.headers.get("Location")), env);
  assert.match(await ready.text(), /Your payment is complete\. PayPal emails your receipt/);
  const download = await worker.fetch(request(returned.headers.get("Location").replace("/ready/", "/download/")), env);
  assert.equal(download.status, 303);
  assert.equal(download.headers.get("Location"), config.DRIVE_DOWNLOAD_URL.split("?")[0]);
  assert.equal(calls, 2);
});
for (const [name, patch] of [
  ["version", {version: 2}],
  ["algorithm", {algorithm: "RSA1_5"}],
  ["key identity", {keyId: "0".repeat(64)}],
  ["extra envelope fields", {plaintext: "forbidden"}],
  ["wrong IV length", {iv: Buffer.alloc(11).toString("base64url")}],
  ["padded base64", {wrappedKey: envelope.wrappedKey + "="}],
  ["tampered ciphertext", {ciphertext: Buffer.alloc(64).toString("base64url")}],
  ["oversized ciphertext", {ciphertext: "A".repeat(6000)}],
]) {
  test("reject sealed " + name + " without falling back to valid direct environment", async () => {
    const worker = createDriveWorker({envelope: {...envelope, ...patch}, fetcher: async () => {throw new Error("Payment API must not be called");}});
    const result = await worker.fetch(request("/health"), {...env, ...config});
    assert.equal(result.status, 503);
    const body = await result.text();
    for (const sensitive of [privateKey, config.PAYPAL_PDT_TOKEN, config.DRIVE_DOWNLOAD_URL]) assert.equal(body.includes(sensitive), false);
    // A malformed deployed envelope never prevents retrieval of its existing public key.
    assert.equal((await worker.fetch(request("/setup-key"), env)).status, 200);
  });
}
test("missing private key fails closed instead of using plaintext fallback", async () => {
  await assert.rejects(createConfigResolver(envelope)({...env, ...config, ISO_CONFIG_PRIVATE_KEY: ""}), /Sealed configuration/);
});
test("wrong private key cannot decrypt sealed configuration", async () => {
  const wrong = generateKeyPairSync("rsa", {modulusLength: 4096});
  const wrongPrivate = wrong.privateKey.export({type: "pkcs8", format: "der"}).toString("base64url");
  await assert.rejects(createConfigResolver(envelope)({...env, ISO_CONFIG_PRIVATE_KEY: wrongPrivate}), /Sealed configuration/);
});
test("sealed payload cannot override encryption or download-signing secrets", async () => {
  for (const key of ["DOWNLOAD_SECRET", "ISO_CONFIG_PRIVATE_KEY", "__proto__", "arbitrary"]) {
    const dangerous = JSON.parse('{"' + key + '":"forbidden"}');
    await assert.rejects(sealRuntimeConfig(dangerous, descriptor), /invalid/);
  }
});
test("sealing rejects invalid booleans and oversized plaintext", async () => {
  await assert.rejects(sealRuntimeConfig({ENABLED: "yes"}, descriptor), /invalid/);
  await assert.rejects(sealRuntimeConfig({PAYPAL_PDT_TOKEN: "A".repeat(2048), PAYPAL_ITEM_NAME: "B".repeat(2048), DRIVE_DOWNLOAD_URL: "C".repeat(100)}, descriptor), /invalid/);
});
test("bootstrap atomically adds only isolated runtime secrets and never exposes provider bodies", async () => {
  const calls = [];
  const result = await bootstrapRuntime(bootstrapOptions(async (url, options) => {
    calls.push({url, options});
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer " + token);
    if (options.method === "GET") return cfResult([]);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body.secrets).sort(), ["DOWNLOAD_SECRET", "ISO_CONFIG_PRIVATE_KEY", "ISO_CONFIG_PUBLIC_KEY"]);
    assert.equal(body.secrets.ISO_CONFIG_PRIVATE_KEY.text, privateKey);
    assert.deepEqual(JSON.parse(body.secrets.ISO_CONFIG_PUBLIC_KEY.text), descriptor);
    return cfResult([{text: "not-returned-to-caller"}]);
  }));
  assert.deepEqual(result, {createdKeyPair: true, createdSigningSecret: true});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith("/workers/scripts/j2534-iso-fulfillment/secrets-bulk"));
  assert.equal(calls[1].options.method, "PATCH");
});
test("bootstrap never rotates an existing complete key pair or signing secret", async () => {
  let calls = 0;
  const result = await bootstrapRuntime(bootstrapOptions(async () => {calls++; return cfResult(["ISO_CONFIG_PRIVATE_KEY", "ISO_CONFIG_PUBLIC_KEY", "DOWNLOAD_SECRET"].map(name => ({name})));}, {generate: () => {throw new Error("Must not rotate keys");}, signingSecret: () => {throw new Error("Must not rotate signing secret");}}));
  assert.deepEqual(result, {createdKeyPair: false, createdSigningSecret: false});
  assert.equal(calls, 1);
});
for (const name of ["ISO_CONFIG_PRIVATE_KEY", "ISO_CONFIG_PUBLIC_KEY"]) {
  test("partial runtime key pair is left unchanged: " + name, async () => {
    let calls = 0;
    await assert.rejects(bootstrapRuntime(bootstrapOptions(async () => {calls++; return cfResult([{name}]);})), /incomplete/);
    assert.equal(calls, 1);
  });
}
test("bootstrap can add a missing signing secret without touching existing key pair", async () => {
  const result = await bootstrapRuntime(bootstrapOptions(async (url, options) => {
    if (options.method === "GET") return cfResult(["ISO_CONFIG_PRIVATE_KEY", "ISO_CONFIG_PUBLIC_KEY"].map(name => ({name})));
    assert.deepEqual(Object.keys(JSON.parse(options.body).secrets), ["DOWNLOAD_SECRET"]);
    return cfResult([]);
  }, {generate: () => {throw new Error("Must not rotate");}}));
  assert.deepEqual(result, {createdKeyPair: false, createdSigningSecret: true});
});
for (const status of [301, 302, 307, 308, 403, 500]) {
  test("Cloudflare bootstrap refuses HTTP " + status + " without following or exposing secrets", async () => {
    let calls = 0;
    await assert.rejects(bootstrapRuntime(bootstrapOptions(async () => {calls++; return new Response(token + privateKey, {status});})), error => {
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(privateKey), false);
      return /HTTP/.test(error.message);
    });
    assert.equal(calls, 1);
  });
}
test("invalid deployment account prevents any network request", async () => {
  await assert.rejects(bootstrapRuntime(bootstrapOptions(async () => {throw new Error("Must not fetch");}, {accountId: "../other-account"})), /credentials/);
});
test("Cloudflare success=false body is not echoed into errors", async () => {
  await assert.rejects(bootstrapRuntime(bootstrapOptions(async () => new Response(JSON.stringify({success: false, errors: [{message: token + privateKey}]})))), error => !error.message.includes(token) && !error.message.includes(privateKey));
});
