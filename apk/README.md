# Signed APK upload folder

Every new release, upload or replace this file in this folder:

**EEPROM-Studio.apk**

The automated GitHub workflow verifies the correct Android package, permanent signing certificate, increased versionCode, and SHA-256 before making a new official GitHub Release and updating the public update.json.

Do not put the signing key, passwords, Android source, or customer chip dumps here. Do not rename the uploaded file. An APK update still needs Android installation approval.
