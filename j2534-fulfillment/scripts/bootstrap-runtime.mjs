// Run only in the deployment job. Never print API credentials or response bodies.
import {generateKeyPairSync, randomBytes} from "node:crypto";
import {pathToFileURL} from "node:url";
import {publicKeyDescriptor} from "../src/sealed-config.mjs";

const SCRIPT = "j2534-iso-fulfillment";
function credentials(token, accountId) {
  if (typeof token !== "string" || !token.trim() || !/^[a-f0-9]{32}$/i.test(accountId || "")) throw new Error("Cloudflare deployment credentials are missing or invalid");
}
async function request(fetcher, url, token, method = "GET", body) {
  let response;
  try {response = await fetcher(url, {method, redirect: "manual", headers: {Authorization: "Bearer " + token, "Content-Type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});}
  catch {throw new Error("Cloudflare secret request was unavailable");}
  if (response.status !== 200) throw new Error("Cloudflare secret request failed (HTTP " + response.status + ")");
  let result;
  try {result = await response.json();} catch {throw new Error("Cloudflare returned an invalid secret response");}
  if (result.success !== true) throw new Error("Cloudflare secret request was not successful");
  return result.result;
}
function generatePair() {
  const pair = generateKeyPairSync("rsa", {modulusLength: 4096, publicExponent: 65537});
  return {privateKey: pair.privateKey.export({type: "pkcs8", format: "der"}).toString("base64url"), publicKey: pair.publicKey.export({format: "jwk"})};
}
export async function bootstrapRuntime({token, accountId, fetcher = fetch, generate = generatePair, signingSecret = () => randomBytes(48).toString("base64url")}) {
  credentials(token, accountId);
  const base = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/workers/scripts/" + SCRIPT;
  const list = await request(fetcher, base + "/secrets", token);
  if (!Array.isArray(list) || list.some(value => typeof value?.name !== "string")) throw new Error("Cloudflare secret list was invalid");
  const names = new Set(list.map(value => value.name));
  const hasPrivate = names.has("ISO_CONFIG_PRIVATE_KEY"), hasPublic = names.has("ISO_CONFIG_PUBLIC_KEY");
  if (hasPrivate !== hasPublic) throw new Error("Runtime encryption keys are incomplete; existing keys were not changed");
  const secrets = {};
  const add = (name, text) => {secrets[name] = {name, text, type: "secret_text"};};
  if (!hasPrivate) {
    const generated = generate();
    const descriptor = await publicKeyDescriptor(generated.publicKey);
    if (typeof generated.privateKey !== "string" || !generated.privateKey) throw new Error("Runtime encryption key generation failed");
    add("ISO_CONFIG_PRIVATE_KEY", generated.privateKey);
    add("ISO_CONFIG_PUBLIC_KEY", JSON.stringify(descriptor));
  }
  if (!names.has("DOWNLOAD_SECRET")) {
    const generated = signingSecret();
    if (typeof generated !== "string" || generated.length < 32) throw new Error("Download signing secret generation failed");
    add("DOWNLOAD_SECRET", generated);
  }
  if (Object.keys(secrets).length) await request(fetcher, base + "/secrets-bulk", token, "PATCH", {secrets});
  return {createdKeyPair: !hasPrivate, createdSigningSecret: !names.has("DOWNLOAD_SECRET")};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await bootstrapRuntime({token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID});
    console.log("Isolated Worker runtime keys checked; secret values were not printed.");
  } catch (error) {
    // Messages are deliberately fixed by the functions above; no provider body is included.
    console.error(error instanceof Error ? error.message : "Runtime key initialization failed");
    process.exitCode = 1;
  }
}
