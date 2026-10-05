import test from "node:test";
import assert from "node:assert/strict";
import { runAgentCli } from "../packages/sdk/src/agent-cli.ts";
import {
  writeAgentConfig,
  readAgentConfig,
  removeAgentConfig,
} from "../packages/sdk/src/agent-config.ts";
import { mkdtemp, rm, chmod, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { askSecret } from "../packages/sdk/src/secret.ts";

const workspace = "a".repeat(64);
const token = `ol_agent_${workspace}_${"b".repeat(64)}`;
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const actionId = "123e4567-e89b-42d3-a456-426614174001";
const definition = {
  name: "custom.clean",
  title: "Clean",
  description: "Custom clean function.",
  access: "write",
  inputSchema: {
    type: "object",
    properties: { mode: { type: "string", maxLength: 8, enum: ["standard"] } },
    required: ["mode"],
    additionalProperties: false,
  },
};
const functionRows = [
  {
    deviceId,
    deviceName: "test device",
    kind: "custom.vacuum",
    definition,
    guide: "Schema guide.",
  },
  {
    deviceId: "other-device",
    deviceName: "other",
    kind: "custom.other",
    definition,
    guide: "Schema guide.",
  },
];
const environment = {
  OPENLAUNCH_AGENT_TOKEN: token,
  OPENLAUNCH_URL: "https://api.example.test",
  OPENLAUNCH_WORKSPACE: workspace,
};
function makeOutput() {
  let text = "";
  return { output: { write: (value) => (text += value) }, read: () => text };
}

test("agent CLI uses the SDK auth and emits JSON for dynamic device and function lists", async () => {
  const seen = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    const data =
      new URL(request.url).pathname === "/v1/devices"
        ? [{ id: deviceId, name: "test device" }]
        : functionRows;
    return Response.json({ data });
  };
  const devices = makeOutput();
  await runAgentCli(["devices", "list"], environment, devices.output, {
    fetch,
  });
  assert.deepEqual(JSON.parse(devices.read()), [
    { id: deviceId, name: "test device" },
  ]);
  const functions = makeOutput();
  await runAgentCli(
    ["functions", "list", "--device", deviceId],
    environment,
    functions.output,
    { fetch },
  );
  assert.deepEqual(JSON.parse(functions.read()), [functionRows[0]]);
  assert.deepEqual(
    seen.map((request) => new URL(request.url).pathname),
    ["/v1/devices", "/v1/functions"],
  );
  for (const request of seen) {
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(request.headers.get("x-openlaunch-workspace"), workspace);
  }
  assert.doesNotMatch(devices.read() + functions.read(), new RegExp(token));
});

test("agent CLI calls arbitrary function names with JSON arguments and an idempotency key", async () => {
  let body;
  let seenRequest;
  const fetch = async (input, init) => {
    seenRequest = new Request(input, init);
    body = await seenRequest.clone().json();
    return Response.json(
      {
        data: {
          id: actionId,
          deviceId,
          capability: definition.name,
          args: body.arguments,
          status: "queued",
          createdAt: 1,
          expiresAt: 2,
        },
      },
      { status: 202 },
    );
  };
  const output = makeOutput();
  await runAgentCli(
    [
      "call",
      deviceId,
      definition.name,
      '{"mode":"standard"}',
      "--key",
      "try-1",
      "--ttl",
      "45",
    ],
    environment,
    output.output,
    { fetch },
  );
  assert.equal(
    new URL(seenRequest.url).pathname,
    `/v1/devices/${deviceId}/actions`,
  );
  assert.equal(seenRequest.headers.get("authorization"), `Bearer ${token}`);
  assert.deepEqual(body, {
    capability: "custom.clean",
    arguments: { mode: "standard" },
    idempotencyKey: "try-1",
    ttlSeconds: 45,
  });
  const result = JSON.parse(output.read());
  assert.equal(result.idempotencyKey, "try-1");
  assert.equal(result.action.status, "queued");
  await assert.rejects(
    runAgentCli(
      ["call", deviceId, definition.name, "[]", "--key", "try-invalid"],
      environment,
      makeOutput().output,
      { fetch },
    ),
    /JSON object/,
  );
});

test("generated call keys are reported on uncertain failures and can be reused explicitly", async () => {
  const keys = [];
  let calls = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    keys.push((await request.json()).idempotencyKey);
    calls++;
    if (calls === 1) throw new Error("simulated response loss");
    return Response.json(
      { data: { id: actionId, status: "queued" } },
      { status: 202 },
    );
  };
  const first = makeOutput();
  await assert.rejects(
    runAgentCli(
      ["call", deviceId, definition.name, '{"mode":"standard"}'],
      environment,
      first.output,
      { fetch },
    ),
    /reuse the reported idempotencyKey/,
  );
  const failed = JSON.parse(first.read());
  assert.equal(failed.error.code, "network");
  assert.equal(failed.error.status, 0);
  assert.ok(failed.idempotencyKey);
  const retry = makeOutput();
  await runAgentCli(
    [
      "call",
      deviceId,
      definition.name,
      '{"mode":"standard"}',
      "--key",
      failed.idempotencyKey,
    ],
    environment,
    retry.output,
    { fetch },
  );
  assert.deepEqual(keys, [failed.idempotencyKey, failed.idempotencyKey]);
  assert.equal(JSON.parse(retry.read()).action.status, "queued");
});

