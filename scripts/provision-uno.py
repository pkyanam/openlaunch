#!/usr/bin/env python3
"""Interactive macOS/Linux USB provisioning. Never writes or prints credentials."""
import argparse
import getpass
import json
import os
import re
import select
import sys
import termios
import time
from urllib.parse import urlsplit


def make_payload(origin, workspace, ssid, password, token):
    u = urlsplit(origin)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('', '/') or u.port not in (None, 443):
        raise ValueError('Uno requires a bare HTTPS origin on port 443 with a trusted certificate')
    if not re.fullmatch(r'[A-Za-z0-9.-]{1,127}', u.hostname):
        raise ValueError('Invalid hostname')
    if not re.fullmatch(r'[a-f0-9]{64}', workspace):
        raise ValueError('Workspace must be the 64-character ID displayed by the console')
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('Invalid enrollment token')
    if not 1 <= len(ssid.encode()) <= 32 or len(password.encode()) > 64:
        raise ValueError('Wi-Fi SSID/password exceed firmware limits')
    payload = {'host': u.hostname, 'workspace': workspace, 'ssid': ssid, 'password': password, 'enrollmentToken': token}
    data = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode() + b'\n'
    if len(data) > 1024:
        raise ValueError('Provisioning data exceeds firmware limit')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True, help='Confirmed board port from arduino-cli board list')
    parser.add_argument('--origin', required=True, help='HTTPS bridge origin')
    parser.add_argument('--workspace', required=True, help='Workspace ID from console')
    args = parser.parse_args()
    if not (args.port.startswith('/dev/cu.') or args.port.startswith('/dev/ttyACM') or args.port.startswith('/dev/ttyUSB')):
        parser.error('Use the actual USB serial device path, not a file')
    ssid = input('Wi-Fi SSID: ')
    password = getpass.getpass('Wi-Fi password (hidden): ')
    token = getpass.getpass('One-time enrollment token (hidden): ')
    data = make_payload(args.origin, args.workspace, ssid, password, token)
    if input(f'Send provisioning data to board at {args.port}? Type pair: ') != 'pair':
        return
    fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    original = termios.tcgetattr(fd)
    try:
        settings = termios.tcgetattr(fd)
        settings[0] = 0
        settings[1] = 0
        settings[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        settings[3] = 0
        settings[4] = settings[5] = termios.B115200
        settings[6][termios.VMIN] = 0
        settings[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        time.sleep(2)
        termios.tcflush(fd, termios.TCIFLUSH)
        remaining = memoryview(data)
        deadline = time.monotonic() + 10
        while remaining:
            if time.monotonic() > deadline:
                raise TimeoutError('USB write timed out')
            if select.select([], [fd], [], 1)[1]:
                remaining = remaining[os.write(fd, remaining):]
        deadline = time.monotonic() + 65
        buffer = b''
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 1)[0]:
                continue
            buffer = (buffer + os.read(fd, 1024))[-4096:]
            if b'openlaunch: paired' in buffer:
                print('Board reports paired. Refresh the console, verify health, then approve agent grants.')
                return
            if b'openlaunch: already paired' in buffer:
                raise RuntimeError('Board already paired. Preserve its identity or explicitly reset it before re-enrollment.')
        raise TimeoutError('No pairing confirmation. Check console inventory before issuing a new token; pairing may have succeeded. Check Wi-Fi, TLS and board connectivity firmware. Raw serial output is withheld to protect credentials.')
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
