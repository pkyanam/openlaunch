#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Self-serve Raspberry Pi installer. The release manifest and both artifacts
# must be published by the openlaunch site before this installer is advertised.
readonly origin='https://www.openlaunch.dev'
readonly manifest_url="$origin/downloads/pi/manifest.json"
readonly max_artifact_bytes=26214400

fail() {
  printf 'openlaunch Pi installer: %s\n' "$*" >&2
  exit 1
}

for required in curl python3; do
  command -v "$required" >/dev/null 2>&1 || fail "required command not found: $required"
done

[[ "$(uname -s)" == Linux ]] || fail 'this installer supports Linux only'
machine="$(uname -m)"
case "$machine" in
  aarch64|arm64) artifact_arch=linux-arm64 ;;
  armv7l|armv7) artifact_arch=linux-arm ;;
  *) fail "unsupported CPU architecture '$machine'; use a 64-bit ARM64 or ARMv7 Raspberry Pi OS image" ;;
esac

pi_install_home="${HOME:-}"
[[ -n "$pi_install_home" && -d "$pi_install_home" ]] || fail 'HOME must point to an existing user directory'
bin_dir="$pi_install_home/.local/bin"
config_dir="$pi_install_home/.config/openlaunch"
binary="$bin_dir/openlaunch-device"
config="$config_dir/device.json"
[[ ! -L "$bin_dir" && ! -L "$config_dir" ]] || fail 'refusing symlinked installation directories'
[[ ! -e "$binary" && ! -L "$binary" ]] || fail "refusing to replace existing binary: $binary"
[[ ! -e "$config" && ! -L "$config" ]] || fail "refusing to overwrite existing device identity: $config"

workspace="${OPENLAUNCH_WORKSPACE_ID:-}"
enrollment_token="${OPENLAUNCH_ENROLLMENT_TOKEN:-}"
if [[ -z "$workspace" || -z "$enrollment_token" ]]; then
  [[ -r /dev/tty ]] || fail 'interactive terminal required; run this from a terminal on the Pi'
  if [[ -z "$workspace" ]]; then
    IFS= read -r -p 'Workspace ID from the openlaunch portal: ' workspace < /dev/tty || fail 'could not read workspace ID'
  fi
  if [[ -z "$enrollment_token" ]]; then
    IFS= read -r -s -p 'One-time Pi enrollment code (hidden): ' enrollment_token < /dev/tty || fail 'could not read enrollment code'
    printf '\n' > /dev/tty
  fi
fi
[[ -n "$workspace" ]] || fail 'workspace ID is required'
[[ -n "$enrollment_token" ]] || fail 'enrollment code is required'
[[ "$workspace" =~ ^[a-f0-9]{64}$ ]] || fail 'workspace ID must be the 64-character lowercase value shown by the portal'
[[ "$enrollment_token" =~ ^[a-f0-9]{64}$ ]] || fail 'enrollment code must be the 64-character lowercase value shown by the portal'

tmp="$(mktemp -d "${TMPDIR:-/tmp}/openlaunch-pi.XXXXXXXX")" || fail 'could not create a temporary directory'
installed_binary=0
installed_config=0
enrollment_started=0
cleanup() {
  status=$?
  unset enrollment_token OPENLAUNCH_ENROLLMENT_TOKEN OPENLAUNCH_WORKSPACE_ID
  if ((status != 0 && enrollment_started == 1)); then
    printf 'Enrollment may have consumed the one-time code. Check portal inventory before retrying; if a device was created without a saved credential, revoke it and create a new enrollment.\n' >&2
  fi
  if ((status != 0)); then
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
download="$tmp/openlaunch-device"
staged_config="$tmp/device.json"

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
            not parsed.path.startswith("/downloads/pi/") or
            "\\" in url or any(ord(ch) < 32 for ch in url)):
        raise ValueError("artifact URL must be HTTPS on www.openlaunch.dev under /downloads/pi/")
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
  --output "$download" "$artifact_url" || fail 'could not download the Pi binary over HTTPS'
[[ -s "$download" ]] || fail 'downloaded Pi binary is empty'
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

# Enrollment credentials are passed only in the environment, as required by
# the device CLI; they never appear in the process argument list.
enrollment_started=1
OPENLAUNCH_ENROLLMENT_TOKEN="$enrollment_token" "$download" \
  --enroll --url "$origin" --workspace "$workspace" --config "$staged_config" || fail 'device enrollment failed; no installed files were changed'
unset enrollment_token OPENLAUNCH_ENROLLMENT_TOKEN OPENLAUNCH_WORKSPACE_ID
[[ -s "$staged_config" ]] || fail 'enrollment did not create a device configuration'
chmod 600 "$staged_config"
enrollment_started=0

mkdir -p "$bin_dir"
if [[ ! -d "$config_dir" ]]; then
  mkdir -m 700 -p "$config_dir"
fi
mv -- "$download" "$binary"
installed_binary=1
mv -- "$staged_config" "$config"
installed_config=1
chmod 700 "$binary"

printf '\nopenlaunch Pi agent installed (%s, %s).\n' "$version" "$artifact_arch"
printf 'Device credentials are stored privately at %s\n' "$config"
printf 'Start the agent with: %q --config %q\n' "$binary" "$config"
printf 'The runtime currently reports process health only; no physical GPIO/display action is enabled.\n'
