# EEPROM Studio — Upload one signed APK to release automatically

This public repository distributes compiled application APKs only. **Never upload private Java/Android source, Google or Stripe keys, APK signing keystores, customer data, or EEPROM dumps.**

## One-time setup (already automated by GitHub Actions)

The update manifest is `update.json` in the repository root. It starts at **1.0.1**, the verified, permanently signed production release.

The two release workflows are:

- `.github/workflows/upload-apk-auto-publish.yml`: reacts whenever `apk/EEPROM-Studio.apk` is replaced in the `main` branch. It verifies the APK then publishes a matching GitHub Release and refreshes `update.json`.
- `.github/workflows/automatic-updates.yml`: if you manually publish a GitHub Release instead, it verifies and refreshes the same feed.

Both workflows reject the wrong app, incorrect permanent Android signing certificate, changed bytes at the same version, or a lower version code.

If automatic publishing fails with **Resource not accessible by integration**, in the repository settings under **Actions → General → Workflow permissions** enable **Read and write permissions** for the repository's `GITHUB_TOKEN`. Do not create a personal access token for this.

## Every new release — just ONE APK upload

1. First compile a new signed APK in the **private** EEPROM-Studio project, using the established permanent signing key.
2. Keep the same app ID `com.starmobileservice.xp400studio`. Increase `versionCode` and set a matching `versionName`, e.g. code **102** and name **1.0.2**.
3. In this public repository open the `apk` folder and replace or upload the compiled file under the exact name `EEPROM-Studio.apk` (case-sensitive).
4. Commit to `main` and open the **Actions** tab. The workflow verifies it and automatically creates release tag `v1.0.2`, an official APK download, and a new `update.json`.
5. On an existing signed EEPROM Studio installation, **Check app updates** will offer the newer version after Cloudflare's one-time evergreen Worker upgrade. Android prompts the user to approve installing the APK.

You **do not** need to edit Cloudflare or `update.json` again for each release.

If you want to keep using GitHub's manual **Releases → Draft a new release** instead, you can publish one signed APK named `EEPROM-Studio.apk` or `EEPROM-Studio-1.0.2.apk` attached to tag `v1.0.2`. The other workflow updates `update.json` automatically.

## Notes and limitations

- The current installed APK update checker only *opens the official release link*. It does not silently install apps or bypass Android's permission dialog.
- The Cloudflare Worker must be upgraded **once** to read public `update.json`; simply creating this file does not change the currently deployed Worker.
- A new XP400 MCU protocol or any native APK change always needs a new signed APK. UI-only online updates use a separate mechanism.
- Do not overwrite an already-published version using different APK bytes. Increase the version code and version name for every changed release.
- Experimental MCU operations should be tested on unsecured spare hardware before being described as production-supported.
