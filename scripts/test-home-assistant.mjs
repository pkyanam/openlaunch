/** Boot disposable real Home Assistant, exercise MCP, then retire all local assets. */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const image =
  "ghcr.io/home-assistant/home-assistant@sha256:3e6710a7ab2a61311d9d899b719f6c3657791c63e8f4942cec4ebc42401d6b76";
const directory = await mkdtemp(join(tmpdir(), "openlaunch-ha-acceptance-"));
await chmod(directory, 0o700);
const name = "openlaunch-ha-test-" + randomBytes(6).toString("hex");
let created = false;
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
async function post(origin, path, body, form = false) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
    },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Error(
      "Disposable HA onboarding failed (HTTP " + response.status + ")",
    );
  return response.json();
}
try {
  await writeFile(
    join(directory, "configuration.yaml"),
    "default_config:\ninput_boolean:\n  openlaunch_test:\n    name: openlaunch test toggle\n    initial: false\nscript:\n  openlaunch_test_script:\n    alias: openlaunch test script\n    sequence:\n      - action: input_boolean.turn_on\n        target:\n          entity_id: input_boolean.openlaunch_test\n",
    { mode: 0o600 },
  );
  console.log(
    "Starting disposable Home Assistant 2026.9.4. No physical devices are controlled.",
  );
  const pull = spawn("docker", ["pull", image], { stdio: "inherit" });
  await new Promise((ok, bad) => {
    pull.on("error", bad);
    pull.on("exit", (code) =>
      code === 0 ? ok() : bad(Error("HA image download failed")),
    );
  });
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::8123",
    "-v",
    directory + ":/config",
    image,
  ]);
  created = true;
  const port = docker(["port", name, "8123/tcp"]).trim().split(":").at(-1);
  const origin = "http://127.0.0.1:" + port;
  let ready = false;
  for (let n = 0; n < 90; n++) {
    try {
      const r = await fetch(origin + "/api/onboarding", {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (n % 10 === 0) console.log("Waiting for HA startup…");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw Error("Disposable HA did not start in 90 seconds");
  const user = await post(origin, "/api/onboarding/users", {
    client_id: origin + "/",
    name: "openlaunch acceptance",
    username: "openlaunch_test",
    password: randomBytes(32).toString("hex"),
    language: "en",
  });
  const token = await post(
    origin,
    "/auth/token",
    {
      grant_type: "authorization_code",
      client_id: origin + "/",
      code: user.auth_code,
    },
    true,
  );
  const tokenPath = join(directory, "private-test-token.json");
  await writeFile(tokenPath, JSON.stringify(token), { mode: 0o600 });
  const test = spawn(
    process.execPath,
    ["--import", "tsx", resolve("scripts/home-assistant-e2e.mjs")],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        HA_URL: origin,
        HA_TOKEN_FILE: tokenPath,
        HA_TEST_SCRIPT: "script.openlaunch_test_script",
      },
    },
  );
  await new Promise((ok, bad) => {
    test.on("error", bad);
    test.on("exit", (code) =>
      code === 0 ? ok() : bad(Error("Real HA acceptance failed")),
    );
  });
} finally {
  if (created) {
    try {
      docker(["rm", "-f", name]);
      // HA writes root-owned files on native Linux bind mounts. Restore ownership
      // of this disposable directory after stopping it so an unprivileged CI user
      // can remove private onboarding credentials along with the fixture.
      if (process.getuid && process.getgid) {
        docker([
          "run",
          "--rm",
          "--entrypoint",
          "python",
          "-v",
          directory + ":/config",
          image,
          "-c",
          "import os,sys; uid,gid=map(int,sys.argv[1:]); paths=['/config']; paths += [os.path.join(root,name) for root,dirs,files in os.walk('/config') for name in dirs+files]; [os.chown(path,uid,gid,follow_symlinks=False) for path in paths]",
          String(process.getuid()),
          String(process.getgid()),
        ]);
      }
    } catch {
      console.error("Could not retire disposable HA assets for " + name);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
