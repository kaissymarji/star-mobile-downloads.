# GitHub Pages integration (separate, no breaking scanner/download changes)

Existing public downloads: https://kaissymarji.github.io/star-mobile-downloads./

To add optional sign-in and technician community to the *existing* public site,
copy `community.html`, `community.css`, `community.js`, `account-actions.js` and `community-config.js`
from this folder into the **root** of `kaissymarji/star-mobile-downloads.`.
Replace the three PUBLIC values in `community-config.js` with the configured
Supabase project URL, its `sb_publishable_...` key and the deployed Cloudflare
Worker URL. Keep all secrets out of GitHub Pages.

Add this link anywhere in the existing `index.html` navigation or app cards:

    <a href="./community.html#account">Sign In / My Activations</a>
    <a href="./community.html#community">Technician Community</a>

**Do not** make login mandatory for APK downloads or put this page in front of
the release assets. Existing GitHub Release asset URLs and counters remain
unchanged. The `community.js` code reads the same Realtime/Storage backend as
Android `CommunityActivity`, so users can sign in either on the web or app.

Email confirmation/recovery redirect URI in Supabase Auth allow list:
`https://kaissymarji.github.io/star-mobile-downloads./community.html`

The source is READY TO DEPLOY after services are configured. It has NOT been
committed to the user's live Pages repository by this source package, and
unconfigured account controls explicitly say setup is required (no fake login).
