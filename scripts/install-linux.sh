#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Self-serve Linux host installer. The release manifest and both artifacts
# must be published by the openlaunch site before this installer is advertised.
readonly origin='https://www.openlaunch.dev'
readonly manifest_url="$origin/downloads/linux/manifest.json"
readonly max_artifact_bytes=26214400

fail() {
  printf 'openlaunch Linux installer: %s\n' "$*" >&2
  exit 1
}

for required in curl python3; do
  command -v "$required" >/dev/null 2>&1 || fail "required command not found: $required"
done

[[ "$(id -u)" != 0 ]] || fail 'run as your normal Linux user, without sudo'
[[ "$(uname -s)" == Linux ]] || fail 'this installer supports Linux only'
machine="$(uname -m)"
case "$machine" in
  aarch64|arm64) artifact_arch=linux-arm64 ;;
  armv7l|armv7) artifact_arch=linux-arm ;;
  x86_64|amd64) artifact_arch=linux-amd64 ;;
  *) fail "unsupported CPU architecture '$machine'; use ARM64, ARMv7 or x86-64 Linux" ;;
esac

host_install_home="${HOME:-}"
[[ -n "$host_install_home" && -d "$host_install_home" ]] || fail 'HOME must point to an existing user directory'
bin_dir="$host_install_home/.local/bin"
config_dir="$host_install_home/.config/openlaunch/host"
binary="$bin_dir/openlaunch-host"
config="$config_dir/device.json"
pending="$config.attach-pending"
expired_pending="$pending.expired"
[[ ! -L "$bin_dir" && ! -L "$config_dir" ]] || fail 'refusing symlinked installation directories'
[[ ! -L "$binary" && ! -L "$config" ]] || fail 'refusing symlinked binary or device identity'
upgrading=0
if [[ -e "$config" ]]; then
  upgrading=1
  python3 - "$config" <<'PY_IDENTITY' || fail 'saved identity is invalid or not private; it was preserved'
import json, os, re, stat, sys
from urllib.parse import urlsplit
try:
    path = sys.argv[1]
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_uid != os.getuid() or st.st_size > 16384:
        raise ValueError()
    with open(path) as f:
        config = json.load(f)
    origin = urlsplit(config['url'])
    if (config.get('profile') != 'linux' or config.get('simulate') is not False or
            not re.fullmatch(r'[a-f0-9]{64}', config['workspace']) or
            not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['deviceId']) or
            not isinstance(config['token'], str) or not config['token'] or
            not isinstance(config.get('policy'), str) or not config['policy'] or
            origin.scheme != 'https' or not origin.hostname or origin.username is not None or
            origin.password is not None or origin.path not in ('', '/') or origin.query or origin.fragment):
        raise ValueError()
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
PY_IDENTITY
elif [[ -e "$binary" ]]; then
  fail 'an existing binary has no saved Linux identity; refusing to replace it'
fi
[[ ! -L "$pending" ]] || fail "refusing symlinked pending attachment: $pending"
if ((upgrading == 0)); then
  [[ ! -e "$expired_pending" && ! -L "$expired_pending" ]] || fail "previous SDK attachment retry expired; check device inventory before removing $expired_pending and starting another request"
fi

sdk_token=''
if ((upgrading == 0)); then
  sdk_token="${OPENLAUNCH_SDK_TOKEN:-}"
  if [[ -z "$sdk_token" ]]; then
    [[ -r /dev/tty ]] || fail 'interactive terminal required; run this from a Linux terminal'
    IFS= read -r -s -p 'openlaunch SDK token (hidden): ' sdk_token < /dev/tty || fail 'could not read SDK token'
    printf '\n' > /dev/tty
  fi
  [[ "$sdk_token" =~ ^ol_sdk_([a-f0-9]{64})_[a-f0-9]{64}$ ]] || fail 'Use an owner-issued ol_sdk_ token; legacy agent tokens cannot pair devices'
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/openlaunch-linux.XXXXXXXX")" || fail 'could not create a temporary directory'
installed_binary=0
installed_config=0
enrollment_started=0
attachment_complete=0
cleanup() {
  status=$?
  unset sdk_token OPENLAUNCH_SDK_TOKEN
  if ((status != 0 && enrollment_started == 1)); then
    if [[ -f "$pending" && ! -L "$pending" ]]; then
      printf 'Attachment may have completed after a lost response. The private pending request was kept at %s; rerun with the same SDK token within 10 minutes. After that window, check device inventory before starting a new request.\n' "$pending" >&2
    else
      printf 'Attachment did not finish. Check device inventory before starting another request.\n' >&2
    fi
  fi
  if ((status != 0 && attachment_complete == 0)); then
    ((installed_binary == 0)) || rm -f -- "$binary"
    ((installed_config == 0)) || rm -f -- "$config"
  fi
  rm -rf -- "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$tmp"
manifest="$tmp/manifest.json"
download="$tmp/openlaunch-host"

curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 --max-filesize 32768 \
  --connect-timeout 15 --max-time 30 --output "$manifest" "$manifest_url" || fail 'could not download the release manifest over HTTPS'

# Validate all manifest metadata before trusting its artifact location or hash.
details="$(python3 - "$manifest" "$artifact_arch" <<'PY'
import json
import re
import sys
from urllib.parse import urlsplit

path, arch = sys.argv[1:]
try:
    raw = open(path, "rb").read(32769)
    if len(raw) > 32768:
        raise ValueError("manifest exceeds 32 KiB")
    doc = json.loads(raw)
    version = doc["version"]
    commit = doc["commit"]
    artifact = doc["artifacts"][arch]
    url = artifact["url"]
    digest = artifact["sha256"]
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9._+-]{1,80}", version):
        raise ValueError("invalid version")
    if not isinstance(commit, str) or not re.fullmatch(r"[A-Fa-f0-9]{7,64}", commit):
        raise ValueError("invalid commit")
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "www.openlaunch.dev" or
            parsed.username is not None or parsed.password is not None or
            parsed.port not in (None, 443) or parsed.query or parsed.fragment or
            not parsed.path.startswith("/downloads/linux/") or
            "\\" in url or any(ord(ch) < 32 for ch in url)):
        raise ValueError("artifact URL must be HTTPS on www.openlaunch.dev under /downloads/linux/")
    if not isinstance(digest, str) or not re.fullmatch(r"[A-Fa-f0-9]{64}", digest):
        raise ValueError("invalid SHA-256")
    print("\t".join((version, commit, url, digest.lower())))
