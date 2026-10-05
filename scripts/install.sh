#!/usr/bin/env bash
set -euo pipefail
# Installs source and launches the local console. Never flashes a board or changes cloud resources.
repo=https://github.com/pkyanam/openlaunch.git
install_dir=${OPENLAUNCH_INSTALL_DIR:-"$HOME/.local/share/openlaunch"}
for tool in git node npm; do
  command -v "$tool" >/dev/null || { printf 'Install %s first. See https://www.openlaunch.dev/docs/resources\n' "$tool" >&2; exit 1; }
done
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { printf 'Node 24 or newer is required.\n' >&2; exit 1; }
# Follow the deployed GitHub commit, rather than unchecked changes on main.
ol_commit=$(node --input-type=module -e '
  const r = await fetch("https://www.openlaunch.dev/downloads/installers.json", {redirect: "error", signal: AbortSignal.timeout(15000), headers: {"Cache-Control": "no-cache"}});
  if (!r.ok) throw Error("Could not read the deployed source version");
  const {commit} = await r.json();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("Invalid deployed source commit");
  process.stdout.write(commit);
')
if [ -e "$install_dir" ]; then
  [ -d "$install_dir/.git" ] || { printf 'Destination exists and is not a checkout: %s\n' "$install_dir" >&2; exit 1; }
  [ "$(git -C "$install_dir" remote get-url origin)" = "$repo" ] || { printf 'Destination belongs to another repository.\n' >&2; exit 1; }
  printf 'Using existing checkout without changing its files: %s\n' "$install_dir"
else
  mkdir -p "$(dirname "$install_dir")"
  git clone --no-checkout "$repo" "$install_dir"
  git -C "$install_dir" checkout --detach "$ol_commit"
fi
cd "$install_dir"
npm ci
npm run build --workspace @openlaunch/web
printf '\nInstalled. Starting your console; Ctrl-C stops it.\n'
exec node scripts/start-local.mjs
