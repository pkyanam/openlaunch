#!/usr/bin/env python3
"""Provision an ESP32 over USB serial without storing credentials in source."""
import argparse
import hashlib
import getpass
import json
import os
import re
import select
import ssl
import sys
import termios
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlsplit

MAX_FRAME = 8192
MAX_RESPONSE_LINE = 2048
PUBLIC_ORIGIN = "https://www.openlaunch.dev"
PUBLIC_ROOT_SHA256 = "349dfa4058c5e263123b398ae795573c4e1313c83fe68f93556cd5e8031b3c7d"
PUBLIC_ROOT_PEM = """-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
"""


def validate_origin(origin):
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid HTTPS bridge origin") from exc
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in ("", "/") or port not in (None, 443)):
        raise ValueError("ESP32 requires a bare HTTPS bridge origin on port 443")
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", parsed.hostname):
        raise ValueError("Invalid bridge hostname")
    return f"https://{parsed.hostname.lower()}"


def read_ca_file(path):
    try:
        pem = Path(path).read_text(encoding="ascii")
    except (OSError, UnicodeError) as exc:
        raise ValueError("Could not read the trusted PEM CA file") from exc
    if (len(pem.encode("ascii")) > 4095 or
            "-----BEGIN CERTIFICATE-----" not in pem or
            "-----END CERTIFICATE-----" not in pem):
        raise ValueError("Trusted CA must be PEM certificates no larger than 4095 bytes")
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.verify_mode = ssl.CERT_REQUIRED
        context.check_hostname = True
        context.load_verify_locations(cadata=pem)
        return pem, context
    except ssl.SSLError as exc:
        raise ValueError("Trusted CA file is not a valid PEM certificate bundle") from exc


def read_bridge_ca(origin, ca_file=None):
    if ca_file:
        return read_ca_file(ca_file)
    if origin != PUBLIC_ORIGIN:
        raise ValueError("Custom bridge origins require --ca-file")
    try:
        der = ssl.PEM_cert_to_DER_cert(PUBLIC_ROOT_PEM)
        if hashlib.sha256(der).hexdigest() != PUBLIC_ROOT_SHA256:
            raise ValueError("Bundled public bridge CA fingerprint check failed")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.verify_mode = ssl.CERT_REQUIRED
        context.check_hostname = True
        context.load_verify_locations(cadata=PUBLIC_ROOT_PEM)
        return PUBLIC_ROOT_PEM, context
    except ssl.SSLError as exc:
        raise ValueError("Bundled public bridge CA is invalid") from exc


def validate_health_payload(body):
    try:
        payload = json.loads(body)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Bridge returned an invalid health response") from exc
    if not isinstance(payload, dict):
        raise ValueError("HTTPS endpoint did not identify itself as openlaunch")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if data.get("service") != "openlaunch" or data.get("protocolVersion") != 1:
        raise ValueError("HTTPS endpoint did not identify itself as openlaunch protocol v1")


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _new_url):
        return None


def verify_bridge(origin, context):
    request = urllib.request.Request(
        origin + "/healthz", headers={"User-Agent": "openlaunch-provisioner/1"}, method="GET"
    )
    opener = urllib.request.build_opener(
        RejectRedirects(), urllib.request.HTTPSHandler(context=context)
    )
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError("Bridge HTTPS health check failed")
            body = response.read(2049)
    except (OSError, urllib.error.URLError, ssl.SSLError) as exc:
        raise ValueError("Bridge TLS check failed with the supplied CA") from exc
    if len(body) > 2048:
        raise ValueError("Bridge health response exceeded its size limit")
    validate_health_payload(body)


def parse_sdk_token(value):
    match = re.fullmatch(r"ol_(?:sdk|agent)_([a-f0-9]{64})_([a-f0-9]{64})", value or "")
    return match.group(1) if match else None


