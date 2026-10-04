#!/usr/bin/env python3
"""Acceptance checks for the self-serve Pi installer using mocked downloads."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install-pi.sh"
WORKSPACE = "a" * 64
ENROLLMENT = "ol_sdk_" + WORKSPACE + "_" + "b" * 64
ARTIFACT_URL = "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm64"


MOCK_CURL = r'''#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
output = args[args.index("--output") + 1]
url = args[-1]
if os.environ.get("TEST_CURL_FAIL") == "1" and not url.endswith("manifest.json"):
    sys.exit(22)
if os.environ.get("TEST_CURL_SLEEP") == "1" and not url.endswith("manifest.json"):
    open(os.environ["TEST_CURL_MARKER"], "w").close()
    import time
    time.sleep(30)
source = os.environ["TEST_MANIFEST"] if url.endswith("manifest.json") else os.environ["TEST_ARTIFACT"]
shutil.copyfile(source, output)
'''

MOCK_UNAME = r'''#!/usr/bin/env sh
case "$1" in
  -s) printf '%s\n' "${TEST_UNAME_S:-Linux}" ;;
  -m) printf '%s\n' "${TEST_UNAME_M:-aarch64}" ;;
  *) exit 2 ;;
esac
'''

MOCK_DEVICE = r'''#!/usr/bin/env bash
set -eu
[[ "${OPENLAUNCH_SDK_TOKEN:-}" == "$TEST_EXPECT_TOKEN" ]] || exit 71
for arg in "$@"; do
  [[ "$arg" != "$TEST_EXPECT_TOKEN" ]] || exit 72
done
config=""
while (($#)); do
  if [[ "$1" == --config ]]; then config="$2"; shift 2; else shift; fi
done
[[ -n "$config" ]] || exit 73
[[ "${TEST_ENROLL_FAIL:-0}" != 1 ]] || exit 74
mkdir -p "$(dirname "$config")"
umask 077
cat > "$config" <<'JSON'
{"url":"https://www.openlaunch.dev","workspace":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","deviceId":"test-device","token":"device-credential","simulate":false}
JSON
'''


class PiInstallerAcceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="openlaunch-pi-test-")
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "mock-bin"
        self.bin.mkdir()
        self.manifest_path = self.root / "manifest.json"
        self.artifact_path = self.root / "artifact"
        self.artifact_path.write_text(MOCK_DEVICE)
        self._executable(self.bin / "curl", MOCK_CURL)
        self._executable(self.bin / "uname", MOCK_UNAME)
        self.set_manifest(ARTIFACT_URL, hashlib.sha256(MOCK_DEVICE.encode()).hexdigest())

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def _executable(path, contents):
        path.write_text(contents)
        path.chmod(0o755)

    def set_manifest(self, url, digest):
        manifest = {
            "version": "0.1.0-test.1",
            "commit": "1234567890abcdef1234567890abcdef12345678",
            "artifacts": {
                "linux-arm64": {"url": url, "sha256": digest},
                "linux-arm": {"url": "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm", "sha256": digest},
            },
        }
        self.manifest_path.write_text(json.dumps(manifest))

    def run_installer(self, **overrides):
        env = os.environ.copy()
        env.update({
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{env['PATH']}",
            "TEST_MANIFEST": str(self.manifest_path),
            "TEST_ARTIFACT": str(self.artifact_path),
            "TEST_EXPECT_TOKEN": ENROLLMENT,
            "OPENLAUNCH_WORKSPACE_ID": WORKSPACE,
            "OPENLAUNCH_SDK_TOKEN": ENROLLMENT,
            "TEST_UNAME_S": "Linux",
            "TEST_UNAME_M": "aarch64",
        })
        env.update(overrides)
        return subprocess.run([str(INSTALLER)], env=env, text=True, capture_output=True, check=False)

    def test_installs_verified_binary_and_private_config_without_token_in_argv(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        binary = self.home / ".local/bin/openlaunch-device"
        config = self.home / ".config/openlaunch/device.json"
        self.assertTrue(binary.is_file())
        self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(config.parent.stat().st_mode), 0o700)
        self.assertEqual(json.loads(config.read_text())["simulate"], False)
        self.assertNotIn(ENROLLMENT, result.stdout + result.stderr)
        self.assertIn("process health only", result.stdout)

    def test_rejects_legacy_agent_token_before_download(self):
        result = self.run_installer(OPENLAUNCH_SDK_TOKEN=ENROLLMENT.replace("ol_sdk_", "ol_agent_"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy agent tokens cannot pair devices", result.stderr)
        self.assertFalse((self.home / ".local/bin/openlaunch-device").exists())

    def test_rejects_unsupported_cpu_before_download(self):
        result = self.run_installer(TEST_UNAME_M="armv6l")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported CPU architecture", result.stderr)
        self.assertFalse((self.home / ".config/openlaunch/device.json").exists())

    def test_selects_armv7_artifact_for_32_bit_os(self):
        result = self.run_installer(TEST_UNAME_M="armv7l")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("linux-arm", result.stdout)
        self.assertTrue((self.home / ".local/bin/openlaunch-device").is_file())

    def test_requires_https_and_canonical_artifact_origin(self):
        for url in (
            "http://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm64",
            "https://attacker.example/downloads/pi/openlaunch-device-linux-arm64",
        ):
            self.set_manifest(url, hashlib.sha256(MOCK_DEVICE.encode()).hexdigest())
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("artifact URL must be HTTPS", result.stderr)
            self.assertFalse((self.home / ".local/bin/openlaunch-device").exists())

    def test_rejects_sha256_mismatch(self):
        self.set_manifest(ARTIFACT_URL, "0" * 64)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256", result.stderr)
        self.assertFalse((self.home / ".config/openlaunch/device.json").exists())

    def test_interrupted_download_leaves_no_installed_files(self):
        result = self.run_installer(TEST_CURL_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not download the Pi binary", result.stderr)
        self.assertFalse((self.home / ".local/bin/openlaunch-device").exists())
        self.assertFalse((self.home / ".config/openlaunch/device.json").exists())

    def test_sigterm_during_download_leaves_no_installed_files(self):
        marker = self.root / "curl-started"
        env = os.environ.copy()
        env.update({
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{env['PATH']}",
            "TEST_MANIFEST": str(self.manifest_path),
            "TEST_ARTIFACT": str(self.artifact_path),
            "TEST_EXPECT_TOKEN": ENROLLMENT,
            "TEST_CURL_SLEEP": "1",
            "TEST_CURL_MARKER": str(marker),
            "OPENLAUNCH_WORKSPACE_ID": WORKSPACE,
            "OPENLAUNCH_SDK_TOKEN": ENROLLMENT,
        })
        process = subprocess.Popen([str(INSTALLER)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.time() + 5
            while not marker.exists() and time.time() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), "installer never began the artifact download")
            os.killpg(process.pid, 15)
            _, stderr = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0, stderr)
            self.assertFalse((self.home / ".local/bin/openlaunch-device").exists())
            self.assertFalse((self.home / ".config/openlaunch/device.json").exists())
        finally:
            if process.poll() is None:
                os.killpg(process.pid, 9)
                process.communicate(timeout=5)

    def test_refuses_to_replace_existing_identity(self):
        config = self.home / ".config/openlaunch/device.json"
        config.parent.mkdir(parents=True)
        config.write_text('{"existing":true}')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to overwrite existing device identity", result.stderr)
        self.assertEqual(config.read_text(), '{"existing":true}')

    def test_attachment_failure_warns_to_check_inventory(self):
        result = self.run_installer(TEST_ENROLL_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Attachment did not finish", result.stderr)
        self.assertIn("Check device inventory before starting another request", result.stderr)
        self.assertFalse((self.home / ".local/bin/openlaunch-device").exists())
        self.assertFalse((self.home / ".config/openlaunch/device.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
