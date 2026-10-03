import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "openlaunch-e2e-"));
const owner = randomBytes(32).toString("hex"),
  agent = randomBytes(32).toString("hex");
const port = 19878;
const base = `http://127.0.0.1:${port}`;
let server;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function start() {
  server = spawn(
    process.execPath,
    ["--import", "tsx", "apps/local/src/server.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        OPENLAUNCH_STATE_DIR: dir,
        OPENLAUNCH_OWNER_TOKEN: owner,
        OPENLAUNCH_AGENT_TOKEN: agent,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((ok, bad) => {
    server.stdout.once("data", ok);
    server.once("exit", (code) => bad(Error("server exited " + code)));
  });
}
async function call(path, method = "GET", data, token = owner) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(`${path}: ${r.status} ${JSON.stringify(b)}`);
  return b.data;
}
const run = (args, extra = {}) =>
  new Promise((ok, bad) => {
    const p = spawn(resolve("dist/openlaunch-device-host"), args, {
      env: { ...process.env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    p.stderr.on("data", (b) => (output += b));
    p.once("exit", (code) =>
      code === 0 ? ok() : bad(Error("device failed " + output)),
    );
  });
try {
  await start();
  const e = await call("/v1/enrollments", "POST", { kind: "raspberry-pi-4" });
  const config = join(dir, "device.json");
  await run(["--enroll", "--url", base, "--config", config, "--simulate"], {
    OPENLAUNCH_ENROLLMENT_TOKEN: e.token,
  });
  const [d] = await call("/v1/devices");
  assert(d);
  await call("/v1/grants", "POST", {
    principal: "local-agent",
    deviceId: d.id,
    capabilities: ["device.health", "display.text", "led.set"],
  });
  const a = await call(
    `/v1/devices/${d.id}/actions`,
    "POST",
    {
      capability: "display.text",
      arguments: { text: "hello openlaunch" },
      idempotencyKey: "e2e-1",
    },
    agent,
  );
  assert.equal(a.status, "queued");
  await run(["--config", config, "--once"]);
  const done = await call(`/v1/actions/${a.id}`);
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.simulated, true);
  await new Promise((ok) => {
    server.once("exit", ok);
    server.kill("SIGTERM");
  });
  await start();
  assert.equal((await call(`/v1/actions/${a.id}`)).status, "succeeded");
  const duplicate = await call(
    `/v1/devices/${d.id}/actions`,
    "POST",
    {
      capability: "display.text",
      arguments: { text: "hello openlaunch" },
      idempotencyKey: "e2e-1",
    },
    agent,
  );
  assert.equal(duplicate.id, a.id);
  await call(`/v1/devices/${d.id}/revoke`, "POST", {});
  assert.equal((await call("/v1/devices")).length, 0);
  console.log(
    "PASS: real HTTP + Go client enrollment/action/acknowledgment + SQLite restart + deduplication + revocation (simulated hardware)",
  );
} finally {
  if (server && !server.killed)
    await new Promise((ok) => {
      server.once("exit", ok);
      server.kill("SIGTERM");
    });
  await rm(dir, { recursive: true, force: true });
}
