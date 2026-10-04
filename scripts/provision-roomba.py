#!/usr/bin/env python3
"""Provision an Uno R4 WiFi Roomba 551 adapter over USB without saving secrets."""
import argparse
import getpass
import json
import os
import re
import select
import subprocess
import ssl
import sys
import termios
import time
import uuid
import urllib.error
import urllib.request
from urllib.parse import urlsplit

USER_AGENT = 'openlaunch-provisioner/1'
MAX_LINE = 4096


def parse_origin(origin):
    u = urlsplit(origin)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password or
            u.query or u.fragment or u.path not in ('', '/') or u.port not in (None, 443)):
        raise ValueError('Use a bare HTTPS origin on port 443 with a trusted certificate')
    if not re.fullmatch(r'[A-Za-z0-9.-]{1,127}', u.hostname):
        raise ValueError('Invalid hostname')
    return u.hostname


def workspace_from_token(token):
    match = re.fullmatch(r'ol_sdk_([a-f0-9]{64})_[a-f0-9]{64}', token)
    if not match:
        raise ValueError('Use an ol_sdk_ token with device attachment enabled; legacy agent tokens cannot pair devices')
    return match.group(1)


def make_payload(origin, ssid, password, token, request_id=None, created_at_ms=None):
    host = parse_origin(origin)
    workspace = workspace_from_token(token)
    if not 1 <= len(ssid.encode('utf-8')) <= 32 or len(password.encode('utf-8')) > 64:
        raise ValueError('Wi-Fi SSID/password exceed firmware limits')
    request_id = request_id or str(uuid.uuid4())
    if not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', request_id):
        raise ValueError('Request ID must be a lowercase UUID')
    created_at_ms = int(time.time() * 1000) if created_at_ms is None else created_at_ms
    if not isinstance(created_at_ms, int) or created_at_ms <= 0:
        raise ValueError('Invalid attachment creation time')
    payload = {
        'command': 'configure', 'mode': 'sdk', 'model': '551', 'host': host,
        'workspace': workspace, 'ssid': ssid, 'password': password,
        'masterAuthorization': token, 'requestId': request_id,
        'requestCreatedAtMs': created_at_ms,
    }
    data = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode() + b'\n'
    if len(data) > MAX_LINE:
        raise ValueError('Provisioning data exceeds firmware limit')
    return data


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect rejected', headers, fp)


def validate_health(payload):
    if isinstance(payload, dict) and isinstance(payload.get('data'), dict):
        payload = payload['data']
    if not isinstance(payload, dict) or payload.get('protocolVersion') != 1:
        raise ValueError('Bridge health response has an unsupported protocol version')
    return payload


def verify_bridge(origin):
    host = parse_origin(origin)
    request = urllib.request.Request(
        f'https://{host}/healthz', headers={'User-Agent': USER_AGENT}, method='GET')
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), RejectRedirects())
    try:
        with opener.open(request, timeout=10) as response:
            if response.geturl() != request.full_url:
                raise ValueError('Bridge health check redirected')
            raw = response.read(4097)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            raise ValueError('Bridge health check redirected') from None
        raise ValueError(f'Bridge health check failed with HTTP {exc.code}') from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ValueError('Bridge health check failed; verify origin, network and TLS') from None
    if len(raw) > 4096:
        raise ValueError('Bridge health response is too large')
    try:
        validate_health(json.loads(raw))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError(str(exc)) from None


def _serial_open(port):
    if not (port.startswith('/dev/cu.') or port.startswith('/dev/ttyACM') or port.startswith('/dev/ttyUSB')):
        raise ValueError('Use the actual USB serial device path, not a file')
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    original = termios.tcgetattr(fd)
    settings = termios.tcgetattr(fd)
    settings[0] = settings[1] = settings[3] = 0
    settings[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    settings[4] = settings[5] = termios.B115200
    settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, settings)
    return fd, original


def _read_event(fd, timeout):
    deadline = time.monotonic() + timeout
    buffer = bytearray()
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], min(0.25, max(0, deadline-time.monotonic())))[0]:
            continue
        chunk = os.read(fd, 1024)
        for byte in chunk:
            if byte == 10:
                line = bytes(buffer).strip(); buffer.clear()
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(value, dict) and isinstance(value.get('event'), str):
                    return value
            elif byte != 13:
                if len(buffer) >= MAX_LINE:
                    buffer.clear()
                else:
                    buffer.append(byte)
    raise TimeoutError('No provisioning response from board')


