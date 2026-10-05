import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "scripts/install-pi.sh");
const workspace = "a".repeat(64);
const sdkToken = `ol_sdk_${workspace}_${"b".repeat(64)}`;
const artifactUrl =
  "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm64";

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
if [[ " $* " == *" --check-config "* ]]; then
  exit "\${TEST_CHECK_CONFIG_FAIL:-0}"
fi
[[ "\${TEST_NO_ENROLL:-0}" != 1 ]] || exit 79
if [[ " $* " == *" --linux-init "* ]]; then
  while (($#)); do
    if [[ "$1" == --config ]]; then config="$2"; shift 2; else shift; fi
  done
  umask 077
  printf '{"version":1}' > "$(dirname "$config")/policy.json"
  exit 0
fi
[[ "\${OPENLAUNCH_SDK_TOKEN:-}" == "$TEST_EXPECT_TOKEN" ]] || exit 71
for arg in "$@"; do [[ "$arg" != "$TEST_EXPECT_TOKEN" ]] || exit 72; done
[[ " $* " == *" --attach "* ]] || exit 73
[[ " $* " != *" --workspace "* ]] || exit 74
config=""
saved_profile=""
[[ " $* " != *" --profile linux "* ]] || saved_profile=linux
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
python3 - "$config" "$saved_profile" <<'JSON'
import json, os, sys
path, profile = sys.argv[1:]
with open(path, 'w') as out:
    json.dump({'url':'https://www.openlaunch.dev','workspace':'${workspace}',
               'deviceId':'00000000-0000-4000-8000-000000000001',
               'token':'child-device-credential','simulate':False,'profile':profile,
               'policy':os.path.join(os.path.dirname(path), 'policy.json')}, out)
JSON
`;

async function fixture(linux = false) {
  const base = await mkdtemp(join(tmpdir(), "openlaunch-pi-installer-"));
  const home = join(base, "home");
  const bin = join(base, "mock-bin");
  await mkdir(home);
  await mkdir(bin);
  const manifestPath = join(base, "manifest.json");
  const artifactPath = join(base, "artifact");
  await writeFile(join(bin, "curl"), mockCurl);
  await writeFile(join(bin, "uname"), mockUname);
  await writeFile(join(bin, "id"), "#!/bin/sh\nprintf '1000\\n'\n");
  await chmod(join(bin, "id"), 0o755);
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
  const writeManifest = async (
    url = linux
      ? artifactUrl.replace(
          "/downloads/pi/openlaunch-device-",
          "/downloads/linux/openlaunch-host-",
        )
      : artifactUrl,
    sha256 = digest,
  ) => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: "0.1.0-test.1",
        commit: "1234567890abcdef1234567890abcdef12345678",
        artifacts: {
          "linux-arm64": { url, sha256 },
          "linux-arm": {
            url: "https://www.openlaunch.dev/downloads/pi/openlaunch-device-linux-arm",
            sha256: digest,
          },
          "linux-amd64": {
            url: "https://www.openlaunch.dev/downloads/linux/openlaunch-host-linux-amd64",
            sha256: digest,
          },
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
    return spawnSync(
      linux ? join(root, "scripts/install-linux.sh") : installer,
      [],
      { cwd: root, env, encoding: "utf8" },
    );
  };
  return { base, home, bin, artifactPath, manifestPath, writeManifest, run };
}

test("Linux installer supports x86-64, keeps Node CLI names separate and configures PATH", async () => {
  const current = await fixture(true);
  try {
    const { home, run } = current;
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(
      join(home, ".local/bin/openlaunch-device"),
      "existing Node adapter",
    );
    const result = run({ TEST_UNAME_M: "x86_64", SHELL: "/bin/bash" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      await readFile(join(home, ".local/bin/openlaunch-device"), "utf8"),
      "existing Node adapter",
    );
    assert.equal(
      (await stat(join(home, ".local/bin/openlaunch-host"))).mode & 0o777,
      0o700,
    );
    const privateDir = join(home, ".config/openlaunch/host");
    assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(privateDir, "policy.json"))).mode & 0o777,
      0o600,
    );
    assert.match(
      await readFile(join(home, ".profile"), "utf8"),
      /openlaunch Linux host PATH/,
    );
    assert.match(result.stdout, /openlaunch-host service install/);
    assert.doesNotMatch(result.stdout + result.stderr, /ol_sdk_|bbbbbbbb/);
  } finally {
    await rm(current.base, { recursive: true, force: true });
  }
});

test("Linux installer rejects checksum failure and protects existing host identity", async () => {
  const current = await fixture(true);
  try {
    await current.writeManifest(
      "https://www.openlaunch.dev/downloads/linux/openlaunch-host-linux-arm64",
      "0".repeat(64),
    );
    assert.notEqual(current.run().status, 0);
    const identity = join(current.home, ".config/openlaunch/host/device.json");
    await mkdir(join(current.home, ".config/openlaunch/host"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(identity, "existing identity", { mode: 0o600 });
    assert.match(
      current.run().stderr,
      /saved identity is invalid or not private/,
    );
    assert.equal(await readFile(identity, "utf8"), "existing identity");
  } finally {
    await rm(current.base, { recursive: true, force: true });
  }
});

test("Linux upgrades preserve credentials, policy, journal and uploads without enrollment", async () => {
  const current = await fixture(true);
  try {
    assert.equal(current.run().status, 0);
    const state = join(current.home, ".config/openlaunch/host");
    const binary = join(current.home, ".local/bin/openlaunch-host");
    await writeFile(binary, "old installed binary", { mode: 0o700 });
    const saved = new Map([
      ["device.json", await readFile(join(state, "device.json"))],
      ["policy.json", Buffer.from('{"owner":"custom policy"}')],
      ["device.json.journal", Buffer.from('{"pending":"saved result"}')],
      ["upload-staging", Buffer.from("unfinished upload")],
    ]);
    for (const [name, bytes] of saved)
      await writeFile(join(state, name), bytes, { mode: 0o600 });
    const result = current.run({
      OPENLAUNCH_SDK_TOKEN: "",
      TEST_NO_ENROLL: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No pairing or grant changes/);
    assert.deepEqual(
      await readFile(binary),
      await readFile(current.artifactPath),
    );
    for (const [name, bytes] of saved)
      assert.deepEqual(await readFile(join(state, name)), bytes);
    const again = current.run({
      OPENLAUNCH_SDK_TOKEN: "",
      TEST_NO_ENROLL: "1",
    });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /latest published binary/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /child-device-credential|ol_sdk_/,
    );
  } finally {
    await rm(current.base, { recursive: true, force: true });
  }
});

test("Linux upgrades validate before replacing and roll back a failed service restart", async () => {
  const current = await fixture(true);
  try {
    assert.equal(current.run().status, 0);
    const binary = join(current.home, ".local/bin/openlaunch-host");
    await writeFile(binary, "previous binary", { mode: 0o700 });
    const invalid = current.run({
      TEST_CHECK_CONFIG_FAIL: "1",
      OPENLAUNCH_SDK_TOKEN: "",
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(await readFile(binary, "utf8"), "previous binary");
    const serviceLog = join(current.base, "service.log");
    const mockSystemctl = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_SERVICE_LOG"
if [[ "$2" == start ]] && [[ ! -e "$TEST_SERVICE_LOG.failed" ]]; then
  touch "$TEST_SERVICE_LOG.failed"
  exit 1
fi
exit 0
`;
    await writeFile(join(current.bin, "systemctl"), mockSystemctl, {
      mode: 0o755,
    });
    const failed = current.run({
      TEST_SERVICE_LOG: serviceLog,
      OPENLAUNCH_SDK_TOKEN: "",
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Previous binary restored/);
    assert.equal(await readFile(binary, "utf8"), "previous binary");
    assert.deepEqual((await readFile(serviceLog, "utf8")).trim().split("\n"), [
      "--user is-active --quiet openlaunch-host.service",
      "--user stop openlaunch-host.service",
      "--user start openlaunch-host.service",
      "--user stop openlaunch-host.service",
      "--user start openlaunch-host.service",
    ]);
    const good = current.run({
      TEST_SERVICE_LOG: serviceLog,
      OPENLAUNCH_SDK_TOKEN: "",
    });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /restarted the existing user service/);
  } finally {
    await rm(current.base, { recursive: true, force: true });
  }
});

