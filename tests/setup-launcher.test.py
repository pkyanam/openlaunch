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

    def test_cli_install_uses_user_prefix_and_adds_path_once_without_touching_links(self):
        data = b'fixture archive'
        manifest = {'commit': COMMIT, 'sdk': {
            'url': setup.ORIGIN + '/downloads/openlaunch-sdk.tgz?commit=' + COMMIT,
            'sha256': hashlib.sha256(data).hexdigest(),
        }}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            user = directory / 'user'
            user.mkdir()
            target = directory / 'external-profile'
            target.write_text('preserve\n')
            (user / '.zprofile').symlink_to(target)
            (user / '.zshrc').write_text('existing config\n')
            with patch.object(setup, 'fetch', return_value=data), patch.object(setup.shutil, 'which', return_value='/tool'), patch.object(setup.subprocess, 'run') as run:
                for _ in range(2):
                    setup.install_cli(manifest, directory, user, {'SHELL': '/bin/zsh'})
            self.assertEqual(target.read_text(), 'preserve\n')
            profile = (user / '.zshrc').read_text()
            self.assertTrue(profile.startswith('existing config\n'))
            self.assertEqual(profile.count('# openlaunch CLI'), 1)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn(['npm', 'install', '--global', '--prefix', str(user / '.local'),
                           '--ignore-scripts', '--no-audit', '--no-fund', str(directory / ('openlaunch-sdk-' + COMMIT + '.tgz'))], commands)
            self.assertIn([str(user / '.local/bin/ol'), '--help'], commands)
            self.assertFalse(any('--force' in command or 'sudo' in command for command in commands))

    def test_real_cli_archive_installs_offline_and_refuses_an_unrelated_ol(self):
        data = (ROOT / 'apps/site/public/downloads/openlaunch-sdk.tgz').read_bytes()
        manifest = {'commit': COMMIT, 'sdk': {
            'url': setup.ORIGIN + '/downloads/openlaunch-sdk.tgz?commit=' + COMMIT,
            'sha256': hashlib.sha256(data).hexdigest(),
        }}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            user = directory / 'user'
            with patch.object(setup, 'fetch', return_value=data):
                setup.install_cli(manifest, directory, user, {'SHELL': '/bin/bash'})
            cli = user / '.local/bin/ol'
            result = subprocess.run([str(cli), '--version'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('0.1.0-dev.g', result.stdout)
            result = subprocess.run([str(cli), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('ol login', result.stdout)
            self.assertTrue((user / '.local/bin/openlaunch-device').is_file())
            self.assertTrue((user / '.local/bin/openlaunch-agent').is_file())
            self.assertTrue((user / '.local/bin/openlaunch-ha').is_file())
            result = subprocess.run([str(user / '.local/bin/openlaunch-ha'), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('openlaunch-ha setup', result.stdout)
            cli.unlink()
            cli.write_text('unrelated program\n')
            with patch.object(setup, 'fetch', return_value=data):
                with self.assertRaisesRegex(ValueError, 'unrelated executable'):
                    setup.install_cli(manifest, directory, user, {'SHELL': '/bin/bash'})
            self.assertEqual(cli.read_text(), 'unrelated program\n')

    def test_bash_keeps_existing_login_profile_precedence(self):
        data = b'fixture archive'
        manifest = {'commit': COMMIT, 'sdk': {
            'url': setup.ORIGIN + '/downloads/openlaunch-sdk.tgz?commit=' + COMMIT,
            'sha256': hashlib.sha256(data).hexdigest(),
        }}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            user = directory / 'user'
            user.mkdir()
            (user / '.profile').write_text('existing login configuration\n')
            with patch.object(setup, 'fetch', return_value=data), patch.object(setup.shutil, 'which', return_value='/tool'), patch.object(setup.subprocess, 'run'):
                setup.install_cli(manifest, directory, user, {'SHELL': '/bin/bash'})
            self.assertFalse((user / '.bash_profile').exists())
            self.assertIn('existing login configuration', (user / '.profile').read_text())
            self.assertIn('# openlaunch CLI', (user / '.profile').read_text())

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
                    if b'Choose setup [1-9]:' in output and not sent:
                        os.write(fd, b'0\n')
                        sent = True
                    if b'Choose a number from 1 to 9.' in output:
                        break
            self.assertIn(b'1. Uno R4 WiFi USB setup', output)
            self.assertIn(b'6. Local developer console', output)
            self.assertIn(b'7. Install ol CLI on PATH', output)
            self.assertIn(b'8. Linux host control harness', output)
            self.assertIn(b'9. Home Assistant gateway', output)
            self.assertIn(b'Choose a number from 1 to 9.', output)
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
