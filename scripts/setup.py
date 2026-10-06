#!/usr/bin/env python3
"""Choose a setup helper and verify its download before running it."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit

ORIGIN = 'https://www.openlaunch.dev'
MODES = {
    'uno': ('Uno R4 WiFi USB setup', 'provision-uno.py'),
    'roomba': ('Uno + ArduRoomba USB setup', 'provision-roomba.py'),
    'pi': ('Raspberry Pi installation', 'install-pi.sh'),
    'esp32': ('Standalone ESP32 USB setup', 'provision-esp32.py'),
    'adapter': ('Custom Node device adapter', None),
    'local': ('Local developer console', 'install.sh'),
    'cli': ('Install ol CLI on PATH', None),
    'linux': ('Linux host control harness', 'install-linux.sh'),
    'home-assistant': ('Home Assistant gateway', None),
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _url):
        return None


def fetch(url, limit):
    request = urllib.request.Request(url, headers={
        'User-Agent': 'openlaunch-setup/1', 'Cache-Control': 'no-cache',
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError('Download failed')
        data = response.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError('Download is empty or exceeds its size limit')
    return data


def checked_download(record, path, commit, limit):
    url, digest = record['url'], record['sha256']
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'www.openlaunch.dev' or
            parsed.path != path or parsed.query not in ('', 'commit=' + commit) or
            parsed.fragment or not re.fullmatch(r'[a-f0-9]{64}', digest)):
        raise ValueError('Invalid download metadata')
    data = fetch(url, limit)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Download checksum mismatch. Retry after deployment finishes.')
    return data


def helper_command(mode, args, manifest, directory):
    commit = manifest['commit']
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Invalid deployed source commit')
    _, filename = MODES[mode]
    if mode == 'adapter':
        for tool in ('node', 'npx'):
            if not shutil.which(tool):
                raise ValueError('Install Node 24 or newer, then retry.')
        subprocess.run(['node', '-e', 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'], check=True)
        # A commit-specific file keeps npm from reusing an older hosted package.
        archive = directory / ('openlaunch-sdk-' + commit + '.tgz')
        archive.write_bytes(checked_download(
            manifest['sdk'], '/downloads/openlaunch-sdk.tgz', commit, 25 * 1024 * 1024))
        return ['npx', '--yes', '--package=' + str(archive), '--',
                'openlaunch-device', *(args or ['setup'])]
    path = ('/downloads/' if filename.endswith('.py') else '/') + filename
    record = next((r for r in manifest['installers'] if urlsplit(r['url']).path == path), None)
    if record is None:
        raise ValueError('Setup helper is missing from the download manifest')
    helper = directory / filename
    helper.write_bytes(checked_download(record, path, commit, 256 * 1024))
    return [sys.executable if filename.endswith('.py') else 'bash', str(helper), *args]


def install_cli(manifest, temporary, user_directory=None, environment=None):
    user_directory = Path.home() if user_directory is None else Path(user_directory)
    environment = os.environ if environment is None else environment
    for tool in ('node', 'npm'):
        if not shutil.which(tool):
            raise ValueError('Install Node 24 or newer, then retry.')
    subprocess.run(['node', '-e', 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'], check=True)
    commit = manifest['commit']
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Invalid deployed source commit')
    archive = temporary / ('openlaunch-sdk-' + commit + '.tgz')
    archive.write_bytes(checked_download(manifest['sdk'], '/downloads/openlaunch-sdk.tgz', commit, 25 * 1024 * 1024))
    prefix = user_directory / '.local'
    # npm can replace a regular binary when updating an existing package.
    # Admit only absent names or links to this package before asking npm to install.
    for name, target in [('ol', 'agent-cli.js'), ('openlaunch-agent', 'agent-cli.js'),
                         ('openlaunch-device', 'cli.js'), ('openlaunch-ha', 'home-assistant-cli.js')]:
        executable = prefix / 'bin' / name
        expected = prefix / 'lib/node_modules/@openlaunch/sdk/dist' / target
        if executable.exists() or executable.is_symlink():
            if not executable.is_symlink() or executable.resolve() != expected.resolve():
                raise ValueError('Refusing to replace an unrelated executable: ' + str(executable))
    subprocess.run(['npm', 'install', '--global', '--prefix', str(prefix),
                    '--ignore-scripts', '--no-audit', '--no-fund', str(archive)], check=True)
    subprocess.run([str(prefix / 'bin/ol'), '--help'], check=True, stdout=subprocess.DEVNULL)
    shell = Path(environment.get('SHELL', '')).name
    profiles = {'zsh': ['.zprofile', '.zshrc'],
                'sh': ['.profile'], 'dash': ['.profile'],
                'fish': ['.config/fish/config.fish']}.get(shell, ['.profile'])
    if shell == 'bash':
        # Preserve bash's existing login-file precedence instead of hiding .profile.
        login_profile = next((name for name in ['.bash_profile', '.bash_login', '.profile']
                              if (user_directory / name).exists() or
                              (user_directory / name).is_symlink()), '.profile')
        profiles = [login_profile, '.bashrc']
    marker = '# openlaunch CLI'
    line = ('fish_add_path --path "$HOME/.local/bin"' if shell == 'fish' else
            'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac')
    for filename in profiles:
        profile = user_directory / filename
        if profile.is_symlink() or (profile.exists() and not profile.is_file()):
            print('Add ~/.local/bin to PATH in your shell configuration: ' + str(profile))
            continue
        content = profile.read_text() if profile.exists() else ''
        if marker not in content:
            profile.parent.mkdir(parents=True, exist_ok=True)
            with profile.open('a') as output:
                output.write('\n' + marker + '\n' + line + '\n')
    print('Installed ol, openlaunch-agent, openlaunch-device and openlaunch-ha in ' + str(prefix / 'bin'))
    print('Open a new terminal or restart your agent to pick up PATH. Then run: ol --help')
    print('Available immediately at: ' + str(prefix / 'bin/ol'))


def main(args):
    if args and args[0] in ('--help', '-h'):
        print('openlaunch setup: uno | roomba | pi | esp32 | adapter | local | cli | linux | home-assistant')
        print('No option opens a menu. USB setup configures already-flashed firmware.')
        print('Examples: setup.sh roomba; setup.sh adapter run; setup.sh uno --status')
        return 0
    # The shell script may arrive through a pipe; read prompts from the terminal.
    tty = None
    try:
        if not args or (args[0] not in ('cli', 'local') and '--help' not in args):
            try:
                tty = open('/dev/tty', 'r')
            except OSError:
                raise ValueError('Run setup in an interactive terminal.') from None
        if not args:
            for i, (label, _) in enumerate(MODES.values(), 1):
                print(f'{i}. {label}')
            print(f'Choose setup [1-{len(MODES)}]: ', end='', flush=True)
            choice = tty.readline().strip()
            if choice not in [str(i) for i in range(1, len(MODES) + 1)]:
                raise ValueError(f'Choose a number from 1 to {len(MODES)}.')
            args = [list(MODES)[int(choice) - 1]]
        mode, *forwarded = args
        if mode not in MODES:
            raise ValueError('Choose uno, roomba, pi, esp32, adapter, local, cli, linux, or home-assistant.')
        if mode in ('pi', 'local', 'cli', 'linux') and forwarded:
            if forwarded == ['--help']:
                print(MODES[mode][0] + ': rerun without --help to install.')
                return 0
            raise ValueError(mode + ' setup takes no extra arguments.')
        if mode == 'esp32' and '--port' not in forwarded and '--help' not in forwarded:
            print('Confirmed ESP32 USB port (for example /dev/cu.usbmodem123): ',
                  end='', flush=True)
            port = tty.readline().strip()
            if not port:
                raise ValueError('Enter the confirmed ESP32 USB serial port.')
            forwarded = ['--port', port, *forwarded]
        manifest = json.loads(fetch(ORIGIN + '/downloads/installers.json', 32768))
        with tempfile.TemporaryDirectory(prefix='openlaunch-setup-') as temporary:
            if mode in ('cli', 'home-assistant'):
                install_cli(manifest, Path(temporary))
                if mode == 'cli':
                    return 0
                command = [str(Path.home() / '.local/bin/openlaunch-ha'), *(forwarded or ['setup'])]
                return subprocess.call(command, stdin=tty)
            command = helper_command(mode, forwarded, manifest, Path(temporary))
            print('Using openlaunch build ' + manifest['commit'][:12], flush=True)
            return subprocess.call(command, stdin=tty)
    finally:
        if tty is not None:
            tty.close()


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('openlaunch setup: ' + str(error), file=sys.stderr)
        sys.exit(1)
