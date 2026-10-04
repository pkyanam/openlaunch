import importlib.util
import hashlib
import json
import ssl
import unittest
import uuid
from unittest import mock

spec = importlib.util.spec_from_file_location("provision_esp32", "scripts/provision-esp32.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class Esp32ProvisionTests(unittest.TestCase):
    def test_config_frame_is_bounded_and_preserves_open_wifi(self):
        frame = p.make_config_payload(
            "https://bridge.example", "a" * 64, "Workshop", "", "b" * 64,
            "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
        )
        payload = json.loads(frame)
        self.assertEqual(payload["command"], "configure")
        self.assertEqual(payload["password"], "")
        self.assertEqual(payload["url"], "https://bridge.example")
        self.assertLessEqual(len(frame), p.MAX_FRAME)

    def test_rejects_unsafe_origins_and_invalid_pairing_values(self):
        for origin in (
            "http://bridge.example", "https://bridge.example:8443",
            "https://user:pass@bridge.example", "https://bridge.example/path",
            "https://bridge.example?token=x",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                p.validate_origin(origin)
        valid = ("https://bridge.example", "a" * 64, "Workshop", "",
                 "b" * 64, "-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----")
        for changed in (
            (valid[0], "A" * 64, *valid[2:]),
            (valid[0], valid[1], "", *valid[3:]),
            (valid[0], valid[1], "x" * 33, *valid[3:]),
            (valid[0], valid[1], valid[2], "p" * 65, *valid[4:]),
            (*valid[:4], "bad-token", valid[5]),
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                p.make_config_payload(*changed)

    def test_sdk_token_derives_workspace_and_keeps_idempotency_id(self):
        workspace = "a" * 64
        token = f"ol_sdk_{workspace}_{'b' * 64}"
        request_id = str(uuid.uuid4())
        frame = p.make_config_payload(
            "https://bridge.example", None, "Workshop", "", "",
            "-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----",
            sdk_token=token, request_id=request_id, request_created_at_ms=123456789,
        )
        payload = json.loads(frame)
        self.assertEqual(payload["workspace"], workspace)
        self.assertEqual(payload["sdkToken"], token)
        self.assertEqual(payload["requestId"], request_id)
        self.assertEqual(payload["requestCreatedAtMs"], 123456789)
        self.assertEqual(payload["enrollmentToken"], "")
        agent_token = f"ol_agent_{workspace}_{'c' * 64}"
        self.assertIsNone(p.parse_sdk_token(agent_token))
        with self.assertRaisesRegex(ValueError, "does not match"):
            p.make_config_payload(
                "https://bridge.example", "c" * 64, "Workshop", "", "",
                "-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----",
                sdk_token=token, request_id=request_id, request_created_at_ms=123456789,
            )
        with self.assertRaisesRegex(ValueError, "stable UUID"):
            p.make_config_payload(
                "https://bridge.example", workspace, "Workshop", "", "",
                "-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----",
                sdk_token=token, request_id="not-a-uuid", request_created_at_ms=123456789,
            )
        with self.assertRaisesRegex(ValueError, "creation timestamp"):
            p.make_config_payload(
                "https://bridge.example", workspace, "Workshop", "", "",
                "-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----",
                sdk_token=token, request_id=request_id,
            )

    def test_command_allowlist_and_port_filter(self):
        self.assertEqual(json.loads(p.make_command("status"))["command"], "status")
        for command in ("configure", "erase", "status\n{}"): 
            with self.subTest(command=command), self.assertRaises(ValueError):
                p.make_command(command)
        for port in ("/dev/cu.usbmodem123", "/dev/ttyACM0", "/dev/ttyUSB0"):
            p.validate_port(port)
        for port in ("/tmp/file", "COM3", "../../device", "/dev/cu.usb/../../tmp/file"):
            with self.subTest(port=port), self.assertRaises(ValueError):
                p.validate_port(port)

    def test_serial_reader_keeps_multiple_events_from_one_read(self):
        session = p.SerialSession("unused")
        session.fd = 7
        events = b'{"event":"paired"}\r\n{"event":"warning"}\n'
        with mock.patch.object(p.select, "select", return_value=([7], [], [])), \
             mock.patch.object(p.os, "read", return_value=events):
            self.assertEqual(session.read_event(1)["event"], "paired")
            self.assertEqual(session.read_event(1)["event"], "warning")

    def test_ca_file_rejects_non_certificate_data(self):
        with mock.patch.object(p.Path, "read_text", return_value="not a certificate"):
            with self.assertRaises(ValueError):
                p.read_ca_file("unused")

    def test_live_raw_health_and_wrapped_compatibility_require_protocol_version(self):
        p.validate_health_payload(b'{"service":"openlaunch","protocolVersion":1}')
        p.validate_health_payload(b'{"data":{"service":"openlaunch","protocolVersion":1}}')
        with self.assertRaisesRegex(ValueError, "protocol v1"):
            p.validate_health_payload(b'{"service":"openlaunch","protocolVersion":2}')
        self.assertIsNone(p.RejectRedirects().redirect_request(None, None, 302, "Found", {}, "https://other.example/healthz"))

    def test_bundled_public_ca_fingerprint_and_custom_ca_requirement(self):
        der = ssl.PEM_cert_to_DER_cert(p.PUBLIC_ROOT_PEM)
        self.assertEqual(hashlib.sha256(der).hexdigest(), p.PUBLIC_ROOT_SHA256)
        pem, context = p.read_bridge_ca(p.PUBLIC_ORIGIN)
        self.assertEqual(pem, p.PUBLIC_ROOT_PEM)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        with self.assertRaisesRegex(ValueError, "require --ca-file"):
            p.read_bridge_ca("https://bridge.example")

    def test_health_probe_sends_identifying_user_agent_and_accepts_live_shape(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.read.return_value = b'{"service":"openlaunch","protocolVersion":1}'
        opener = mock.MagicMock()
        opener.open.return_value = response
        with mock.patch.object(p.urllib.request, "build_opener", return_value=opener):
            p.verify_bridge(p.PUBLIC_ORIGIN, object())
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "openlaunch-provisioner/1")


if __name__ == "__main__":
    unittest.main()
