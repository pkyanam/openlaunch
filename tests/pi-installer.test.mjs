import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts/install-pi.sh");
const workspace = "a".repeat(64);
const sdkToken = `ol_sdk_${workspace}_${"b".repeat(64)}`;
const artifactUrl = "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm64";

const mockCurl = `#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
output = args[args.index("--output") + 1]
url = args[-1]
if os.environ.get("TEST_CURL_FAIL") == "1" and not url.endswith("manifest.json"):
    sys.exit(22)
source = os.environ["TEST_MANIFEST"] if url.endswith("manifest.json") else os.environ["TEST_ARTIFACT"]
shutil.copyfile(source, output)
`;

const mockUname = `#!/usr/bin/env sh
case "$1" in
  -s) printf '%s\\n' "\${TEST_UNAME_S:-Linux}" ;;
  -m) printf '%s\\n' "\${TEST_UNAME_M:-aarch64}" ;;
  *) exit 2 ;;
esac
`;

const mockDevice = `#!/usr/bin/env bash
set -eu
[[ "\${OPENLAUNCH_SDK_TOKEN:-}" == "$TEST_EXPECT_TOKEN" ]] || exit 71
for arg in "$@"; do [[ "$arg" != "$TEST_EXPECT_TOKEN" ]] || exit 72; done
[[ " $* " == *" --attach "* ]] || exit 73
[[ " $* " != *" --workspace "* ]] || exit 74
config=""
while (($#)); do
  if [[ "$1" == --config ]]; then config="$2"; shift 2; else shift; fi
done
[[ -n "$config" ]] || exit 75
if [[ "\${TEST_ATTACH_FAIL:-0}" == 1 ]]; then
  if [[ ! -e "$config.attach-pending" ]]; then
    umask 077
    printf '{"version":1}' > "$config.attach-pending"
  fi
  exit 76
fi
mkdir -p "$(dirname "$config")"
umask 077
cat > "$config" <<'JSON'
{"url":"https://www.openlaunch.dev","workspace":"${workspace}","deviceId":"test-device","token":"child-device-credential","simulate":false}
JSON
`;

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "openlaunch-pi-installer-"));
  const home = join(base, "home");
  const bin = join(base, "mock-bin");
  await mkdir(home);
  await mkdir(bin);
  const manifestPath = join(base, "manifest.json");
  const artifactPath = join(base, "artifact");
  await writeFile(join(bin, "curl"), mockCurl);
  await writeFile(join(bin, "uname"), mockUname);
  await writeFile(join(bin, "openlaunch-device"), mockDevice);
  await Promise.all([
    chmod(join(bin, "curl"), 0o755),
    chmod(join(bin, "uname"), 0o755),
    chmod(join(bin, "openlaunch-device"), 0o755),
  ]);
  const artifact = await readFile(join(bin, "openlaunch-device"));
  await writeFile(artifactPath, artifact);
  const digest = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(artifact).digest("hex"),
  );
  const writeManifest = async (url = artifactUrl, sha256 = digest) => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: "0.1.0-test.1",
        commit: "1234567890abcdef1234567890abcdef12345678",
        artifacts: {
          "linux-arm64": { url, sha256 },
          "linux-arm": { url: "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm", sha256: digest },
        },
      }),
    );
  };
  await writeManifest();
  const run = (overrides = {}) => {
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_MANIFEST: manifestPath,
      TEST_ARTIFACT: artifactPath,
      TEST_EXPECT_TOKEN: sdkToken,
      OPENLAUNCH_SDK_TOKEN: sdkToken,
      TEST_UNAME_S: "Linux",
      TEST_UNAME_M: "aarch64",
      ...overrides,
    };
    return spawnSync(installer, [], { cwd: root, env, encoding: "utf8" });
  };
  return { base, home, manifestPath, writeManifest, run };
}

async function withFixture(run) {
  const current = await fixture();
  try {
    await run(current);
  } finally {
    await rm(current.base, { recursive: true, force: true });
  }
}

test("Pi installer asks for one SDK token and installs only the child credential", async () => {
  await withFixture(async ({ home, run }) => {
    const result = run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const binary = join(home, ".local/bin/openlaunch-device");
    const config = join(home, ".config/openlaunch/device.json");
    assert.equal((await stat(binary)).mode & 0o777, 0o700);
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, ".config/openlaunch"))).mode & 0o777, 0o700);
    const saved = await readFile(config, "utf8");
    assert.match(saved, /child-device-credential/);
    assert.doesNotMatch(saved, /ol_sdk_|bbbbbbbb/);
    assert.doesNotMatch(result.stdout + result.stderr, /ol_sdk_|bbbbbbbb/);
    assert.match(result.stdout, /process health only/);
    assert.doesNotMatch(result.stdout, /physical.*success/i);
  });
});

test("Pi installer keeps a pending SDK attachment after a lost-response failure", async () => {
  await withFixture(async ({ home, run }) => {
    const result = run({ TEST_ATTACH_FAIL: "1" });
    const pending = join(home, ".config/openlaunch/device.json.attach-pending");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /same SDK token within 10 minutes/);
    assert.match(result.stderr, /check device inventory/);
    assert.equal((await stat(pending)).mode & 0o777, 0o600);
    assert.equal(await readFile(pending, "utf8"), '{"version":1}');
    assert.equal(await exists(join(home, ".local/bin/openlaunch-device")), false);
    assert.doesNotMatch(result.stdout + result.stderr, /ol_sdk_|bbbbbbbb/);
  });
});

test("Pi installer resumes a private pending request and refuses pending symlinks", async () => {
  await withFixture(async ({ home, run }) => {
    const configDir = join(home, ".config/openlaunch");
    const pending = join(configDir, "device.json.attach-pending");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(pending, '{"requestId":"preserve-this-request"}', { mode: 0o600 });
    let result = run({ TEST_ATTACH_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Resuming the saved attachment request/);
    assert.equal(await readFile(pending, "utf8"), '{"requestId":"preserve-this-request"}');

    await rm(pending);
    await writeFile(join(configDir, "some-other-file"), "do not follow");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(configDir, "some-other-file"), pending);
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing symlinked pending attachment/);

    await rm(pending);
    await writeFile(`${pending}.expired`, '{"expired":true}', { mode: 0o600 });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /check device inventory before removing/);
  });
});

test("Pi installer rejects untrusted artifacts and digest mismatches", async () => {
  await withFixture(async ({ home, writeManifest, run }) => {
    await writeManifest("https://attacker.example/downloads/pi/openlaunch-device");
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact URL must be HTTPS/);
    assert.equal(await exists(join(home, ".local/bin/openlaunch-device")), false);

    await writeManifest(artifactUrl, "0".repeat(64));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256/);
    assert.equal(await exists(join(home, ".config/openlaunch/device.json")), false);
  });
});

test("Pi installer refuses to overwrite an existing identity", async () => {
  await withFixture(async ({ home, run }) => {
    const config = join(home, ".config/openlaunch/device.json");
    await mkdir(join(home, ".config/openlaunch"), { recursive: true });
    await writeFile(config, '{"existing":true}');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite existing device identity/);
    assert.equal(await readFile(config, "utf8"), '{"existing":true}');
  });
});

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
