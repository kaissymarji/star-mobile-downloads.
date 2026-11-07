// Star Mobile Service donation counter — Cloudflare Worker / D1.
// NEVER put PayPal credentials in this public source file.
const allowedOrigin = 'https://kaissymarji.github.io';
const PAYPAL_API = 'https://api-m.paypal.com';

const corsHeaders = (origin) => ({
  'access-control-allow-origin': origin === allowedOrigin ? allowedOrigin : allowedOrigin,
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'Origin'
});

function reply(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(origin)
    }
  });
}

function dollarsToCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

async function accessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials not configured');
  const response = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'authorization': 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('Could not authenticate with PayPal');
  const data = await response.json();
  if (!data.access_token) throw new Error('PayPal did not return an access token');
  return data.access_token;
}

async function verifyPayPalWebhook(headers, event, env, token) {
  if (!env.PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID not configured');
  const field = name => headers.get(name);
  const required = [
    'paypal-transmission-id', 'paypal-transmission-time', 'paypal-cert-url',
    'paypal-auth-algo', 'paypal-transmission-sig'
  ];
  if (required.some(name => !field(name))) return false;
  const payload = {
    transmission_id: field('paypal-transmission-id'),
    transmission_time: field('paypal-transmission-time'),
    cert_url: field('paypal-cert-url'),
    auth_algo: field('paypal-auth-algo'),
    transmission_sig: field('paypal-transmission-sig'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: event
  };
  const response = await fetch(PAYPAL_API + '/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error('PayPal signature verification service unavailable');
  const verification = await response.json();
  return verification.verification_status === 'SUCCESS';
}

async function readOrder(orderId, token) {
  const response = await fetch(PAYPAL_API + '/v2/checkout/orders/' + encodeURIComponent(orderId), {
    headers: { 'authorization': 'Bearer ' + token, 'accept': 'application/json' }
  });
  // Some Pay Links cannot be read through the merchant's newly created REST app.
  // Do not retry unrelated/inaccessible orders indefinitely.
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error('PayPal order lookup temporarily unavailable');
  return response.json();
}

// Fail closed: a payment MUST be attributable to this particular fundraiser.
// Pay Links do not guarantee that the link ID will appear at any particular
// position in a capture webhook; check real test events before going live.
function matchesFundraiser(capture, order, env) {
  const link = env.PAYPAL_LINK_ID || 'PLB-DSQXGYUD97NK';
  const marker = env.PAYPAL_DONATION_CUSTOM_ID || 'STAR_MOBILE_FUNDRAISER';
  const observedLinks = [
    capture?.payment_link_id,
    capture?.payment_resource_id,
    capture?.supplementary_data?.payment_link_id,
    order?.payment_link_id,
    order?.payment_resource_id,
    order?.supplementary_data?.payment_link_id,
    ...((order?.purchase_units || []).map(unit => unit.payment_link_id))
  ];
  const attributedToFundraiser = observedLinks.includes(link) ||
    capture?.custom_id === marker ||
    (order?.purchase_units || []).some(unit => unit.custom_id === marker);
  if (!attributedToFundraiser) return false;

  // Optional additional check for merchants using more than one PayPal account.
  if (env.PAYPAL_MERCHANT_ID) {
    const merchant = capture?.payee?.merchant_id ||
      order?.purchase_units?.[0]?.payee?.merchant_id;
    if (merchant !== env.PAYPAL_MERCHANT_ID) return false;
  }
  return true;
}

async function getPublicFunding(env, origin) {
  if (!env.DB) return reply({error:'Counter database not configured'}, 503, origin);
  const row = await env.DB.prepare(
    `SELECT
      (SELECT COALESCE(SUM(cents),0) FROM donations) AS donated,
      (SELECT COALESCE(SUM(r.cents),0) FROM refunds r INNER JOIN donations d ON d.capture_id=r.capture_id) AS refunded,
      (SELECT MAX(received_at) FROM donations) AS last_donation,
      (SELECT MAX(received_at) FROM refunds) AS last_refund`
  ).first();
  const baseline = Number(env.STARTING_RAISED_CENTS || '10500');
  const goal = Number(env.GOAL_DOLLARS || '5000');
  if (!Number.isSafeInteger(baseline) || baseline < 0 || !Number.isFinite(goal) || goal <= 0) {
    return reply({error:'Invalid funding configuration'}, 503, origin);
  }
  const raised = Math.max(0, baseline + Number(row?.donated || 0) - Number(row?.refunded || 0)) / 100;
  const recent = [row?.last_donation, row?.last_refund].filter(Boolean).sort().pop() || '2026-11-06';
  return reply({goal, raised, updatedAt:recent, source:'paypal-verified'}, 200, origin);
}

async function acceptWebhook(request, env) {
  if (!env.DB || !env.PAYPAL_WEBHOOK_ID || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return reply({error:'Secure webhook configuration incomplete'}, 503);
  }
  const raw = await request.text();
  if (raw.length > 150000) return reply({error:'Payload too large'}, 413);
  let event;
  try { event = JSON.parse(raw); } catch { return reply({error:'Invalid event JSON'}, 400); }
  if (!event || typeof event !== 'object') return reply({error:'Invalid event'}, 400);
  try {
    const token = await accessToken(env);
    const verified = await verifyPayPalWebhook(request.headers, event, env, token);
    if (!verified) return reply({error:'Invalid PayPal signature'}, 403);

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;
      if (!capture || capture.status !== 'COMPLETED' || !capture.id ||
          capture.amount?.currency_code !== 'USD') return reply({status:'ignored'}, 200);
      const cents = dollarsToCents(capture.amount.value);
      if (cents === null) return reply({status:'ignored'}, 200);
      const orderId = capture.supplementary_data?.related_ids?.order_id;
      let order = null;
      const directlyLinked = matchesFundraiser(capture, null, env);
      if (!directlyLinked && orderId) {
        order = await readOrder(orderId, token);
      }
      if (!matchesFundraiser(capture, order, env)) {
        console.info('Verified capture ignored: fundraiser attribution unavailable', {hasOrderId:!!orderId});
        return reply({status:'ignored'}, 200);
      }
      await env.DB.prepare(
        'INSERT OR IGNORE INTO donations (capture_id, order_id, cents, received_at) VALUES (?, ?, ?, ?)'
      ).bind(capture.id, orderId || '', cents, event.create_time || new Date().toISOString()).run();
      return reply({status:'recorded'}, 200);
    }

    if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      const refund = event.resource;
      const captureId = refund?.supplementary_data?.related_ids?.capture_id;
      if (!refund?.id || !captureId || refund?.amount?.currency_code !== 'USD') {
        return reply({status:'ignored'}, 200);
      }
      const cents = dollarsToCents(refund.amount.value);
      if (cents === null) return reply({status:'ignored'}, 200);
      const donation = await env.DB.prepare('SELECT capture_id FROM donations WHERE capture_id = ?')
        .bind(captureId).first();
      if (!donation) return reply({status:'ignored'}, 200);
      await env.DB.prepare(
        'INSERT OR IGNORE INTO refunds (refund_id, capture_id, cents, received_at) VALUES (?, ?, ?, ?)'
      ).bind(refund.id, captureId, cents, event.create_time || new Date().toISOString()).run();
      return reply({status:'refund-recorded'}, 200);
    }
    return reply({status:'ignored'}, 200);
  } catch (error) {
    console.error('PayPal webhook processing failed', String(error?.message || error));
    return reply({error:'Payment validation or processing unavailable; PayPal may retry'}, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS' && url.pathname === '/api/funding') {
      return new Response(null, {status:204, headers:corsHeaders(origin)});
    }
    if (request.method === 'GET' && url.pathname === '/api/funding') {
      try { return await getPublicFunding(env, origin); }
      catch (error) { console.error('Funding read failed', String(error?.message || error)); return reply({error:'Funding data unavailable'}, 503, origin); }
    }
    if (request.method === 'POST' && url.pathname === '/api/paypal-webhook') {
      return acceptWebhook(request, env);
    }
    return reply({error:'Not found'}, 404, origin);
  }
};

export {dollarsToCents, matchesFundraiser};