test("Linux upgrades leave a busy foreground runtime and failed checksum untouched", async () => {
  const current = await fixture(true);
  let child;
  let exited;
  try {
    assert.equal(current.run().status, 0);
    const binary = join(current.home, ".local/bin/openlaunch-host");
    await writeFile(binary, "previous binary", { mode: 0o700 });
    await current.writeManifest(
      "https://www.openlaunch.dev/downloads/linux/openlaunch-host-linux-arm64",
      "0".repeat(64),
    );
    assert.notEqual(current.run({ OPENLAUNCH_SDK_TOKEN: "" }).status, 0);
    assert.equal(await readFile(binary, "utf8"), "previous binary");
    await current.writeManifest();
    const lock = join(current.home, ".config/openlaunch/host/runtime.lock");
    child = spawn("python3", [
      "-c",
      "import fcntl, os, sys; f=open(sys.argv[1], 'w'); os.chmod(sys.argv[1], 0o600); fcntl.flock(f, fcntl.LOCK_EX); print('ready', flush=True); sys.stdin.read()",
      lock,
    ]);
    exited = once(child, "exit");
    await once(child.stdout, "data");
    const busy = current.run({ OPENLAUNCH_SDK_TOKEN: "" });
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /Stop the foreground runner with Ctrl-C/);
    assert.equal(await readFile(binary, "utf8"), "previous binary");
  } finally {
    if (child) {
      child.stdin.end();
      await exited;
    }
    await rm(current.base, { recursive: true, force: true });
  }
});

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
    assert.equal(
      (await stat(join(home, ".config/openlaunch"))).mode & 0o777,
      0o700,
    );
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
    assert.equal(
      await exists(join(home, ".local/bin/openlaunch-device")),
      false,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /ol_sdk_|bbbbbbbb/);
  });
});

test("Pi installer resumes a private pending request and refuses pending symlinks", async () => {
  await withFixture(async ({ home, run }) => {
    const configDir = join(home, ".config/openlaunch");
    const pending = join(configDir, "device.json.attach-pending");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(pending, '{"requestId":"preserve-this-request"}', {
      mode: 0o600,
    });
    let result = run({ TEST_ATTACH_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Resuming the saved attachment request/);
    assert.equal(
      await readFile(pending, "utf8"),
      '{"requestId":"preserve-this-request"}',
    );

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
    await writeManifest(
      "https://attacker.example/downloads/pi/openlaunch-device",
    );
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact URL must be HTTPS/);
    assert.equal(
      await exists(join(home, ".local/bin/openlaunch-device")),
      false,
    );

    await writeManifest(artifactUrl, "0".repeat(64));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256/);
    assert.equal(
      await exists(join(home, ".config/openlaunch/device.json")),
      false,
    );
  });
});

test("Pi installer refuses to overwrite an existing identity", async () => {
  await withFixture(async ({ home, run }) => {
    const config = join(home, ".config/openlaunch/device.json");
    await mkdir(join(home, ".config/openlaunch"), { recursive: true });
    await writeFile(config, '{"existing":true}');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /refusing to overwrite existing device identity/,
    );
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