def make_config_payload(origin, workspace, ssid, password, enrollment_token, root_ca,
                        sdk_token="", request_id="", request_created_at_ms=0):
    origin = validate_origin(origin)
    if sdk_token:
        token_workspace = parse_sdk_token(sdk_token)
        if not token_workspace or (workspace and workspace != token_workspace):
            raise ValueError("Invalid SDK token or workspace does not match its token")
        workspace = token_workspace
        try:
            if str(uuid.UUID(request_id)) != request_id:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("SDK attachment requires a stable UUID request ID") from exc
        if not isinstance(request_created_at_ms, int) or request_created_at_ms <= 0:
            raise ValueError("SDK attachment requires a request creation timestamp")
    elif not re.fullmatch(r"[a-f0-9]{64}", workspace or "") or not re.fullmatch(
            r"[a-f0-9]{64}", enrollment_token or ""):
        raise ValueError("Provide a workspace ID and one-time enrollment token")
    if not 1 <= len(ssid.encode("utf-8")) <= 32 or len(password.encode("utf-8")) > 64:
        raise ValueError("Wi-Fi SSID/password exceed ESP32 limits")
    if (len(root_ca.encode("ascii")) > 4095 or
            "-----BEGIN CERTIFICATE-----" not in root_ca or
            "-----END CERTIFICATE-----" not in root_ca):
        raise ValueError("Trusted CA must contain PEM certificate data within 4095 bytes")
    payload = {
        "command": "configure",
        "ssid": ssid,
        "password": password,
        "url": origin,
        "workspace": workspace,
        "enrollmentToken": enrollment_token,
        "sdkToken": sdk_token,
        "requestId": request_id,
        "requestCreatedAtMs": request_created_at_ms,
        "rootCa": root_ca,
    }
    frame = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
    if len(frame) > MAX_FRAME:
        raise ValueError("Provisioning frame exceeds ESP32 serial limit")
    return frame


def make_command(command):
    if command not in ("status", "reset", "discard_pending_result"):
        raise ValueError("Unsupported ESP32 serial command")
    return json.dumps({"command": command}, separators=(",", ":")).encode("ascii") + b"\n"


def validate_port(port):
    if not (re.fullmatch(r"/dev/cu\.[A-Za-z0-9._-]+", port) or
            re.fullmatch(r"/dev/ttyACM[0-9]+", port) or
            re.fullmatch(r"/dev/ttyUSB[0-9]+", port)):
        raise ValueError("Use the confirmed USB serial device path, not a file")


