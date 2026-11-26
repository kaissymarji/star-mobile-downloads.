# J2534 ISO delivery from Drive

This independent Worker keeps the existing PayPal hosted link and displays the
Drive download only after server-side verification of a completed USD 100
purchase. It does not require a second 2.73 GB upload or R2/D1 bindings.
The earlier R2 staging implementation is retained separately.

The deployment workflow tests both implementations and deploys
`wrangler.drive.toml` on the `j2534-iso-fulfillment` branch. It reuses the existing
Cloudflare deployment credentials; PayPal credentials are not copied from other
products. Missing runtime configuration leaves delivery disabled.

## Runtime configuration

In the isolated `j2534-iso-fulfillment` Worker, configure:

| Name | Value |
| --- | --- |
| `PAYPAL_CHECKOUT_URL` | Existing hosted link ending `RC7EQ6XB36MWA` (already set) |
| `PAYPAL_ITEM_NAME` | `Subaru flasher` (verified from the hosted checkout) |
| `PAYPAL_MERCHANT_ID` | Merchant ID from the seller's PayPal account |
| `PAYPAL_PDT_TOKEN` | PayPal Website payment preferences identity token |
| `DOWNLOAD_SECRET` | A privately generated random secret of at least 32 characters |
| `DRIVE_DOWNLOAD_URL` | The original Drive file view URL supplied by the owner |
| `ENABLED` | Set `true` after the following settings and validation are complete |

Keep secret values in Cloudflare runtime secrets. Do not put the Drive file ID,
PDT token, or signing key in GitHub files or chat.

## PayPal connection

Enable PDT in the seller account and Auto Return for the specific hosted payment
link. Set that link's return URL to the actual deployed Worker origin plus
`/return`. Preserve other products' return settings. If PayPal only offers an
account-wide return URL, review existing products before changing it.

The buyer returns with a transaction ID. The Worker validates the merchant,
product title, completed status, USD 100 amount and single quantity with PayPal,
then issues a 24-hour signed download link. Each download checks the payment
again. A receipt transaction ID plus the matching PayPal email can recover access
at `/recover`; the buyer is never asked to pay again.

## Verification and limits

Local mocked tests cover payment matching, refused redirects, malformed provider
responses, signed-link tampering/expiry, purchase recovery and hidden Drive URLs
before verification. They do not substitute for a genuine sandbox checkout or
the seller's live account configuration. Inspect `/health` after configuration
and complete the authorized checkout validation before describing delivery as live.

This mode returns the original Drive link after payment. It does not make the
Drive file private, and a buyer can share the revealed link. It displays the
download after PayPal returns the buyer; it does not send automatic emails when
the buyer closes PayPal before returning. Webhook/email delivery requires a
separately configured verified notification provider.
