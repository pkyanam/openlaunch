import importlib.util
import json
import unittest
import uuid
from unittest import mock

spec = importlib.util.spec_from_file_location("provision_uno", "scripts/provision-uno.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProvisionTests(unittest.TestCase):
    def test_default_sdk_token_payload_derives_workspace_and_reuses_request_id(self):
        workspace = "0" * 64
        token = f"ol_sdk_{workspace}_{'a' * 64}"
        request_id = str(uuid.uuid4())
        data = json.loads(p.make_payload(
            "https://devices.example.com", None, "Workshop", "wifi-secret", token,
            request_id=request_id, request_created_at_ms=123456789,
        ))
        self.assertEqual(data["host"], "devices.example.com")
        self.assertEqual(data["workspace"], workspace)
        self.assertEqual(data["mode"], "sdk")
        self.assertEqual(data["requestId"], request_id)
        self.assertEqual(data["requestCreatedAtMs"], 123456789)
        self.assertEqual(data["token"], token)

    def test_legacy_enrollment_is_explicit_and_compatible(self):
        data = json.loads(p.make_payload(
            "https://devices.example.com", "0" * 64, "Workshop", "", "a" * 64,
            legacy_enrollment=True,
        ))
        self.assertEqual(data["mode"], "enrollment")
        self.assertEqual(data["requestId"], "")
        self.assertEqual(data["requestCreatedAtMs"], 0)

    def test_rejects_invalid_origins_tokens_workspace_and_wifi(self):
        for origin in (
            "http://devices.example.com", "https://x.example:8443",
            "https://u:p@x.example", "https://x.example/path",
            "https://x.example?token=x",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                p.make_payload(origin, "0" * 64, "test", "", "a" * 64,
                               legacy_enrollment=True)
        with self.assertRaises(ValueError):
            p.make_payload("https://x.example", "0" * 64, "test", "", "a" * 64)
        with self.assertRaisesRegex(ValueError, "does not match"):
            p.make_payload("https://x.example", "1" * 64, "test", "", "ol_sdk_" + "0" * 64 + "_" + "a" * 64)
        with self.assertRaises(ValueError):
            p.make_payload("https://x.example", "0" * 64, "x" * 33, "", "a" * 64,
                           legacy_enrollment=True)

    def test_sdk_agent_token_workspace_parser_and_uuid_validation(self):
        workspace = "f" * 64
        self.assertEqual(p.parse_sdk_token(f"ol_agent_{workspace}_{'e' * 64}"), workspace)
        self.assertIsNone(p.parse_sdk_token("ol_sdk_bad_secret"))
        with self.assertRaisesRegex(ValueError, "stable UUID"):
            p.make_payload("https://x.example", workspace, "test", "", f"ol_sdk_{workspace}_{'e' * 64}",
                           request_id="not-a-uuid", request_created_at_ms=1)

    def test_serial_frame_bounds_and_command_allowlist(self):
        self.assertEqual(json.loads(p.make_command("status"))["command"], "status")
        with self.assertRaises(ValueError):
            p.make_command("configure")
        with self.assertRaises(ValueError):
            p.validate_port("/dev/cu.device/../../tmp/file")
        frame = p.make_payload("https://x.example", "0" * 64, "test", "", "ol_sdk_" + "0" * 64 + "_" + "a" * 64)
        self.assertLessEqual(len(frame), p.MAX_FRAME)

    def test_live_raw_health_and_wrapped_compatibility_require_protocol_version(self):
        p.validate_health_payload(b'{"service":"openlaunch","protocolVersion":1}')
        p.validate_health_payload(b'{"data":{"service":"openlaunch","protocolVersion":1}}')
        with self.assertRaisesRegex(ValueError, "protocol v1"):
            p.validate_health_payload(b'{"service":"openlaunch","protocolVersion":2}')
        self.assertIsNone(p.RejectRedirects().redirect_request(None, None, 302, "Found", {}, "https://other.example/healthz"))

    def test_health_probe_sends_identifying_user_agent_and_accepts_live_shape(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.read.return_value = b'{"service":"openlaunch","protocolVersion":1}'
        opener = mock.MagicMock()
        opener.open.return_value = response
        with mock.patch.object(p.urllib.request, "build_opener", return_value=opener):
            p.verify_bridge("https://www.openlaunch.dev")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "openlaunch-provisioner/1")

    def test_event_reader_preserves_extra_json_lines_in_one_read(self):
        session = p.SerialSession("unused")
        session.fd = 7
        chunk = b'{"event":"configured"}\r\n{"event":"paired"}\n'
        with mock.patch.object(p.select, "select", return_value=([7], [], [])), \
             mock.patch.object(p.os, "read", return_value=chunk):
            self.assertEqual(session.read_event(1)["event"], "configured")
            self.assertEqual(session.read_event(1)["event"], "paired")


if __name__ == "__main__":
    unittest.main()
