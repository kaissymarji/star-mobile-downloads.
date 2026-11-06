# V200 — Verified $5 payment and per-device activation

This folder contains backend source code only. **Do not store any secret values in a public repository or client files.**

## What is implemented

- A signed-in technician starts checkout with `/api/checkout/start`. The Worker records an account-linked reference and adds it to the existing Stripe Payment Link.
- Stripe signs `checkout.session.completed` or `checkout.session.async_payment_succeeded` events. `/api/stripe/webhook` checks the exact signature, price, currency and Payment Link ID before recording the paid purchase in Supabase.
- A confirmed technician account with a paid purchase retrieves a unique deterministic code for its user ID and chosen device ID via `/api/activation?device_id=...&reveal=1`.
- `/api/license/check` validates the code for that account and device. It does not silently unlock vehicle diagnostic functions. Native feature gating needs a separate implementation and device-binding hardening.
- Refunds and disputes revoke eligible purchases when their signed Stripe event reaches the Worker.
- Older payments made on a *direct* Stripe link are not automatically linked; claim only through the server's verified `cs_live_...` lookup with matching confirmed email and unrefunded transaction.

## One-time setup (no real credentials are bundled)

1. Visit repository **Settings → Secrets and variables → Actions** and add the exact repository secret names shown in `.github/workflows/deploy-v200-activation.yml`. Do not send those values in chat. `SUPABASE_URL` is your project's https://...supabase.co root. `SUPABASE_PUBLISHABLE_KEY` is the public `sb_publishable_...` key. `SUPABASE_SECRET_KEY` is the server-only `sb_secret_...` key. Generate `ACTIVATION_HMAC_KEY` as a high-entropy random secret of at least 32 characters and keep it stable (rotation changes existing codes).
2. Use the **same Stripe mode and Payment Link ID** for `STRIPE_PAYMENT_LINK_URL`, `STRIPE_PAYMENT_LINK_ID` (`plink_...`) and `STRIPE_SECRET_KEY` (`sk_test_...` for test, `sk_live_...` for live). Do not use the `buy.stripe.com` URL as the `plink_...` ID. Verify the Payment Link charges $5 once (USD). No subscription mode is supported.
3. `ALLOWED_ORIGINS` should include `https://kaissymarji.github.io,https://community.v200.invalid` (origins only, no `/` paths).
4. Create a Cloudflare API token with limited **Workers Scripts: Edit** permission for your account and obtain the Cloudflare Account ID. Put them into the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
5. In GitHub, choose **Actions → Deploy V200 payment verification and unique activation codes → Run workflow** on the `main` branch. This workflow is **manual-only** and runs tests before deploying.
6. Copy the actual Worker HTTPS `workers.dev` address shown in the completed job; run the workflow once more with its `worker_url` field if it was not configured automatically. The workflow validates `/health` and updates the *public* website's `community-config.js`, which contains only the public Worker URL.
7. In your Stripe Dashboard, add a **webhook endpoint** at `https://YOUR-WORKER.workers.dev/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, and `charge.dispute.created`. Copy the webhook signing secret (`whsec_...`) into the GitHub Action secret, then rerun the deploy workflow. Use a test-mode webhook with the test link first.
8. Configure the Stripe Payment Link's **after-payment** behavior to redirect buyers to `https://kaissymarji.github.io/star-mobile-downloads./community.html#account`. They sign in and use **Check payment status → Show activation code**. A redirect is **not** proof of payment.
9. Build your Android APK with its own `activationWorkerUrl` set to the deployed Worker URL in `app/src/main/assets/community-config.js`; your GitHub website config does not automatically change local APK assets.

Do not advertise automatic activation until a full paid test checkout, genuine webhook receipt, code retrieval, refund/replay and second-user isolation tests pass. Configure app-side native entitlement enforcement if the activation is meant to lock premium features. Existing V200 diagnostics are not currently gated by these codes.

No Stripe secret, Supabase secret, webhook signing secret, HMAC secret, Cloudflare token, or fixed PIN is stored in this folder.