/* Cloudflare-only trial helpers. A pseudonymous Android-derived device ID is
 * HMAC'd again on the server, so raw Android IDs never reach the database.
 * This is best-effort account/device binding, not hardware attestation.
 */
const DEVICE_ID=/^[A-Za-z0-9_-]{12,90}$/;
const KEY_HEX=/^[a-f0-9]{64}$/;
const enc=new TextEncoder();
export function validDeviceId(id){return typeof id==='string' && DEVICE_ID.test(id);}
export async function deviceHash(signingSecret,id){
  if(!signingSecret || signingSecret.length<32 || !validDeviceId(id))throw new Error('Invalid device trial input');
  const key=await crypto.subtle.importKey('raw',enc.encode(signingSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const raw=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('V200:device-trial:v1:'+id)));
  return Array.from(raw,b=>b.toString(16).padStart(2,'0')).join('');
}
export function safeTrialDecision(rows){
  const item=Array.isArray(rows)?rows[0]:rows;
  if(!item || typeof item!=='object')throw new Error('Malformed trial database response');
  const state=item.state;
  if(!['reserved','active','used','claimed_by_other_account','unauthorized','not_started','auto_scan_required'].includes(state))throw new Error('Unknown trial state');
  if('permitted' in item && typeof item.permitted!=='boolean')throw new Error('Malformed trial authorization');
  if('started' in item && typeof item.started!=='boolean')throw new Error('Malformed trial start');
  if('finished' in item && typeof item.finished!=='boolean')throw new Error('Malformed trial finish');
  return item;
}
export function validHash(value){return typeof value==='string'&&KEY_HEX.test(value);}
