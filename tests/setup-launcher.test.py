"""Exercise download trust and helper invocation without pairing a device."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup', ROOT / 'scripts/setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
COMMIT = 'a' * 40


class SetupTests(unittest.TestCase):
    def record(self, filename, data):
        path = ('/downloads/' if filename.endswith('.py') else '/') + filename
        return {'url': setup.ORIGIN + path, 'sha256': hashlib.sha256(data).hexdigest()}

    def test_wrong_hash_and_untrusted_locations_never_execute(self):
        record = self.record('provision-uno.py', b'print("ok")')
        path = '/downloads/provision-uno.py'
        with patch.object(setup, 'fetch', return_value=b'changed'):
            with self.assertRaisesRegex(ValueError, 'checksum'):
                setup.checked_download(record, path, COMMIT, 100)
        for url in ['https://attacker.example' + path, 'http://www.openlaunch.dev' + path,
                    setup.ORIGIN + '/downloads/other.py', setup.ORIGIN + path + '#fragment',
                    'https://www.openlaunch.dev@attacker.example' + path,
                    setup.ORIGIN + path + '?commit=old']:
            with self.subTest(url=url), patch.object(setup, 'fetch') as fetch:
                with self.assertRaises(ValueError):
                    setup.checked_download({**record, 'url': url}, path, COMMIT, 100)
                fetch.assert_not_called()

    def test_usb_helpers_run_help_with_no_device_writes(self):
        for mode in ['uno', 'roomba', 'esp32']:
            filename = setup.MODES[mode][1]
            data = (ROOT / 'scripts' / filename).read_bytes()
            manifest = {'commit': COMMIT, 'installers': [self.record(filename, data)]}
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                with patch.object(setup, 'fetch', return_value=data):
                    command = setup.helper_command(mode, ['--help'], manifest, Path(temporary))
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('usage:', result.stdout)

    def test_current_archive_runs_real_adapter_cli_offline(self):
        archive = ROOT / 'apps/site/public/downloads/openlaunch-sdk.tgz'
        data = archive.read_bytes()
        manifest = {'commit': COMMIT, 'sdk': {
            'url': setup.ORIGIN + '/downloads/openlaunch-sdk.tgz?commit=' + COMMIT,
            'sha256': hashlib.sha256(data).hexdigest(),
        }}
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(setup, 'fetch', return_value=data):
                command = setup.helper_command('adapter', ['--help'], manifest, Path(temporary))
            import os
            result = subprocess.run(command, capture_output=True, text=True, timeout=60,
                                    env={**os.environ, 'npm_config_offline': 'true'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('openlaunch-device setup', result.stdout)

    def test_unknown_commit_or_missing_helper_stops(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(setup, 'fetch') as fetch:
            for manifest in [{'commit': '../main'}, {'commit': COMMIT, 'installers': []}]:
                with self.assertRaises(ValueError):
                    setup.helper_command('uno', [], manifest, Path(temporary))
            fetch.assert_not_called()

    def test_help_needs_no_network_or_terminal(self):
        with patch.object(setup, 'fetch') as fetch:
            self.assertEqual(setup.main(['--help']), 0)
            fetch.assert_not_called()

    def test_menu_reads_a_real_terminal_even_when_stdin_is_a_pipe(self):
        pid, fd = pty.fork()
        if pid == 0:
            # The public command pipes the shell script; the menu must use /dev/tty.
            os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
            os.execv(sys.executable, [sys.executable, str(ROOT / 'scripts/setup.py')])
        output = b''
        sent = False
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    if b'Choose setup [1-6]:' in output and not sent:
                        os.write(fd, b'0\n')
                        sent = True
                    if b'Choose a number from 1 to 6.' in output:
                        break
            self.assertIn(b'1. Uno R4 WiFi USB setup', output)
            self.assertIn(b'6. Local developer console', output)
            self.assertIn(b'Choose a number from 1 to 6.', output)
        finally:
            os.close(fd)
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)

    def test_redirects_are_rejected(self):
        self.assertIsNone(setup.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example'))


if __name__ == '__main__':
    unittest.main()