def _send(fd, payload):
    remaining = memoryview(payload)
    deadline = time.monotonic() + 10
    while remaining:
        if time.monotonic() >= deadline:
            raise TimeoutError('USB write timed out')
        if select.select([], [fd], [], 0.25)[1]:
            remaining = remaining[os.write(fd, remaining):]


def board_command(port, payload, expected, timeout=90):
    fd, original = _serial_open(port)
    try:
        time.sleep(2)
        termios.tcflush(fd, termios.TCIFLUSH)
        _send(fd, payload)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = _read_event(fd, min(5, deadline-time.monotonic()))
            except TimeoutError:
                continue
            kind = event['event']
            if kind == expected:
                return event
            if kind == 'error':
                code = event.get('code', 'board_error')
                if code == 'attachment_retry_expired_check_inventory' or code.startswith('attachment_conflict'):
                    raise RuntimeError('Attachment stopped; check device inventory before resetting or retrying')
                if code == 'already_paired_reset_required':
                    raise RuntimeError('Board is already paired. Check inventory and explicitly reset only when intended.')
                status = event.get('httpStatus')
                detail = f', HTTP {status}' if type(status) is int and 100 <= status <= 599 else ''
                raise RuntimeError(f'Board rejected provisioning ({code}{detail})')
        raise TimeoutError('No completion response. Check device inventory before retrying; attachment may have succeeded.')
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)
        os.close(fd)


def validate_port(port):
    if not (re.fullmatch(r"/dev/cu\.[A-Za-z0-9._-]+", port) or
            re.fullmatch(r"/dev/ttyACM[0-9]+", port) or
            re.fullmatch(r"/dev/ttyUSB[0-9]+", port)):
        raise ValueError("Use the confirmed USB serial device path, not a file")

def detect_uno_port():
    """Read board metadata only; never guess from arbitrary serial devices."""
    try:
        result = subprocess.run(["arduino-cli", "board", "list", "--format", "json"],
                                capture_output=True, text=True, timeout=15, check=True)
        ports = json.loads(result.stdout).get("detected_ports", [])
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise ValueError("Could not detect the Uno. Install arduino-cli or supply --port with its confirmed USB path.") from exc
    candidates = sorted(set(item.get("port", {}).get("address", "") for item in ports
                            if any(board.get("fqbn") == "arduino:renesas_uno:unor4wifi"
                                   for board in item.get("matching_boards", []))))
    for port in candidates:
        validate_port(port)
    if not candidates:
        raise ValueError("No Uno R4 WiFi detected. Connect it by USB and close serial monitors, then retry.")
    if len(candidates) != 1:
        raise ValueError("Multiple Uno boards detected. Disconnect the others or supply --port with the intended board's USB path.")
    print("Detected Uno R4 WiFi: " + candidates[0])
    return candidates[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', help='Optional confirmed USB port; one connected Uno is detected automatically')
    parser.add_argument('--origin', default='https://www.openlaunch.dev', help='HTTPS bridge origin')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--status', action='store_true', help='Read board status without changing it')
    modes.add_argument('--reset', action='store_true', help='Erase board configuration after explicit confirmation')
    args = parser.parse_args()
    args.port = args.port or detect_uno_port()
    if args.status:
        print(json.dumps(board_command(args.port, b'{"command":"status"}\n', 'status', 10), sort_keys=True))
        return
    if args.reset:
        if input('This erases device identity, Wi-Fi settings and pending records. Type reset: ') != 'reset':
            return
        board_command(args.port, b'{"command":"reset"}\n', 'reset', 10)
        print('Board configuration reset. Revoke the old device in the console before attaching again.')
        return
    verify_bridge(args.origin)
    ssid = input('Wi-Fi SSID: ')
    password = getpass.getpass('Wi-Fi password (hidden): ')
    token = getpass.getpass('SDK connection token (hidden): ')
    payload = make_payload(args.origin, ssid, password, token)
    # The durable request ID/time are included in this one board write before
    # the firmware attempts POST /v1/sdk/devices.
    if input(f'Send provisioning data to board at {args.port}? Type pair: ') != 'pair':
        return
    event = board_command(args.port, payload, 'paired', 180)
    print(f"Board attached as {event.get('deviceId', 'device')}. Refresh the console and approve agent grants.")


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError, TimeoutError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