class SerialSession:
    def __init__(self, port):
        self.port = port
        self.fd = None
        self.original = None
        self.read_buffer = bytearray()

    def __enter__(self):
        self.fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            self.original = termios.tcgetattr(self.fd)
            settings = termios.tcgetattr(self.fd)
            settings[0] = 0
            settings[1] = 0
            settings[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            settings[3] = 0
            settings[4] = settings[5] = termios.B115200
            settings[6][termios.VMIN] = 0
            settings[6][termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, settings)
            time.sleep(2)
            termios.tcflush(self.fd, termios.TCIFLUSH)
            return self
        except Exception:
            os.close(self.fd)
            self.fd = None
            raise

    def __exit__(self, _kind, _value, _traceback):
        if self.fd is not None:
            try:
                termios.tcsetattr(self.fd, termios.TCSANOW, self.original)
            finally:
                os.close(self.fd)

    def send(self, data):
        if len(data) > MAX_FRAME or not data.endswith(b"\n"):
            raise ValueError("Serial frame exceeds its bound")
        remaining = memoryview(data)
        deadline = time.monotonic() + 10
        while remaining:
            if time.monotonic() > deadline:
                raise TimeoutError("USB serial write timed out")
            if select.select([], [self.fd], [], 0.5)[1]:
                written = os.write(self.fd, remaining)
                if written <= 0:
                    raise OSError("USB serial write failed")
                remaining = remaining[written:]

    def read_event(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            newline = self.read_buffer.find(b"\n")
            if newline >= 0:
                raw = bytes(self.read_buffer[:newline]).rstrip(b"\r")
                del self.read_buffer[:newline + 1]
                if len(raw) <= MAX_RESPONSE_LINE:
                    try:
                        event = json.loads(raw.decode("utf-8"))
                        if isinstance(event, dict) and isinstance(event.get("event"), str):
                            return event
                    except (UnicodeError, json.JSONDecodeError):
                        pass
                continue
            if len(self.read_buffer) > MAX_RESPONSE_LINE:
                newline = self.read_buffer.find(b"\n")
                if newline < 0:
                    self.read_buffer.clear()
                else:
                    del self.read_buffer[:newline + 1]
                continue
            readable, _, _ = select.select([self.fd], [], [], min(0.5, max(0, deadline - time.monotonic())))
            if not readable:
                continue
            self.read_buffer.extend(os.read(self.fd, 512))
        raise TimeoutError("No ESP32 protocol response before timeout; raw serial output is withheld")


def open_and_query(port):
    session = SerialSession(port)
    session.__enter__()
    try:
        session.send(make_command("status"))
        response = session.read_event(8)
        if response.get("event") != "status":
            raise RuntimeError("ESP32 did not return status")
        return session, response
    except Exception:
        session.__exit__(None, None, None)
        raise


def show_status(port):
    with SerialSession(port) as serial:
        serial.send(make_command("status"))
        state = serial.read_event(8)
    if state.get("event") == "error":
        raise RuntimeError("ESP32 could not read stored configuration")
    print(f"ESP32 state: {state.get('state', 'unknown')}; pending result: "
          f"{'yes' if state.get('pendingResult') else 'no'}")


def reset_device(port):
    serial, state = open_and_query(port)
    try:
        print("This erases ESP32 network settings, device identity, and any pending result.")
        if input("Type reset to continue: ") != "reset":
            return
        serial.send(make_command("reset"))
        response = serial.read_event(8)
        if response.get("event") != "reset":
            raise RuntimeError("ESP32 reset was not confirmed")
        print("ESP32 configuration and identity were erased.")
    finally:
        serial.__exit__(None, None, None)


def discard_result(port):
    serial, state = open_and_query(port)
    try:
        if not state.get("pendingResult"):
            print("ESP32 has no pending result to discard.")
            return
        print("Discarding the saved result report will leave the bridge action outcome ambiguous.")
        if input("Type discard to continue: ") != "discard":
            return
        serial.send(make_command("discard_pending_result"))
        response = serial.read_event(8)
        if response.get("event") != "pending_result_discarded":
            raise RuntimeError("ESP32 did not confirm pending result discard")
        print("Pending result report discarded; the device action was not rerun.")
    finally:
        serial.__exit__(None, None, None)


def provision(args):
    origin = validate_origin(args.origin)
    root_ca, tls_context = read_bridge_ca(origin, args.ca_file)
    verify_bridge(origin, tls_context)
    ssid = input("Wi-Fi SSID: ")
    password = getpass.getpass("Wi-Fi password (hidden; blank for open Wi-Fi): ")
    credential = getpass.getpass("SDK token or one-time enrollment token (hidden): ")
    sdk_workspace = parse_sdk_token(credential)
    if sdk_workspace:
        if args.workspace and args.workspace != sdk_workspace:
            raise ValueError("Workspace does not match the workspace encoded in the SDK token")
        workspace = sdk_workspace
        sdk_token, enrollment = credential, ""
        request_id = str(uuid.uuid4())
        request_created_at_ms = int(time.time() * 1000)
    else:
        workspace = args.workspace
        sdk_token, enrollment, request_id = "", credential, ""
        request_created_at_ms = 0
    frame = make_config_payload(origin, workspace, ssid, password, enrollment, root_ca,
                                sdk_token=sdk_token, request_id=request_id,
                                request_created_at_ms=request_created_at_ms)
    print("Bridge TLS verified using the supplied CA.")
    if input(f"Send configuration to ESP32 at {args.port}? Type pair: ") != "pair":
        return
    with SerialSession(args.port) as serial:
        serial.send(make_command("status"))
        status = serial.read_event(8)
        if status.get("event") != "status":
            raise RuntimeError("ESP32 did not return status; no configuration was sent")
        if status.get("state") == "paired":
            raise RuntimeError("ESP32 is already paired; use explicit reset before replacing identity")
        serial.send(frame)
        configured = False
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            response = serial.read_event(max(1, min(10, deadline - time.monotonic())))
            if response.get("event") == "configured":
                configured = True
                print("Configuration stored. Waiting for device enrollment confirmation.")
            elif response.get("event") == "paired":
                if response.get("bootstrapCredentialCleared") is False:
                    print("ESP32 paired, but could not erase the bootstrap credential from NVS yet. Keep it online while it retries local cleanup; do not send another attachment request.")
                else:
                    print("ESP32 paired. Refresh the console and verify device health before granting access.")
                return
            elif response.get("event") == "error":
                code = response.get("code", "device_error")
                if code == "enrollment_failed_check_console_before_retry":
                    raise RuntimeError("Enrollment outcome may be ambiguous; inspect console inventory before issuing another token")
                raise RuntimeError(f"ESP32 provisioning failed: {code}")
        if not configured:
            raise TimeoutError("ESP32 did not acknowledge configuration")
        raise TimeoutError("No pairing confirmation. Inspect console inventory before issuing another token; raw serial output is withheld.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Confirmed ESP32 USB serial port")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--status", action="store_true", help="Read public pairing/configuration status")
    modes.add_argument("--reset", action="store_true", help="Explicitly erase configuration and device identity")
    modes.add_argument("--discard-pending", action="store_true", help="Explicitly discard an expired result report")
    parser.add_argument("--origin", help="Bare HTTPS bridge origin")
    parser.add_argument("--workspace", help="64-character workspace ID for legacy enrollment tokens")
    parser.add_argument("--ca-file", help="Trusted PEM root certificate file")
    args = parser.parse_args(argv)
    try:
        validate_port(args.port)
        if args.status:
            show_status(args.port)
        elif args.reset:
            reset_device(args.port)
        elif args.discard_pending:
            discard_result(args.port)
        else:
            missing = [name for name in ("origin",) if not getattr(args, name)]
            if missing:
                parser.error("provisioning requires --origin (and --ca-file for custom origins)")
            provision(args)
    except (ValueError, OSError, RuntimeError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
