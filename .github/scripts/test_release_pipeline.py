"""Safety checks for the PUBLIC APK release pipeline, without signing secrets."""
import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,HERE/path)
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
v=load('release_verifier','verify-apk-release.py')
u=load('upload_verifier','verify-uploaded-apk.py')

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        self.apk=self.root/'EEPROM-Studio.apk'
        self.apk.write_bytes(b'non-real-package-unit-test' * 6000)
        self.digest=hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.badging="package: name='com.starmobileservice.xp400studio' versionCode='102' versionName='1.0.2'\n"
        self.cert="Signer #1 certificate SHA-256 digest: "+v.CERT+"\n"
        self.release={
            'draft':False,'tag_name':'v1.0.2','body':'Experimental unsecured MCU reads',
            'assets':[{'name':'EEPROM-Studio.apk',
                       'browser_download_url':'https://github.com/kaissymarji/star-mobile-downloads./releases/download/v1.0.2/EEPROM-Studio.apk',
                       'state':'uploaded','size':self.apk.stat().st_size,
                       'digest':'sha256:'+self.digest}]
        }
        self.current={'packageName':v.PACKAGE,'signingCertSha256':v.CERT,'versionCode':101}
    def inspect(self, release=None, badge=None, cert=None, previous=None):
        with patch.object(v,'run',side_effect=[badge or self.badging,cert or self.cert]):
            return v.verify_release(
                release or self.release,self.apk,self.root,
                self.current if previous is None else previous)
    def upload(self, badge=None, cert=None, previous=None):
        with patch.object(v,'run',side_effect=[badge or self.badging,cert or self.cert]):
            return u.verify_upload(
                self.apk,self.root,self.current if previous is None else previous)
    def test_correct_release_verifies(self):
        m=self.inspect()
        self.assertEqual(m['versionCode'],102)
        self.assertEqual(m['signingCertSha256'],v.CERT)
        self.assertEqual(m['apkSha256'],self.digest)
    def test_wrong_signer_rejected(self):
        with self.assertRaisesRegex(v.InvalidRelease,'certificate'):
            self.inspect(cert='Signer #1 certificate SHA-256 digest: '+'f'*64+'\n')
        with self.assertRaisesRegex(v.InvalidRelease,'certificate'):
            self.upload(cert='Signer #1 certificate SHA-256 digest: '+'f'*64+'\n')
    def test_wrong_package_rejected(self):
        with self.assertRaisesRegex(v.InvalidRelease,'package'):
            self.inspect(badge="package: name='com.attacker.fake' versionCode='102' versionName='1.0.2'")
        with self.assertRaisesRegex(v.InvalidRelease,'package'):
            self.upload(badge="package: name='com.attacker.fake' versionCode='102' versionName='1.0.2'")
    def test_incorrect_asset_digest_rejected(self):
        copy={**self.release,'assets':[{**self.release['assets'][0],'digest':'sha256:'+'0'*64}]}
        with self.assertRaisesRegex(v.InvalidRelease,'SHA-256'):
            self.inspect(release=copy)
    def test_bad_asset_host_rejected(self):
        copy={**self.release,'assets':[{**self.release['assets'][0],'browser_download_url':'https://evil.test/x.apk'}]}
        with self.assertRaisesRegex(v.InvalidRelease,'URL'):
            self.inspect(release=copy)
    def test_unsigned_draft_rejected(self):
        with self.assertRaisesRegex(v.InvalidRelease,'published'):
            self.inspect(release={**self.release,'draft':True})
    def test_replayed_version_same_bytes_idempotent(self):
        first=self.inspect()
        self.assertEqual(self.inspect(previous=first),first)
        with self.assertRaisesRegex(v.InvalidRelease,'same version'):
            self.inspect(previous={**first,'apkSha256':'f'*64})
    def test_old_release_never_downgrades_feed(self):
        self.assertIsNone(self.inspect(previous={**self.current,'versionCode':103}))
    def test_upload_requires_newer_version(self):
        self.assertEqual(self.upload()['tag'],'v1.0.2')
        with self.assertRaisesRegex(v.InvalidRelease,'greater'):
            self.upload(previous={**self.current,'versionCode':102})
    def test_alias_release_filename_accepted(self):
        new_name="EEPROM-Studio-1.0.2.apk"
        clone={**self.release,'assets':[{
            **self.release['assets'][0],
            'name':new_name,
            'browser_download_url':f'https://github.com/{v.REPO}/releases/download/v1.0.2/{new_name}'
        }]}
        self.assertEqual(self.inspect(release=clone)['versionCode'],102)
    def test_upload_accepts_only_fixed_name(self):
        self.apk.rename(self.root/'other.apk')
        self.apk=self.root/'other.apk'
        with self.assertRaisesRegex(v.InvalidRelease,'canonical'):
            self.upload()
    def test_multiple_signers_rejected(self):
        with self.assertRaisesRegex(v.InvalidRelease,'exactly one'):
            self.inspect(cert=self.cert+"Signer #2 certificate SHA-256 digest: "+'0'*64+"\n")

if __name__=='__main__':
    unittest.main()
