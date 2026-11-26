// Deployment, rather than a public HTTP endpoint, controls configuration updates.
// This module never sends plaintext configuration or keys to a remote service.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});
export const SEAL_ALGORITHM = "RSA-OAEP-256+A256GCM";
const WORKER = "j2534-iso-fulfillment";
const MAX_PLAINTEXT = 4096;
const CONFIG_KEYS = new Set(["PAYPAL_PDT_TOKEN", "PAYPAL_MERCHANT_ID", "PAYPAL_ITEM_NAME", "PAYPAL_ITEM_NUMBER", "PAYPAL_CHECKOUT_URL", "DRIVE_DOWNLOAD_URL", "ENABLED"]);
const ENVELOPE_KEYS = ["version", "algorithm", "keyId", "wrappedKey", "iv", "ciphertext"].sort();

function invalid() {throw new Error("Sealed configuration is invalid");}
function object(value) {return value !== null && typeof value === "object" && !Array.isArray(value);}
function exactKeys(value, keys) {return object(value) && Object.keys(value).sort().join("\n") === keys.join("\n");}
export function encodeBase64url(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64url(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  let binary;
  try {binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));} catch {invalid();}
  const result = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (result.length > maxBytes || encodeBase64url(result) !== value) invalid();
  return result;
}
function context(keyId) {return encoder.encode([WORKER, "sealed-config-v1", SEAL_ALGORITHM, keyId].join("\n"));}
function hex(bytes) {return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");}
export async function publicKeyDescriptor(publicKey) {
  if (!object(publicKey) || publicKey.kty !== "RSA" || publicKey.e !== "AQAB" || decodeBase64url(publicKey.n, 512).length !== 512) invalid();
  const jwk = {kty: "RSA", n: publicKey.n, e: "AQAB", alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"]};
  const keyId = hex(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({kty: jwk.kty, n: jwk.n, e: jwk.e}))));
  return {version: 1, algorithm: SEAL_ALGORITHM, keyId, publicKey: jwk};
}
async function validateDescriptor(value) {
  if (!exactKeys(value, ["version", "algorithm", "keyId", "publicKey"].sort()) || value.version !== 1 || value.algorithm !== SEAL_ALGORITHM || !/^[a-f0-9]{64}$/.test(value.keyId || "")) invalid();
  const checked = await publicKeyDescriptor(value.publicKey);
  if (checked.keyId !== value.keyId) invalid();
  return checked;
}
function checkedConfig(value) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !CONFIG_KEYS.has(key))) invalid();
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string" || !text || text !== text.trim() || text.length > 2048) invalid();
    if (key === "ENABLED" && !["true", "false"].includes(text)) invalid();
  }
  return value;
}
export async function setupKey(env) {
  if (typeof env.ISO_CONFIG_PRIVATE_KEY !== "string" || !env.ISO_CONFIG_PRIVATE_KEY || typeof env.ISO_CONFIG_PUBLIC_KEY !== "string") invalid();
  let parsed;
  try {parsed = JSON.parse(env.ISO_CONFIG_PUBLIC_KEY);} catch {invalid();}
  return validateDescriptor(parsed);
}
export async function sealRuntimeConfig(config, descriptor) {
  const checked = await validateDescriptor(descriptor);
  const plaintext = encoder.encode(JSON.stringify(checkedConfig(config)));
  if (plaintext.length > MAX_PLAINTEXT) invalid();
  const aad = context(checked.keyId);
  const publicKey = await crypto.subtle.importKey("jwk", checked.publicKey, {name: "RSA-OAEP", hash: "SHA-256"}, false, ["encrypt"]);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const [wrappedKey, ciphertext] = await Promise.all([
    crypto.subtle.encrypt({name: "RSA-OAEP", label: aad}, publicKey, raw),
    crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: aad, tagLength: 128}, aes, plaintext),
  ]);
  return {version: 1, algorithm: SEAL_ALGORITHM, keyId: checked.keyId, wrappedKey: encodeBase64url(wrappedKey), iv: encodeBase64url(iv), ciphertext: encodeBase64url(ciphertext)};
}
export function createConfigResolver(envelope) {
  let cachedEnv, cachedPromise;
  return async function resolve(env) {
    if (envelope === null) return env;
    if (cachedEnv === env && cachedPromise) return cachedPromise;
    cachedEnv = env;
    cachedPromise = (async () => {
      if (!exactKeys(envelope, ENVELOPE_KEYS) || envelope.version !== 1 || envelope.algorithm !== SEAL_ALGORITHM) invalid();
      const descriptor = await setupKey(env);
      if (envelope.keyId !== descriptor.keyId) invalid();
      const wrapped = decodeBase64url(envelope.wrappedKey, 512);
      const iv = decodeBase64url(envelope.iv, 12);
      const ciphertext = decodeBase64url(envelope.ciphertext, MAX_PLAINTEXT + 16);
      if (wrapped.length !== 512 || iv.length !== 12 || ciphertext.length < 17) invalid();
      const privateBytes = decodeBase64url(env.ISO_CONFIG_PRIVATE_KEY, 4096);
      const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, {name: "RSA-OAEP", hash: "SHA-256"}, false, ["decrypt"]);
      const aad = context(envelope.keyId);
      const raw = await crypto.subtle.decrypt({name: "RSA-OAEP", label: aad}, privateKey, wrapped);
      if (raw.byteLength !== 32) invalid();
      const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({name: "AES-GCM", iv, additionalData: aad, tagLength: 128}, aes, ciphertext);
      if (plaintext.byteLength > MAX_PLAINTEXT) invalid();
      const config = checkedConfig(JSON.parse(decoder.decode(plaintext)));
      return {...env, ...config};
    })();
    try {return await cachedPromise;} catch {throw new Error("Sealed configuration unavailable");}
  };
}
