# Star Mobile Service Downloads — GitHub Pages starter

This repository is for **public distribution only**. Keep source code, secret keys, customer files, unverified chip algorithms, and private test dumps in private repositories.

## Publish the page
1. On GitHub, choose **New repository**. Name it `star-mobile-downloads`, set **Public**, and create it.
2. Upload `index.html` and this `README.md` to the repository root; commit the files.
3. In repository **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/(root)`, and save.
4. The normal project URL is `https://YOUR_GITHUB_USERNAME.github.io/star-mobile-downloads/`.
5. Wait for the Pages deployment to finish and then open your website.

## Publish an APK or other downloadable file
For APKs and versioned ZIP files, prefer **GitHub Releases** over storing every version directly in the website repository:
1. Open the repository → **Releases → Draft a new release**.
2. Create a version tag (for example `v0.4.0`), write the release notes, and attach your tested `.apk` and public files.
3. Publish the release.
4. Edit `index.html`: replace the corresponding disabled `<span>` with an `<a class="button" href="ACTUAL_RELEASE_ASSET_URL">Download APK</a>` using the real asset link from the release. Change 'Release pending' to the correct tested version.
5. Commit the `index.html` change. GitHub Pages will update automatically.

Release URLs can also use this syntax after the exact repo, tag, and filename exist:
`https://github.com/YOUR_GITHUB_USERNAME/star-mobile-downloads/releases/download/v0.4.0/your-app.apk`

## Security and distribution
- **Never** place Stripe secret keys, Google OAuth client secrets, Cloudflare credentials, customer EEPROM dumps, private files, or tokens in this public repository.
- Only publish APK builds you have installed and tested. Do not describe the XP400 experimental reader as verified chip-read functionality without testing it against known-good dumps.
- GitHub Pages serves static files only. Keep account sign-in, payment, and entitlement validation on your Cloudflare Worker; never implement those protections solely in website JavaScript.
- Consider signing releases with a stable Android signing certificate; changing it can prevent users from installing updates over an existing app.
- Review licensing and third-party intellectual property before publishing any bundled software or chip algorithms.
