#!/usr/bin/env bash
set -euo pipefail
# One entry point; credentials are entered only in the selected helper.
for ol_tool in curl python3; do
  command -v "$ol_tool" >/dev/null || { printf 'Install %s, then retry.\n' "$ol_tool" >&2; exit 1; }
done
ol_helper=$(mktemp)
trap 'rm -f "$ol_helper"' EXIT
curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  --connect-timeout 15 --max-time 30 --max-filesize 65536 \
  https://www.openlaunch.dev/downloads/setup.py -o "$ol_helper"
python3 "$ol_helper" "$@"
