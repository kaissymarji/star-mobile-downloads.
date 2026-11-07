# Automatic PayPal donation counter — setup required

The website already reloads `funding.json` every 15 seconds. This Worker adds **verified, automatic** payment processing and returns the public total on `GET /api/funding` when deployed and configured.

**Current status:** This is backend source, not an operating payment integration. No PayPal account or Worker is connected merely by publishing these files. Do not tell donors it is automatic until you verify a real completed payment.

## Why a backend is required

The GitHub Pages frontend cannot access private PayPal transactions. PayPal supports webhooks for Pay Links and Buttons, including `PAYMENT.CAPTURE.COMPLETED`. A verified server-side webhook can count paid transactions without exposing payment credentials to visitors.

## Deploy using Cloudflare Workers and D1

1. Install Node.js, open a CMD terminal in this folder, and run `npx wrangler login`.
2. Run `npx wrangler d1 create star-mobile-donations`. Copy the database ID from the output.
3. Copy `wrangler.example.toml` to `wrangler.toml`, and replace `REPLACE_WITH_YOUR_ACTUAL_D1_DATABASE_ID` with the real ID.
4. Run `npx wrangler d1 execute star-mobile-donations --remote --file=./schema.sql`.
5. Deploy the Worker for the first time using `npx wrangler deploy`. Copy the resulting `https://<your-worker-hostname>` URL. The webhook route will not accept payments until secrets are configured.
6. In your **PayPal business merchant** account's **Live** Developer Dashboard, create/select a suitable app, then create a webhook subscription for `https://<your-worker-hostname>/api/paypal-webhook` using events `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED`. PayPal assigns this subscription a **Webhook ID**.
7. In the Worker folder, set the three credentials as private Cloudflare Worker secrets (**never in code or GitHub**). Paste each value privately at the command-line prompt:
   - `npx wrangler secret put PAYPAL_CLIENT_ID` — the **Live** app client ID.
   - `npx wrangler secret put PAYPAL_CLIENT_SECRET` — the **Live** app secret.
   - `npx wrangler secret put PAYPAL_WEBHOOK_ID` — the **Live webhook subscription ID**, not the client ID.
8. Deploy again if needed with `npx wrangler deploy`. Visit `https://<your-worker-hostname>/api/funding` — with an empty database it must show `{"goal":5000,"raised":105,"source":"paypal-verified",...}` based on your reported opening balance.
9. **Before connecting the public page**, make a small test payment through your existing PayPal link, confirm the PayPal transaction and webhook were delivered, and ensure the counter rose by exactly that amount. Check that resending the same event doesn't count twice; optionally test a refund.
10. Edit your GitHub donation page's `LIVE_FUNDING_API` constant to `https://<your-worker-hostname>/api/funding`. After a verified successful end-to-end test, the frontend will poll the authenticated backend every 15 seconds for everyone viewing the site.

## IMPORTANT: Link attribution may need testing

Your donation link is `https://www.paypal.com/ncp/payment/PLB-DSQXGYUD97NK`. PayPal **does** support webhooks for Pay Links, but it does not guarantee the link identifier appears in a specific field of every webhook.

This implementation intentionally **ignores a payment** unless the verified capture/order has either:
- A direct PayPal Link ID equal to `PLB-DSQXGYUD97NK`, **or**
- A `custom_id` equal to `STAR_MOBILE_FUNDRAISER`.

This is deliberate: you may receive money for app activation or locksmith work in the same account. Counting *all* payments would incorrectly inflate fundraising.

If a real Pay Link donation is ignored, first inspect the webhook and order transaction structure securely, **redacting donor information**, then adapt attribution based on actual verified PayPal fields. You may need to replace the existing Pay Link with a PayPal Orders checkout that sets the custom ID. Never turn off payment verification or count other transactions just to make numbers move.

**Existing $105:** `STARTING_RAISED_CENTS = "10500"` is a manually reported opening balance. Do not import those same old transactions into the database, or they will be counted twice.

## Safety and behavior

- `/api/funding` is public and discloses only the fundraising goal, amount and update date, never donor names or emails.
- All PayPal webhook messages are verified with PayPal before processing. Invalid signatures cannot update the amount.
- Capture IDs and refund IDs are unique in D1 to prevent duplicate counting.
- Only USD completed captures tied to the fundraiser are counted. Pending/other payments are ignored.
- PayPal credentials and webhook ID are private Worker secrets.
- In case of an API or verification error, the public page continues showing the last manually reported balance and clearly labels it as such.

Docs: https://www.paypal.com/us/cshelp/article/paypal-pay-links-and-button-troubleshooting-tips-ts2341 and https://developer.paypal.com/api/rest/webhooks/rest/
