const DOWNLOADS_URL = "https://kaissymarji.github.io/star-mobile-downloads./";

const responseHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.paypal.com; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

function paypalCheckoutUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  return /^https:\/\/www\.paypal\.com\/ncp\/payment\/[A-Z0-9-]{8,64}$/.test(value) ? value : null;
}

function page(title, content, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Star Mobile Service</title>
  <style>
    :root { color-scheme: dark; background: #08141e; color: #f1f8fa; font: 100%/1.6 system-ui, sans-serif; }
    main { box-sizing: border-box; max-width: 42rem; margin: 8vh auto; padding: clamp(1.25rem, 5vw, 3rem); }
    h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.15; }
    a { color: #58e9ec; }
    form { margin: 1.5rem 0; }
    label { display: flex; align-items: baseline; gap: .55rem; }
    input { accent-color: #58e9ec; }
    button { margin-top: 1rem; padding: .7rem 1.2rem; border: 0; border-radius: .45rem; color: #08141e; background: #58e9ec; font: inherit; font-weight: 700; cursor: pointer; }
    :focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
    .brand { color: #b4c8d1; font-weight: 650; }
  </style>
</head>
<body>
  <main>
    <a class="brand" href="${DOWNLOADS_URL}">Star Mobile Service downloads</a>
    <h1>${title}</h1>
    ${content}
  </main>
</body>
</html>`, { status, headers: { ...responseHeaders, "content-type": "text/html; charset=utf-8" } });
}

function checkoutPage() {
  return page("Nissan key programming requests", `
    <p>The one-time <strong>$5 USD</strong> fee covers review of your request. Star Mobile Service confirms availability and quotes any programming separately.</p>
    <p>You’ll need to show proof of ownership or authorization before scheduling. After paying, text your PayPal transaction ID and the vehicle year and model to start the review.</p>
    <form method="post" action="/checkout">
      <label><input type="checkbox" name="authorized" value="yes" required> I own this vehicle or have the owner’s authorization to request service.</label>
      <button type="submit">Continue to PayPal · $5 USD</button>
    </form>
    <p><a href="/return">Already paid? Send your request details</a></p>`);
}

function unavailablePage() {
  return page("Checkout is unavailable", `<p>The $5 Nissan service request checkout is temporarily unavailable.</p>
    <p><a href="/return">Already paid? Send your request details</a></p>`, 503);
}

function returnPage() {
  return page("Send your Nissan service request", `<p>If you completed PayPal checkout, text your PayPal transaction ID and vehicle year and model to <a href="sms:+19252789301">925-278-9301</a>.</p>
    <p>Star Mobile Service will verify payment and follow up about proof of ownership or authorization, availability, and any programming fees. Wait for instructions before sending documents.</p>
    <p><a href="/checkout">Back to checkout</a></p>`);
}

async function startCheckout(request, url, checkoutUrl) {
  if (!checkoutUrl) return unavailablePage();
  if (request.headers.get("origin") !== url.origin) {
    return page("Open the checkout page", '<p><a href="/checkout">Return to the Nissan request page</a> to continue.</p>', 403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/x-www-form-urlencoded") {
    return page("Open the checkout page", '<p><a href="/checkout">Return to the Nissan request page</a> to continue.</p>', 415);
  }

  const confirmations = new URLSearchParams(await request.text()).getAll("authorized");
  if (confirmations.length !== 1 || confirmations[0] !== "yes") {
    return page("Confirm authorization", '<p><a href="/checkout">Return to the Nissan request page</a> and confirm your authorization before paying.</p>', 400);
  }

  return new Response(null, { status: 303, headers: { ...responseHeaders, location: checkoutUrl } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const checkoutUrl = paypalCheckoutUrl(env.PAYPAL_CHECKOUT_URL);

    if (request.method === "GET") {
      if (url.pathname === "/health") {
        return Response.json({ checkoutReady: Boolean(checkoutUrl) }, { headers: responseHeaders });
      }
      if (url.pathname === "/checkout") return checkoutUrl ? checkoutPage() : unavailablePage();
      if (url.pathname === "/return") return returnPage();
    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      return startCheckout(request, url, checkoutUrl);
    }

    return page("Page unavailable", '<p><a href="/checkout">Go to Nissan service requests</a>.</p>', 404);
  },
};
