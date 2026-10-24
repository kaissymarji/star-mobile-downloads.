#!/usr/bin/env python3
"""Fail closed before uploading one signed APK to public GitHub Releases."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("xp400_release_verifier",HERE/"verify-apk-release.py")
v=importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

def verify_upload(apk_path, tools_dir, previous):
    apk_path=Path(apk_path)
    if apk_path.name!="EEPROM-Studio.apk":
        raise v.InvalidRelease("Expected canonical uploaded filename EEPROM-Studio.apk")
    size=apk_path.stat().st_size
    if not 100000 <= size <= v.APK_LIMIT:
        raise v.InvalidRelease("Signed APK size invalid")
    tools=Path(tools_dir)
    pkg,code,version=v.parse_badging(v.run(str(tools/"aapt"),"dump","badging",str(apk_path)))
    if pkg!=v.PACKAGE or not v.TAG.fullmatch("v"+version) or not 101<=code<=2147483647:
        raise v.InvalidRelease("Invalid package, versionName or versionCode")
    cert=v.parse_certificate(v.run(
        str(tools/"apksigner"),"verify","--verbose","--print-certs",str(apk_path)))
    if cert!=v.CERT:
        raise v.InvalidRelease("APK signed with wrong certificate")
    if previous is not None:
        if previous.get("packageName")!=v.PACKAGE or previous.get("signingCertSha256")!=v.CERT:
            raise v.InvalidRelease("Existing feed signed by another certificate")
        previous_code=previous.get("versionCode")
        if type(previous_code) is not int or code<=previous_code:
            raise v.InvalidRelease("New APK versionCode must be greater than current public version")
    with apk_path.open("rb") as f:
        digest=hashlib.file_digest(f,"sha256").hexdigest()
    return {"tag":"v"+version,"versionCode":code,"versionName":version,
            "sha256":digest,"apkBytes":size}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--apk",type=Path,required=True)
    parser.add_argument("--build-tools",type=Path,required=True)
    parser.add_argument("--previous",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    previous=json.loads(args.previous.read_text(encoding="utf-8")) if args.previous.exists() else None
    result=verify_upload(args.apk,args.build_tools,previous)
    args.output.write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print("Verified uploaded APK before release: "+result["tag"])

if __name__=="__main__":
    main()
