# V200 Automatic Unique Activation PIN — deployment status

**Not active yet:** The public website cannot validate a Stripe charge or securely generate a license. Do not display a PIN, store the activation signing secret in JavaScript, or claim payment verification based on a success-page redirect.

The V200 v1.2.1 backend source already has the core server-only workflow:
- A signed-in user starts an account-linked Stripe Checkout through `POST /api/checkout/start`.
- Stripe sends a signed `checkout.session.completed` (or asynchronous payment success) webhook to a Cloudflare Worker.
- The Worker verifies the signature, correct `plink_` Payment Link ID, USD $5 price, and account checkout reference, then stores a purchase in Supabase.
- A customer signed in to a confirmed account can reveal a unique per-account/per-device code through `GET /api/activation?device_id=...&reveal=1`, and validate through `POST /api/license/check`.
- Refund and dispute events revoke a purchase. Previously paid, unlinked Stripe checkouts need verified recovery using their Checkout Session ID and confirmed account email.

## Remaining required setup
1. **Backend source and a manual GitHub deployment workflow are already committed** in [`activation-backend/`](activation-backend/) and [GitHub Actions](../../actions/workflows/deploy-v200-activation.yml). Add the required GitHub Actions repository secrets as explained in [`activation-backend/README.md`](activation-backend/README.md), then run the deployment workflow. Never commit `.dev.vars`, `sb_secret_...`, `sk_live_...`, `whsec_...`, or HMAC secrets to this public repository.
2. The GitHub deployment workflow securely uploads GitHub Actions secrets into Cloudflare Worker encrypted secrets. Verify your Supabase project and RLS, and identify the **internal** Stripe `plink_` ID corresponding to the existing $5 buy link. None of these secret values have been configured by ChatGPT.
3. Add a Stripe webhook endpoint `https://YOUR-WORKER.workers.dev/api/stripe/webhook` with the checkout success/failure and refund/dispute events. Copy its unique signing secret to the Worker (not this repo).
4. The deployment workflow can update the **public** `activationWorkerUrl` in this website's `community-config.js` after the Worker public URL is known and `/health` succeeds. For Android builds, independently set it in `app/src/main/assets/community-config.js` and build/sign an update.
5. Redirect Stripe completion to the account page after verifying the end-to-end flow. A redirect does **not** mean payment succeeded.
6. Test with Stripe test mode: one paid account gets its own code; unpaid, refunded, and second-user attempts get no valid code. The current Android diagnostic module is **not** natively locked by this license.

Until these steps are complete, website payment links route to the account page instead of charging customers with no automatic PIN fulfillment. **The backend has not been deployed; no automatic activation is live yet.**

## Earlier payments
Existing payments through the old direct payment link were not automatically associated with a technician account. Do not charge again. Look up the original paid Checkout Session in Stripe and use the backend's `/api/claim-previous` flow after deployment; it checks the Stripe transaction and confirmed account email.
