#!/usr/bin/env python3
"""Generate a public EEPROM Studio update manifest from a VERIFIED GitHub Release.

No private signing keys or subscription credentials are required. This script
refuses wrong app identities, signing certs, mismatched asset hashes and
downgrades. It never touches the private app source.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

REPO = "kaissymarji/star-mobile-downloads."
PACKAGE = "com.starmobileservice.xp400studio"
CERT = "e577cb4bb5462535f95a95152dc4e5d3ffd00c261ddeb3408ef4453ce80e4875"
TAG = re.compile(r"^v([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$")
APK_LIMIT = 150_000_000

class InvalidRelease(ValueError):
    pass

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def parse_badging(output):
    match = re.search(
        r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'",
        output, re.MULTILINE)
    if not match:
        raise InvalidRelease("APK package metadata missing")
    return match.group(1), int(match.group(2)), match.group(3)

def parse_certificate(output):
    digests = re.findall(
        r"^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$",
        output, re.MULTILINE)
    if len(digests) != 1:
        raise InvalidRelease("Expected exactly one APK signer")
    return digests[0].lower()

def verify_release(release, apk_path, tools_dir, previous=None):
    if not isinstance(release, dict) or release.get("draft") is not False:
        raise InvalidRelease("Release is not published")
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not TAG.fullmatch(tag):
        raise InvalidRelease("Release tag must match vMAJOR.MINOR.PATCH")
    version_name = tag[1:]
    allowed = ("EEPROM-Studio.apk", "EEPROM-Studio-" + version_name + ".apk")
    assets = [item for item in release.get("assets", [])
              if isinstance(item, dict) and item.get("name") in allowed]
    if len(assets) != 1:
        raise InvalidRelease("Release must contain exactly one official EEPROM Studio APK")
    asset = assets[0]
    filename = asset["name"]
    url = f"https://github.com/{REPO}/releases/download/{tag}/{filename}"
    if asset.get("state") != "uploaded" or asset.get("browser_download_url") != url:
        raise InvalidRelease("Release asset URL or state invalid")
    apk_path = Path(apk_path)
    actual_size = apk_path.stat().st_size
    if not 100000 <= actual_size <= APK_LIMIT or asset.get("size") != actual_size:
        raise InvalidRelease("APK file size differs from release asset metadata")
    with apk_path.open("rb") as stream:
        actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if asset.get("digest") != "sha256:" + actual_hash:
        raise InvalidRelease("Public asset SHA-256 digest mismatch")
    tools = Path(tools_dir)
    package, code, apk_version = parse_badging(run(str(tools / "aapt"), "dump", "badging", str(apk_path)))
    if package != PACKAGE or apk_version != version_name or not 101 <= code <= 2147483647:
        raise InvalidRelease("APK package, version code or release tag mismatch")
    signer = parse_certificate(
        run(str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk_path)))
    if signer != CERT:
        raise InvalidRelease("Wrong Android signing certificate")
    notes = re.sub(r"\s+", " ", str(release.get("body") or ("EEPROM Studio " + version_name))).strip()[:350]
    fresh = {
        "schema": 1,
        "packageName": PACKAGE,
        "versionCode": code,
        "versionName": version_name,
        "minSupportedVersionCode": 0,
        "apkReleaseUrl": url,
        "apkSha256": actual_hash,
        "apkBytes": actual_size,
        "signingCertSha256": CERT,
        "notes": notes
    }
    if previous is not None:
        if (previous.get("packageName") != PACKAGE
                or previous.get("signingCertSha256") != CERT):
            raise InvalidRelease("Existing update feed has wrong signing identity")
        prev_code = previous.get("versionCode")
        if type(prev_code) is not int:
            raise InvalidRelease("Existing version code invalid")
        if code == prev_code and (previous.get("apkSha256") != actual_hash
                                  or previous.get("apkReleaseUrl") != url):
            raise InvalidRelease("Cannot change APK bytes or URL within the same version")
        if code < prev_code:
            print("Older release ignored, no downgrade.")
            return None
    return fresh

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--build-tools", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    release = json.loads(args.release.read_text(encoding="utf-8"))
    previous = json.loads(args.previous.read_text(encoding="utf-8")) if args.previous.exists() else None
    result = verify_release(release, args.apk, args.build_tools, previous)
    if result is not None:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print("Updated public update.json to validated APK version " + str(result["versionCode"]))

if __name__ == "__main__":
    main()
