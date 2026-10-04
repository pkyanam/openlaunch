#!/usr/bin/env bash
set -euo pipefail

command -v python3 >/dev/null || { echo 'Install Python 3, then run this command again.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'Install curl, then run this command again.' >&2; exit 1; }
[[ -r /dev/tty ]] || { echo 'Run setup in an interactive terminal.' >&2; exit 1; }

ol_helper=$(mktemp)
trap 'rm -f "$ol_helper"' EXIT
curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  'https://www.openlaunch.dev/downloads/provision-uno.py' -o "$ol_helper"
python3 "$ol_helper" "$@" </dev/tty
