#!/usr/bin/env bash
set -euo pipefail
umask 077
# Install the verified SDK from the current deployed website. Pairing lives in /data.
curl --fail --silent --show-error --proto '=https' --max-redirs 0 \
  --connect-timeout 15 --max-time 30 https://www.openlaunch.dev/setup.sh -o /tmp/openlaunch-setup.sh
bash /tmp/openlaunch-setup.sh cli
if [[ ! -f /data/openlaunch/identity.json ]]; then
  export OPENLAUNCH_SETUP_TOKEN
  OPENLAUNCH_SETUP_TOKEN=$(python3 -c 'import json; print(json.load(open("/data/options.json")).get("setup_token", ""))')
  if [[ -z "$OPENLAUNCH_SETUP_TOKEN" ]]; then
    printf 'Create a Home Assistant setup token in the openlaunch console, paste it in this app configuration, then restart.\n' >&2
    exit 1
  fi
  exec /root/.local/bin/openlaunch-ha setup --directory /data/openlaunch
fi
# Recovery requires the owner to enter one exact interrupted action ID. It never
# applies to later actions, even if the configuration is left unchanged.
export OPENLAUNCH_RECOVERY_ACTION_ID
OPENLAUNCH_RECOVERY_ACTION_ID=$(python3 -c 'import json; print(json.load(open("/data/options.json")).get("recovery_action_id", ""))')
if [[ -n "$OPENLAUNCH_RECOVERY_ACTION_ID" ]]; then
  /root/.local/bin/openlaunch-ha recover --directory /data/openlaunch
fi
exec /root/.local/bin/openlaunch-ha start --directory /data/openlaunch
