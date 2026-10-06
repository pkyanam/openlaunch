#!/usr/bin/env python3
"""Verify the public deployment and installer copies without credentials."""
import json
import hashlib
import io
import os
from pathlib import Path
import subprocess
import time
import tarfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://www.openlaunch.dev'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def response(url, limit=1_048_576, method='GET'):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': 'openlaunch-verification/1', 'Cache-Control': 'no-cache'})
    try:
        result = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        body = result.read(limit + 1)
        if len(body) > limit:
            raise ValueError('response exceeds verification limit')
        return result.status, result.headers, body

def verify_discovery(contract):
    documents = {}
    for path in ['/openapi.json', '/docs-openapi.json', '/.well-known/integrations.json',
                 '/.well-known/mcp/server-card.json', '/.well-known/mcp/docs-server-card.json',
                 '/.well-known/mcp.json', '/.well-known/api-catalog', '/.well-known/agent-skills/index.json']:
        status, headers, body = response(ORIGIN + path)
        expected = 'application/linkset+json' if path.endswith('/api-catalog') else 'application/json'
        assert status == 200 and headers.get('Content-Type', '').startswith(expected), 'discovery unavailable or wrong media type: ' + path
        assert 'public' in headers.get('Cache-Control', '') and 'max-age=3600' in headers.get('Cache-Control', ''), 'discovery must be publicly cacheable: ' + path
        documents[path] = json.loads(body)
    assert documents['/openapi.json'] == contract, 'canonical OpenAPI must describe the device API'
    assert '/api/docs/pages.json' in documents['/docs-openapi.json']['paths'], 'docs OpenAPI unavailable'
    declaration = documents['/.well-known/integrations.json']
    assert declaration.get('version') == 3 and len(declaration['surfaces']) == 5, 'incomplete integration declaration'
    assert sorted(surface['type'] for surface in declaration['surfaces']) == ['cli', 'http', 'http', 'mcp', 'mcp'], 'surface types mismatch'
    card = documents['/.well-known/mcp/server-card.json']
    assert card['url'] == ORIGIN + '/mcp' and card['authentication']['type'] == 'oauth2', 'device MCP card mismatch'
    assert documents['/.well-known/mcp/docs-server-card.json']['url'] == ORIGIN + '/docs-mcp', 'docs MCP card mismatch'
    status, _, body = response(ORIGIN + '/.well-known/oauth-protected-resource/mcp')
    resource = json.loads(body)
    assert status == 200 and resource['resource'] == card['url'], 'OAuth resource mismatch'
    assert card['authentication']['authorization_server'] in resource['authorization_servers'], 'OAuth issuer mismatch'
    status, headers, _ = response(ORIGIN + '/.well-known/api-catalog', method='HEAD')
    assert status == 200 and 'rel="api-catalog"' in headers.get('Link', ''), 'catalog HEAD must advertise its link relation'
    assert 'https://www.rfc-editor.org/info/rfc9727' in headers.get('Content-Type', ''), 'catalog profile missing'
    skills = documents['/.well-known/agent-skills/index.json']['skills']
    assert sorted(skill['name'] for skill in skills) == ['openlaunch', 'openlaunch-device-control'], 'device skill missing'
    for skill in skills:
        status, _, body = response(urllib.parse.urljoin(ORIGIN, skill['url']))
        assert status == 200 and skill['digest'] == 'sha256:' + hashlib.sha256(body).hexdigest(), 'skill artifact checksum mismatch: ' + skill['name']

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
    status, _, body = response(ORIGIN + '/device-api.json')
    assert status == 200, 'device OpenAPI contract unavailable'
    contract = json.loads(body)
    assert contract.get('openapi') == '3.1.0' and contract['servers'][0]['url'] == ORIGIN, 'device API contract mismatch'
    assert '/v1/functions' in contract['paths'] and '/v1/device/{deviceId}/result' in contract['paths'], 'device API routes missing'
    for path in ['/v1/devices/{deviceId}/gateway-grants', '/v1/device/{deviceId}/children', '/v1/device/{deviceId}/children/status']:
        assert path in contract['paths'], 'gateway API route missing: ' + path
    verify_discovery(contract)
    for public, expected in [('/docs/cli.md', b'ol login'),
                             ('/docs/linux.md', b'openlaunch-host start'),
                             ('/docs/home-assistant.md', b'openlaunch-ha'),
                             ('/docs/reference/agent/post-v1-devices-device-id-actions.md', b'requestAction'),
                             ('/changelog/rss.xml', b'2026')]:
        status, _, body = response(ORIGIN + public)
        assert status == 200 and expected in body, f'integration documentation unavailable: {public}'
    for source, public in [
        ('scripts/setup.sh', '/setup.sh'),
        ('scripts/install-cli.sh', '/install-cli.sh'),
        ('scripts/setup.py', '/downloads/setup.py'),
        ('scripts/install.sh', '/install.sh'),
        ('scripts/install-pi.sh', '/install-pi.sh'),
        ('scripts/install-linux.sh', '/install-linux.sh'),
        ('scripts/install-pi.sh', '/downloads/pi/install.sh'),
        ('scripts/provision-uno.py', '/downloads/provision-uno.py'),
        ('scripts/provision-roomba.py', '/downloads/provision-roomba.py'),
        ('scripts/setup-uno.sh', '/setup-uno.sh'),
        ('scripts/provision-esp32.py', '/downloads/provision-esp32.py'),
    ]:
        status, _, body = response(ORIGIN + public)
        assert status == 200 and body == (ROOT / source).read_bytes(), f'installer mismatch: {public}'
    status, _, body = response(ORIGIN + '/downloads/installers.json')
    assert status == 200, 'installer manifest unavailable'
    manifest = json.loads(body)
    assert manifest.get('commit') == commit, 'installer manifest commit mismatch'
    status, _, body = response(ORIGIN + '/downloads/openlaunch-sdk.tgz?commit=' + commit, 25 * 1024 * 1024)
    assert status == 200 and hashlib.sha256(body).hexdigest() == manifest['sdk']['sha256'], 'SDK download checksum mismatch'
    with tarfile.open(fileobj=io.BytesIO(body), mode='r:gz') as archive:
        package = json.load(archive.extractfile('package/package.json'))
        assert package['bin'].get('openlaunch-ha') == './dist/home-assistant-cli.js', 'HA gateway CLI missing'
        assert archive.getmember('package/dist/home-assistant-cli.js').isfile(), 'HA CLI executable missing'

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
