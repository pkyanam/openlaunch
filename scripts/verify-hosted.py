#!/usr/bin/env python3
"""Verify the public deployment and installer copies without credentials."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://www.openlaunch.dev'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def response(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'openlaunch-verification/1', 'Cache-Control': 'no-cache'})
    try:
        result = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        body = result.read(1_048_577)
        if len(body) > 1_048_576:
            raise ValueError('response exceeds verification limit')
        return result.status, result.headers, body

def verify(commit):
    status, _, body = response(ORIGIN + '/deployment.json')
    assert status == 200, 'website deployment metadata unavailable'
    site = json.loads(body)
    assert site.get('commit') == commit and site.get('dirty') is False, 'website commit mismatch'
    status, _, body = response(ORIGIN + '/healthz')
    assert status == 200, 'bridge health unavailable'
    health = json.loads(body)
    assert health.get('commit') == commit, 'bridge commit mismatch'
    assert health.get('service') == 'openlaunch' and health.get('protocolVersion') == 1, 'bridge protocol mismatch'
    assert health.get('authConfigured') is True and health.get('deviceControlsEnabled') is True, 'hosted auth or controls disabled'
    status, headers, _ = response('https://openlaunch.dev/')
    assert status == 308 and headers.get('Location') == ORIGIN + '/', 'apex redirect mismatch'
    status, _, _ = response(ORIGIN + '/v1/devices')
    assert status == 401, 'device inventory must require authentication'
    for policy in ['terms', 'privacy']:
        status, _, body = response(ORIGIN + '/docs/' + policy + '/')
        assert status == 200 and b'Belweave' in body and b'info@belweave.com' in body, f'policy unavailable: {policy}'
        status, _, body = response(ORIGIN + '/docs/' + policy + '.md')
        assert status == 200 and b'Belweave' in body, f'Markdown policy unavailable: {policy}'
    for source, public in [
        ('scripts/setup.sh', '/setup.sh'),
        ('scripts/setup.py', '/downloads/setup.py'),
        ('scripts/install.sh', '/install.sh'),
        ('scripts/install-pi.sh', '/install-pi.sh'),
        ('scripts/install-pi.sh', '/downloads/pi/install.sh'),
        ('scripts/provision-uno.py', '/downloads/provision-uno.py'),
        ('scripts/provision-roomba.py', '/downloads/provision-roomba.py'),
        ('scripts/setup-uno.sh', '/setup-uno.sh'),
        ('scripts/provision-esp32.py', '/downloads/provision-esp32.py'),
    ]:
        status, _, body = response(ORIGIN + public)
        assert status == 200 and body == (ROOT / source).read_bytes(), f'installer mismatch: {public}'

if __name__ == '__main__':
    commit = os.environ.get('GITHUB_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    for attempt in range(6):
        try:
            verify(commit)
            print(f'PASS: hosted site and bridge {commit}; authentication, apex redirect and all installer copies')
            break
        except (AssertionError, ValueError, OSError) as error:
            if attempt == 5:
                raise SystemExit(f'Hosted deployment verification failed: {error}')
            print(f'Waiting for deployment propagation ({attempt + 1}/6): {error}', flush=True)
            time.sleep(5)
