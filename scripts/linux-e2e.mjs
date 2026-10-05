// Actual Linux host operations over the local authenticated API and MCP.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "linux") {
  console.log(
    "Linux host HTTP acceptance runs on Linux CI; filesystem/subprocess unit tests also run on macOS.",
  );
  process.exit(0);
}
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "openlaunch-linux-e2e-")),
);
const home = join(directory, "home");
await mkdir(home, { mode: 0o700 });
const binary = join(directory, "openlaunch-host");
await copyFile(resolve("dist/openlaunch-device-host"), binary);
await chmod(binary, 0o700);
const config = join(home, ".config/openlaunch/host/device.json");
const owner = randomBytes(32).toString("hex");
const legacyAgent = randomBytes(32).toString("hex");
const reserved = createServer();
await new Promise((ok) => reserved.listen(0, "127.0.0.1", ok));
const port = reserved.address().port;
await new Promise((ok) => reserved.close(ok));
const origin = `http://127.0.0.1:${port}`;
let server;
const execute = (program, args, environment = {}) =>
  new Promise((ok, bad) => {
    const child = spawn(program, args, {
      env: { ...process.env, HOME: home, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (error += b));
    child.once("error", bad);
    child.once("exit", (code) =>
      code === 0
        ? ok(output)
        : bad(Error(`local fixture process failed (${code}): ${error}`)),
    );
  });
const host = (args, env) => execute(binary, args, env);
const call = async (
  path,
  method = "GET",
  data,
  token = owner,
  expected = 200,
) => {
  const response = await fetch(origin + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal(response.status, expected, `unexpected HTTP status for ${path}`);
  const body = await response.json();
  return body.data;
};
const cli = (args, token) =>
  execute(
    process.execPath,
    ["--import", "tsx", "packages/sdk/src/agent-cli.ts", ...args],
    { OPENLAUNCH_URL: origin, OPENLAUNCH_AGENT_TOKEN: token },
  );
let rpcID = 0;
const mcp = async (name, args, token) => {
  const method = "tools/call";
  const response = await fetch(origin + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcID,
      method,
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "Linux software acceptance",
            version: "1",
          },
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
};
const stopServer = async () => {
  if (server && !server.killed) {
    await new Promise((ok) => {
      server.once("exit", ok);
      server.kill("SIGTERM");
    });
  }
};
const startServer = async () => {
  server = spawn(
    process.execPath,
    ["--import", "tsx", "apps/local/src/server.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        OPENLAUNCH_STATE_DIR: join(directory, "bridge"),
        OPENLAUNCH_OWNER_TOKEN: owner,
        OPENLAUNCH_AGENT_TOKEN: legacyAgent,
        OPENLAUNCH_DEVICE_CREDENTIAL_KEYS: JSON.stringify({
          v1: randomBytes(32).toString("hex"),
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((ok, bad) => {
    server.stdout.once("data", ok);
    server.once("exit", (code) => bad(Error("local bridge exited " + code)));
  });
};
try {
  await host(["--linux-init", "--config", config]);
  await host([
    "allow-command",
    "probe",
    "/bin/echo",
    "openlaunch Linux round trip",
  ]);
  await host(["allow-shell"]);
  await startServer();
  const setup = await call(
    "/v1/device-setup-tokens",
    "POST",
    { name: "Linux local acceptance", ttlSeconds: 600, deviceLimit: 1 },
    owner,
    201,
  );
  await host(
    ["--attach", "--profile", "linux", "--url", origin, "--config", config],
    { OPENLAUNCH_SDK_TOKEN: setup.token },
  );
  const agent = await call(
    "/v1/agent-connections",
    "POST",
    { name: "Linux acceptance agent", access: "act" },
    owner,
    201,
  );
  const [device] = await call("/v1/devices");
  assert.equal(device.kind, "linux");
  assert(!JSON.stringify(await readFile(config, "utf8")).includes(setup.token));
  assert.deepEqual(
    await call("/v1/devices", "GET", undefined, agent.token),
    [],
  );
  await call(
    `/v1/devices/${device.id}/actions`,
    "POST",
    { capability: "system.info", arguments: {}, idempotencyKey: "ungranted" },
    agent.token,
    403,
  );
  const grant = () =>
    call("/v1/grants", "POST", {
      principal: agent.principal,
      deviceId: device.id,
      capabilities: device.capabilities,
      ttlSeconds: null,
    });
  await grant();
  const catalog = (await mcp("list_functions", {}, agent.token))
    .structuredContent.data;
  assert(catalog.some((row) => row.definition.name === "system.run"));
  const functions = JSON.parse(await cli(["functions", "list"], agent.token));
  assert.equal(functions.length, catalog.length);
  const perform = async (capability, args, key = randomUUID()) => {
    const receipt = (
      await mcp(
        "invoke_device_function",
        {
          deviceId: device.id,
          capability,
          arguments: args,
          idempotencyKey: key,
        },
        agent.token,
      )
    ).structuredContent.data;
    assert.equal(receipt.status, "queued");
    await host(["--config", config, "--once"]);
    const done = await call(
      `/v1/actions/${receipt.id}`,
      "GET",
      undefined,
      agent.token,
    );
    assert.equal(done.status, "succeeded");
    return done;
  };
  const health = await perform("device.health", {});
  assert.equal(health.result.os, "linux");
  assert.equal(health.result.simulated, false);
  assert(health.result.systemUptimeSeconds > 0);
  const command = await perform(
    "system.run",
    { command: "probe" },
    "fixed-command",
  );
  assert.equal(command.result.exitCode, 0);
  assert.match(command.result.stdout, /Linux round trip/);
  const shell = await perform(
    "system.exec",
    {
      command: "printf 'agent shell pipeline\\n' | tr a-z A-Z",
    },
    "shell-command",
  );
  assert.equal(shell.result.exitCode, 0);
  assert.match(shell.result.stdout, /AGENT SHELL PIPELINE/);

  // The local bridge has no notification WebSocket. Exercise the real Go
  // presence fallback during an operation longer than the online window.
  const busy = (
    await mcp(
      "invoke_device_function",
      {
        deviceId: device.id,
        capability: "system.exec",
        arguments: {
          command: "sleep 52; printf 'long command finished\\n'",
          timeoutSeconds: 60,
        },
        ttlSeconds: 90,
        idempotencyKey: "busy-presence",
      },
      agent.token,
    )
  ).structuredContent.data;
  assert.equal(busy.status, "queued");
  const running = host(["--config", config, "--once"]);
  // Attach a rejection handler immediately while checking the live receipt.
  running.catch(() => {});
  let current;
  for (let i = 0; i < 100; i++) {
    current = await call(
      `/v1/actions/${busy.id}`,
      "GET",
      undefined,
      agent.token,
    );
    if (current.status === "received") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.status, "received");
  await new Promise((resolve) => setTimeout(resolve, 46_000));
  const [present] = await call("/v1/devices", "GET", undefined, agent.token);
  assert.equal(
    present.online,
    true,
    "HTTPS presence fallback failed during long execution",
  );
  current = await call(`/v1/actions/${busy.id}`, "GET", undefined, agent.token);
  assert.equal(current.status, "received");
  const waiting = (
    await mcp(
      "invoke_device_function",
      {
        deviceId: device.id,
        capability: "device.health",
        arguments: {},
        ttlSeconds: 90,
        idempotencyKey: "queued-during-busy",
      },
      agent.token,
    )
  ).structuredContent.data;
  assert.equal(waiting.status, "queued");
  await running;
  const finished = await call(
    `/v1/actions/${busy.id}`,
    "GET",
    undefined,
    agent.token,
  );
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.result.exitCode, 0);
  assert.match(finished.result.stdout, /long command finished/);
  assert.equal(
    (await call(`/v1/actions/${waiting.id}`, "GET", undefined, agent.token))
      .status,
    "queued",
    "presence fetched another command",
  );
  await host(["--config", config, "--once"]);
  assert.equal(
    (await call(`/v1/actions/${waiting.id}`, "GET", undefined, agent.token))
      .status,
    "succeeded",
  );

  const duplicate = (
    await mcp(
      "invoke_device_function",
      {
        deviceId: device.id,
        capability: "system.run",
        arguments: { command: "probe" },
        idempotencyKey: "fixed-command",
      },
      agent.token,
    )
  ).structuredContent.data;
  assert.equal(duplicate.id, command.id);
  const rootInfo = await perform("file.root_info", { root: "workspace" });
  assert.equal(
    rootInfo.result.path,
    join(home, ".local/share/openlaunch/workspace"),
  );
  const story = "Once upon a time, a Raspberry Pi wrote a story. 🐧\n";
  const written = await perform("file.write_text", {
    root: "workspace",
    path: "story.txt",
    text: story,
  });
  assert.equal(
    written.result.sha256,
    createHash("sha256").update(story).digest("hex"),
  );
  assert.equal(
    await readFile(join(rootInfo.result.path, "story.txt"), "utf8"),
    story,
  );
  const data = Buffer.from("actual Linux file transfer\n".repeat(360));
  const digest = createHash("sha256").update(data).digest("hex"),
    uploadId = randomUUID();
  for (let offset = 0; offset < data.length; offset += 6144) {
    const end = Math.min(offset + 6144, data.length);
    await perform("file.write", {
      root: "workspace",
      path: "round-trip.txt",
      uploadId,
      offset,
      dataBase64: data.subarray(offset, end).toString("base64"),
      final: end === data.length,
      ...(end === data.length ? { sha256: digest } : {}),
    });
  }
  assert.deepEqual(
    await readFile(
      join(home, ".local/share/openlaunch/workspace/round-trip.txt"),
    ),
    data,
  );
  const collected = [];
  for (let offset = 0; offset < data.length;) {
    const chunk = (
      await perform("file.read", {
        root: "workspace",
        path: "round-trip.txt",
        offset,
      })
    ).result;
    collected.push(Buffer.from(chunk.dataBase64, "base64"));
    offset = chunk.nextOffset;
  }
  assert.deepEqual(Buffer.concat(collected), data);
  await perform("process.list", {});
  await perform("network.interfaces", {});
  // Policy changes invalidate even a queued action before any new execution.
  const queued = (
    await mcp(
      "invoke_device_function",
      {
        deviceId: device.id,
        capability: "system.run",
        arguments: { command: "probe" },
        idempotencyKey: "before-policy-change",
      },
      agent.token,
    )
  ).structuredContent.data;
  await host(["allow-command", "probe", "/bin/echo", "changed owner policy"]);
  await host(["--config", config, "--once"]);
  assert.equal((await call(`/v1/actions/${queued.id}`)).status, "cancelled");
  assert.deepEqual(
    (await mcp("list_functions", {}, agent.token)).structuredContent.data,
    [],
  );
  await grant();
  await stopServer();
  await startServer();
  assert.equal((await call(`/v1/actions/${command.id}`)).status, "succeeded");
  const cliAction = JSON.parse(
    await cli(
      ["call", device.id, "system.run", '{"command":"probe"}'],
      agent.token,
    ),
  ).action;
  await host(["--config", config, "--once"]);
  assert.equal(
    JSON.parse(await cli(["actions", "get", cliAction.id], agent.token)).status,
    "succeeded",
  );
  await call(`/v1/devices/${device.id}/revoke`, "POST", {});
  assert.deepEqual(
    await call("/v1/devices", "GET", undefined, agent.token),
    [],
  );
  console.log(
    "PASS: Linux host SDK attachment, separate agent grants, MCP/CLI discovery and execution, long-command presence and sequential queueing, full-size file chunk round trip, policy reapproval, SQLite reconnect, deduplication and revocation (actual software operations; no physical Pi claim)",
  );
} finally {
  await stopServer();
  await rm(directory, { recursive: true, force: true });
}