except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
    print("invalid release manifest: " + str(exc), file=sys.stderr)
    sys.exit(1)
PY
)" || fail 'release manifest validation failed'
IFS=$'\t' read -r version commit artifact_url expected_sha <<< "$details"
[[ -n "$version" && -n "$commit" && -n "$artifact_url" && -n "$expected_sha" ]] || fail 'release manifest is incomplete'

curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --connect-timeout 15 --max-time 120 --max-filesize "$max_artifact_bytes" \
  --output "$download" "$artifact_url" || fail 'could not download the Linux binary over HTTPS'
[[ -s "$download" ]] || fail 'downloaded Linux binary is empty'
python3 - "$download" "$expected_sha" "$max_artifact_bytes" <<'PY' || fail 'downloaded binary failed size or SHA-256 verification'
import hashlib
import os
import sys

path, expected, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
size = os.path.getsize(path)
if size > limit:
    print("binary exceeds the 25 MiB download limit", file=sys.stderr)
    sys.exit(1)
h = hashlib.sha256()
with open(path, "rb") as f:
    for block in iter(lambda: f.read(1024 * 1024), b""):
        h.update(block)
if h.hexdigest() != expected:
    print("SHA-256 mismatch", file=sys.stderr)
    sys.exit(1)
PY
chmod 700 "$download"

if ((upgrading == 1)); then
  unset sdk_token OPENLAUNCH_SDK_TOKEN
  # Validate before touching the installed binary or stopping a user service.
  # No attach/init operation occurs here: identity, policy and journal stay put.
  "$download" --check-config --config "$config" || fail 'replacement could not validate saved state; existing installation was preserved'
  python3 - "$download" "$binary" "$config_dir" <<'PY_UPGRADE' || fail 'update did not complete; saved credentials and policy were preserved'
import fcntl, hashlib, os, shutil, stat, subprocess, sys, tempfile

source, binary, state = sys.argv[1:]
bindir = os.path.dirname(binary)
os.makedirs(bindir, mode=0o700, exist_ok=True)
backup = candidate = None
changed = stopped = False
service = ['systemctl', '--user']

