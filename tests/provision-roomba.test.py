import importlib.util
import json
import pathlib
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

path = pathlib.Path(__file__).resolve().parents[1] / 'scripts/provision-roomba.py'
spec = importlib.util.spec_from_file_location('provision_roomba', path)
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)

WORKSPACE = 'a' * 64
TOKEN = f'ol_sdk_{WORKSPACE}_' + 'b' * 64
REQUEST_ID = '12345678-1234-4234-8234-123456789abc'


class ProvisionTests(unittest.TestCase):
    def test_sdk_payload_contains_durable_attach_identity_and_no_persisted_state(self):
        data = provision.make_payload('https://www.openlaunch.dev', 'test-network',
                                      'fixture-password', TOKEN, REQUEST_ID, 1900000000123)
        payload = json.loads(data)
        self.assertEqual(payload['command'], 'configure')
        self.assertEqual(payload['mode'], 'sdk')
        self.assertEqual(payload['model'], '551')
        self.assertEqual(payload['workspace'], WORKSPACE)
        self.assertEqual(payload['masterAuthorization'], TOKEN)
        self.assertEqual(payload['requestId'], REQUEST_ID)
        self.assertEqual(payload['requestCreatedAtMs'], 1900000000123)
        self.assertTrue(data.endswith(b'\n'))
        self.assertLessEqual(len(data), provision.MAX_LINE)

    def test_legacy_agent_token_cannot_attach(self):
        with self.assertRaisesRegex(ValueError, 'legacy agent tokens cannot pair'):
            provision.workspace_from_token(f'ol_agent_{WORKSPACE}_' + 'c' * 64)

    def test_rejects_unsafe_origin_bad_token_and_firmware_overflow(self):
        for args in [
            ('http://example.org', 'test', 'test', TOKEN),
            ('https://example.org/path', 'test', 'test', TOKEN),
            ('https://user@example.org', 'test', 'test', TOKEN),
            ('https://example.org', 'test', 'test', 'b' * 64),
            ('https://example.org', 'x' * 33, 'test', TOKEN),
            ('https://example.org', 'test', 'p' * 65, TOKEN),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                provision.make_payload(*args)
        with self.assertRaises(ValueError):
            provision.make_payload('https://example.org', 'test', 'test', TOKEN, 'bad-id', 1)

    def test_health_probe_accepts_raw_and_wrapped_protocol_one_and_sets_user_agent(self):
        for body in [
            b'{"service":"openlaunch","protocolVersion":1}',
            b'{"data":{"service":"openlaunch","protocolVersion":1}}',
        ]:
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = 'https://www.openlaunch.dev/healthz'
            response.read.return_value = body
            opener = MagicMock()
            opener.open.return_value = response
            with patch.object(provision.urllib.request, 'build_opener', return_value=opener):
                provision.verify_bridge('https://www.openlaunch.dev')
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_header('User-agent'), provision.USER_AGENT)
            self.assertEqual(request.full_url, 'https://www.openlaunch.dev/healthz')

    def test_health_probe_rejects_wrong_version_redirect_and_oversize(self):
        with self.assertRaises(ValueError):
            provision.validate_health({'protocolVersion': 2})
        opener = MagicMock()
        opener.open.side_effect = urllib.error.HTTPError(
            'https://www.openlaunch.dev/healthz', 302, 'redirect', {}, None)
        with patch.object(provision.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'redirected'):
                provision.verify_bridge('https://www.openlaunch.dev')
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = 'https://www.openlaunch.dev/healthz'
        response.read.return_value = b'x' * 4097
        opener.open.side_effect = None
        opener.open.return_value = response
        with patch.object(provision.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'too large'):
                provision.verify_bridge('https://www.openlaunch.dev')

    def test_sketch_runs_child_identity_recovery_at_startup_and_blocks_unsafe_configure(self):
        sketch = (path.parent.parent / 'firmware/uno-r4-wifi/openlaunch_roomba/openlaunch_roomba.ino').read_text()
        setup = sketch.split('void setup() {', 1)[1].split('void emitStatus()', 1)[0]
        self.assertIn('const bool configLoaded = loadConfig();', setup)
        self.assertIn('recoverBootstrapAtStartup(configLoaded);', setup)
        self.assertLess(setup.index('loadConfig();'), setup.index('recoverBootstrapAtStartup(configLoaded);'))
        self.assertIn('bootstrapState = loadBootstrap();', sketch.split('bool recoverBootstrapAtStartup', 1)[1].split('bool post(', 1)[0])
        recovery = sketch.split('bool recoverBootstrapAtStartup', 1)[1].split('bool post(', 1)[0]
        self.assertIn('roombaBootstrapNeedsStartupCleanup(', recovery)
        self.assertIn('if (!clearBootstrap())', recovery)

        configure = sketch.split('bool configureSdk(JsonObjectConst input)', 1)[1].split('void handleProvisioningLine', 1)[0]
        guard = configure.index('if (configStorageFault || resultJournalFault ||')
        write = configure.index('EEPROM.put(0, next);')
        self.assertLess(guard, write)
        self.assertIn('bootstrapState != RoombaBootstrapState::Empty', configure[:write])


if __name__ == '__main__':
    unittest.main()
