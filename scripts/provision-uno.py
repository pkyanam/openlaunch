#!/usr/bin/env python3
"""Provision the maintained Uno R4 WiFi sketch over USB serial."""
import argparse
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
from urllib.parse import urlsplit

MAX_FRAME = 1024
MAX_EVENT_LINE = 512


def validate_origin(origin):
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid HTTPS bridge origin") from exc
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in ("", "/") or port not in (None, 443)):
        raise ValueError("Uno requires a bare HTTPS bridge origin on port 443")
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,127}", parsed.hostname):
        raise ValueError("Invalid bridge hostname")
    return f"https://{parsed.hostname.lower()}", parsed.hostname.lower()


def parse_sdk_token(token):
    match = re.fullmatch(r"ol_(?:sdk|agent)_([a-f0-9]{64})_[a-f0-9]{64}", token or "")
    return match.group(1) if match else None


def validate_health_payload(payload_bytes):
    try:
        payload = json.loads(payload_bytes)
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


def verify_bridge(origin):
    request = urllib.request.Request(
        origin + "/healthz", headers={"User-Agent": "openlaunch-provisioner/1"}, method="GET"
    )
    opener = urllib.request.build_opener(
        RejectRedirects(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError("Bridge HTTPS health check failed")
            payload_bytes = response.read(2049)
    except (OSError, urllib.error.URLError, ssl.SSLError) as exc:
        raise ValueError("Bridge TLS health check failed using system-trusted certificates") from exc
    if len(payload_bytes) > 2048:
        raise ValueError("Bridge health response exceeded its size limit")
    validate_health_payload(payload_bytes)


def make_payload(origin, workspace, ssid, password, token, request_id=None,
                 request_created_at_ms=None, legacy_enrollment=False):
    origin, host = validate_origin(origin)
    if not 1 <= len(ssid.encode("utf-8")) <= 32 or len(password.encode("utf-8")) > 64:
        raise ValueError("Wi-Fi SSID/password exceed Uno limits")
    if legacy_enrollment:
        if not re.fullmatch(r"[a-f0-9]{64}", workspace or "") or not re.fullmatch(
                r"[a-f0-9]{64}", token or ""):
            raise ValueError("Legacy enrollment requires a workspace ID and one-time enrollment token")
        mode = "enrollment"
        request_id = ""
        request_created_at_ms = 0
        wire_token = token
    else:
        token_workspace = parse_sdk_token(token)
        if not token_workspace:
            raise ValueError("Enter an SDK token; use --legacy-enrollment for one-time tokens")
        if workspace and workspace != token_workspace:
            raise ValueError("Workspace does not match the workspace encoded in the SDK token")
        workspace = token_workspace
        if request_id is None:
            request_id = str(uuid.uuid4())
        try:
            if str(uuid.UUID(request_id)) != request_id:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ValueError("SDK attachment requires a stable UUID request ID") from exc
        if request_created_at_ms is None:
            request_created_at_ms = int(time.time() * 1000)
        if not isinstance(request_created_at_ms, int) or request_created_at_ms <= 0:
            raise ValueError("SDK attachment requires a request creation timestamp")
        mode = "sdk"
        wire_token = token
    payload = {
        "command": "configure",
        "mode": mode,
        "host": host,
        "workspace": workspace,
        "ssid": ssid,
        "password": password,
        "token": wire_token,
        "requestId": request_id,
        "requestCreatedAtMs": request_created_at_ms,
    }
    data = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
    if len(data) > MAX_FRAME:
        raise ValueError("Provisioning data exceeds the Uno serial limit")
    return data


def make_command(command):
    if command not in ("status", "reset"):
        raise ValueError("Unsupported Uno serial command")
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

    def send(self, frame):
        if len(frame) > MAX_FRAME or not frame.endswith(b"\n"):
            raise ValueError("Serial frame exceeds its bound")
        remaining = memoryview(frame)
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
                if len(raw) <= MAX_EVENT_LINE:
                    try:
                        event = json.loads(raw.decode("utf-8"))
                        if isinstance(event, dict) and isinstance(event.get("event"), str):
                            return event
                    except (UnicodeError, json.JSONDecodeError):
                        pass
                continue
            if len(self.read_buffer) > MAX_EVENT_LINE:
                self.read_buffer.clear()
                continue
            readable, _, _ = select.select(
                [self.fd], [], [], min(0.5, max(0, deadline - time.monotonic())))
            if readable:
                self.read_buffer.extend(os.read(self.fd, 512))
        raise TimeoutError("No Uno protocol response before timeout; raw serial output is withheld")


def query_status(port):
    with SerialSession(port) as serial:
        serial.send(make_command("status"))
        response = serial.read_event(8)
    if response.get("event") != "status":
        raise RuntimeError("Uno did not return a usable configuration status")
    return response


def show_status(port):
    status = query_status(port)
    state = status.get("state", "unknown")
    if state == "storage_error":
        raise RuntimeError("Uno EEPROM is unknown or damaged; explicit reset is required")
    print(f"Uno state: {state}; pending result: {'yes' if status.get('pendingResult') else 'no'}")


def reset_device(port):
    with SerialSession(port) as serial:
        serial.send(make_command("status"))
        status = serial.read_event(8)
        if status.get("event") != "status":
            raise RuntimeError("Uno did not return status; reset was not sent")
        print("This erases Uno Wi-Fi settings, device identity, and local action state.")
        if input("Type reset to continue: ") != "reset":
            return
        serial.send(make_command("reset"))
        if serial.read_event(8).get("event") != "reset":
            raise RuntimeError("Uno did not confirm reset")
    print("Uno configuration and identity were erased.")


def provision(args):
    origin, _host = validate_origin(args.origin)
    verify_bridge(origin)
    print("Host HTTPS verified with system-trusted certificates; the Uno's internal CA store still needs physical TLS validation.")
    ssid = input("Wi-Fi SSID: ")
    password = getpass.getpass("Wi-Fi password (hidden; blank for open Wi-Fi): ")
    prompt = "One-time enrollment token (hidden): " if args.legacy_enrollment else "SDK token (hidden): "
    token = getpass.getpass(prompt)
    request_id = str(uuid.uuid4()) if not args.legacy_enrollment else ""
    created_ms = int(time.time() * 1000) if not args.legacy_enrollment else 0
    frame = make_payload(origin, args.workspace, ssid, password, token,
                         request_id, created_ms, args.legacy_enrollment)
    if input(f"Send configuration to Uno at {args.port}? Type pair: ") != "pair":
        return
    with SerialSession(args.port) as serial:
        serial.send(make_command("status"))
        status = serial.read_event(8)
        if status.get("event") != "status":
            raise RuntimeError("Uno did not return status; no configuration was sent")
        state = status.get("state")
        if state == "storage_error":
            raise RuntimeError("Uno EEPROM is unknown or damaged; use explicit --reset after review")
        if state == "paired":
            raise RuntimeError("Uno is already paired; preserve identity or use explicit --reset")
        if state == "configured":
            print("Uno already has saved configuration; waiting for its existing attachment attempt.")
        else:
            serial.send(frame)
        configured = state == "configured"
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            event = serial.read_event(max(1, min(10, deadline - time.monotonic())))
            if event.get("event") == "configured":
                configured = True
                print("Configuration stored. Waiting for device pairing confirmation.")
            elif event.get("event") == "paired":
                if event.get("bootstrapCredentialCleared") is False:
                    print("Uno paired, but could not clear the bootstrap token from EEPROM yet. Keep it powered while it retries local cleanup; do not submit another attachment.")
                else:
                    print("Uno paired. Refresh the console and verify device health before granting access.")
                return
            elif event.get("event") == "error":
                code = event.get("code", "device_error")
                if code == "enrollment_outcome_ambiguous_check_console":
                    raise RuntimeError("Enrollment outcome may be ambiguous; inspect console inventory before issuing another token")
                if code == "sdk_attachment_window_expired_reprovision":
                    raise RuntimeError("SDK attachment retry window expired. Inspect console inventory before resetting or issuing another request.")
                raise RuntimeError(f"Uno provisioning failed: {code}")
        if not configured:
            raise TimeoutError("Uno did not acknowledge configuration")
        raise TimeoutError("No pairing confirmation. Inspect console inventory before issuing another token; raw serial output is withheld.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="Confirmed Uno USB serial port")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--status", action="store_true", help="Read public pairing/configuration status")
    modes.add_argument("--reset", action="store_true", help="Explicitly erase saved configuration and identity")
    parser.add_argument("--origin", help="Bare HTTPS bridge origin")
    parser.add_argument("--workspace", help="Workspace ID for --legacy-enrollment")
    parser.add_argument("--legacy-enrollment", action="store_true", help="Use the older one-time enrollment token flow")
    args = parser.parse_args(argv)
    try:
        validate_port(args.port)
        if args.status:
            show_status(args.port)
        elif args.reset:
            reset_device(args.port)
        else:
            if not args.origin:
                parser.error("provisioning requires --origin")
            if args.legacy_enrollment and not args.workspace:
                parser.error("--legacy-enrollment requires --workspace")
            if args.workspace and not args.legacy_enrollment:
                parser.error("--workspace is only used with --legacy-enrollment")
            provision(args)
    except (ValueError, OSError, RuntimeError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