def run_service(action):
    return subprocess.run(service + [action, 'openlaunch-host.service'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

def digest(path):
    with open(path, 'rb') as f:
        h = hashlib.sha256()
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
        return h.hexdigest()

def lock_runtime():
    fd = os.open(os.path.join(state, 'runtime.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077 or st.st_uid != os.getuid():
            raise RuntimeError('invalid private runtime lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return os.fdopen(fd, 'r+b')
    except Exception:
        os.close(fd)
        raise RuntimeError('Stop the foreground runner with Ctrl-C (or run openlaunch-host service stop), then rerun this installer.') from None

def stage(path):
    fd, staged = tempfile.mkstemp(prefix='.openlaunch-host-', dir=bindir)
    try:
        with os.fdopen(fd, 'wb') as out, open(path, 'rb') as src:
            shutil.copyfileobj(src, out)
            os.fchmod(out.fileno(), 0o700)
            out.flush()
            os.fsync(out.fileno())
        return staged
    except Exception:
        os.unlink(staged)
        raise

def sync_bin():
    fd = os.open(bindir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

active = False
try:
    if os.path.lexists(binary):
        st = os.lstat(binary)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            raise RuntimeError('installed binary must be an owned regular file')
        if digest(binary) == digest(source):
            print('The latest published binary is already installed. Saved device identity and policy were preserved.')
            sys.exit(0)
    active = shutil.which('systemctl') is not None and subprocess.run(
        service + ['is-active', '--quiet', 'openlaunch-host.service'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if active:
        if not run_service('stop'):
            raise RuntimeError('could not stop the existing user service; binary was preserved')
        stopped = True
    with lock_runtime():
        if os.path.exists(binary):
            backup = stage(binary)
        candidate = stage(source)
        os.replace(candidate, binary)
        candidate = None
        changed = True
        sync_bin()
    if active:
        if not run_service('start'):
            raise RuntimeError('updated user service could not start')
        stopped = False
        print('Updated and restarted the existing user service.')
    else:
        print('Updated. Start the runner with: openlaunch-host start')
except Exception as exc:
    print(str(exc), file=sys.stderr)
    if changed:
        if active:
            run_service('stop')
        try:
            with lock_runtime():
                if backup:
                    os.replace(backup, binary)
                    backup = None
                else:
                    os.unlink(binary)
                sync_bin()
            print('Previous binary restored; device state was preserved.', file=sys.stderr)
        except Exception:
            print('Automatic rollback could not acquire the runtime lock; stop the runner and restore the private binary backup: ' + str(backup), file=sys.stderr)
            backup = None  # Keep it for owner recovery.
    if active and stopped:
        if not run_service('start'):
            print('Start the saved user service after reviewing its logs.', file=sys.stderr)
    sys.exit(1)
finally:
    for path in (candidate, backup):
        if path is not None:
            os.unlink(path)
PY_UPGRADE
  printf 'openlaunch Linux update verified (%s, %s). No pairing or grant changes were made.\n' "$version" "$artifact_arch"
  exit 0
fi

# Keep retry metadata at its durable final path. The Go runtime writes it
# before sending the request and removes it only after saving the child device
# credential, so an interrupted installer can safely resume the exact attach.
mkdir -m 700 -p "$config_dir"
chmod 700 "$config_dir"
[[ ! -L "$config_dir" && ! -L "$pending" ]] || fail 'refusing symlinked configuration or pending attachment'
if [[ -e "$pending" ]]; then
  [[ -f "$pending" ]] || fail 'pending attachment is not a regular file'
  printf 'Resuming the saved attachment request; use the same SDK token.\n'
fi

# Put the verified binary in place before attachment. A failed exchange keeps
# the retry record but removes this binary, leaving the next installer run able
# to resume the same request.
mkdir -p "$bin_dir"
mv -- "$download" "$binary"
installed_binary=1
chmod 700 "$binary"

# The owner SDK token is passed only in the environment, never in argv or the
# saved device configuration.
"$binary" --linux-init --config "$config" || fail 'could not initialize local policy'
enrollment_started=1
OPENLAUNCH_SDK_TOKEN="$sdk_token" "$binary" \
  --attach --profile linux --url "$origin" --config "$config" || fail 'device attachment failed; installation was not completed'
unset sdk_token OPENLAUNCH_SDK_TOKEN
[[ -s "$config" ]] || fail 'attachment did not create a device configuration'
enrollment_started=0
installed_config=1
attachment_complete=1
chmod 600 "$config"

printf '\nopenlaunch Linux harness installed (%s, %s).\n' "$version" "$artifact_arch"
printf 'Device credentials are stored privately at %s\n' "$config"
# Add the user binary directory without replacing existing shell configuration.
python3 - <<'PY_PATH'
import os
from pathlib import Path
home = Path.home()
shell = Path(os.environ.get('SHELL', '')).name
profiles = {'zsh': ['.zprofile', '.zshrc'], 'fish': ['.config/fish/config.fish']}.get(shell, ['.profile'])
if shell == 'bash':
    login = next((p for p in ['.bash_profile', '.bash_login', '.profile'] if (home / p).exists() or (home / p).is_symlink()), '.profile')
    profiles = [login, '.bashrc']
marker = '# openlaunch Linux host PATH'
line = 'fish_add_path --path "$HOME/.local/bin"' if shell == 'fish' else 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
for filename in profiles:
    target = home / filename
    if target.is_symlink() or (target.exists() and not target.is_file()):
        print('Add ~/.local/bin to PATH manually in ' + str(target))
        continue
    content = target.read_text() if target.exists() else ''
    if marker not in content:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('a') as out:
            out.write('\n' + marker + '\n' + line + '\n')
PY_PATH
printf 'Open a new terminal, then run: openlaunch-host start\n'
printf 'Or install a persistent user service: openlaunch-host service install\n'
printf 'Inspect local access: openlaunch-host policy\n'
printf 'File access starts with ~/.local/share/openlaunch/workspace only. Commands and services require local configuration.\n'
printf 'Grant agent functions separately in the console. Installation does not grant an agent access.\n'