test("agent CLI gets and watches actions until a terminal result, emitting JSON status lines", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    const statuses = ["queued", "received", "succeeded"];
    return Response.json({
      data: {
        id: actionId,
        deviceId,
        capability: definition.name,
        args: { mode: "standard" },
        status: statuses[Math.min(calls - 1, statuses.length - 1)],
        createdAt: 1,
        expiresAt: 2,
        ...(calls >= 3 ? { result: { transmitted: true } } : {}),
      },
    });
  };
  const output = makeOutput();
  await runAgentCli(
    [
      "actions",
      "watch",
      actionId,
      "--interval-ms",
      "100",
      "--timeout-seconds",
      "5",
    ],
    environment,
    output.output,
    { fetch, sleep: async () => {} },
  );
  const statuses = output
    .read()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).status);
  assert.deepEqual(statuses, ["queued", "received", "succeeded"]);
  assert.equal(calls, 3);
});

test("agent CLI requires an agent login and rejects secret flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ol-empty-"));
  try {
    await assert.rejects(
      runAgentCli(["devices", "list"], {}, makeOutput().output, {
        configDirectory: directory,
      }),
      /OPENLAUNCH_AGENT_TOKEN/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(
    runAgentCli(
      ["devices", "list", "--token", "secret"],
      environment,
      makeOutput().output,
    ),
    /Usage:/,
  );
});

test("private saved agent login powers discovery, environment overrides it, and logout erases it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ol-config-"));
  const configDirectory = join(directory, "config");
  try {
    const config = { version: 1, url: environment.OPENLAUNCH_URL, token };
    await writeAgentConfig(config, configDirectory);
    assert.equal((await stat(configDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(configDirectory, "agent.json"))).mode & 0o777,
      0o600,
    );
    assert.deepEqual(await readAgentConfig(configDirectory), config);
    const requests = [];
    const fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [] });
    };
    const output = makeOutput();
    await runAgentCli(["devices", "list"], {}, output.output, {
      configDirectory,
      fetch,
    });
    assert.equal(requests[0].headers.get("authorization"), `Bearer ${token}`);
    assert.equal(new URL(requests[0].url).origin, config.url);
    const override = `ol_agent_${workspace}_${"c".repeat(64)}`;
    await runAgentCli(
      ["devices", "list"],
      { OPENLAUNCH_AGENT_TOKEN: override },
      output.output,
      { configDirectory, fetch },
    );
    assert.equal(
      requests[1].headers.get("authorization"),
      `Bearer ${override}`,
    );
    assert.equal(new URL(requests[1].url).origin, "https://www.openlaunch.dev");
    assert.doesNotMatch(output.read(), /ol_agent_/);
    await removeAgentConfig(configDirectory);
    assert.equal(await readAgentConfig(configDirectory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved login rejects device credentials, unsafe permissions and linked files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ol-config-boundary-"));
  try {
    const config = { version: 1, url: "https://www.openlaunch.dev", token };
    await assert.rejects(
      writeAgentConfig(
        { ...config, token: token.replace("ol_agent_", "ol_sdk_") },
        directory,
      ),
      /agent_ API credential/,
    );
    await assert.rejects(
      writeAgentConfig(
        { ...config, url: "http://external.example" },
        directory,
      ),
      /HTTPS/,
    );
    await writeAgentConfig(config, directory);
    const path = join(directory, "agent.json");
    await chmod(path, 0o644);
    await assert.rejects(
      readAgentConfig(directory),
      /private ol configuration/,
    );
    await assert.rejects(writeAgentConfig(config, directory), /unsafe/);
    await rm(path);
    const target = join(directory, "other.json");
    await writeFile(target, JSON.stringify(config), { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(
      readAgentConfig(directory),
      /private ol configuration/,
    );
    await assert.rejects(writeAgentConfig(config, directory), /unsafe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI cancellation uses the shared SDK cancel route", async () => {
  let request;
  const output = makeOutput();
  await runAgentCli(
    ["actions", "cancel", actionId],
    environment,
    output.output,
    {
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ data: { id: actionId, status: "cancelled" } });
      },
    },
  );
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).pathname, `/v1/actions/${actionId}/cancel`);
  assert.equal(JSON.parse(output.read()).status, "cancelled");
});

test("hidden login input never echoes a credential and restores terminal state on completion or cancellation", async () => {
  for (const cancel of [false, true]) {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      isPaused: () => false,
      setRawMode(value) {
        this.isRaw = value;
      },
      resume() {},
      pause() {
        this.paused = true;
      },
    });
    const output = makeOutput();
    const promise = askSecret(
      "Agent token: ",
      input,
      { ...output.output, isTTY: true },
      "OPENLAUNCH_AGENT_TOKEN",
    );
    input.emit(
      "data",
      Buffer.from(cancel ? "private-token\u0003" : "private-token\n"),
    );
    if (cancel) await assert.rejects(promise, /cancelled/);
    else assert.equal(await promise, "private-token");
    assert.equal(input.isRaw, false);
    assert.equal(input.paused, true);
    assert.equal(input.listenerCount("data"), 0);
    assert.doesNotMatch(output.read(), /private-token/);
  }
});
