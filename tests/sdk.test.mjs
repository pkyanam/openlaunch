import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  createDevice,
  OpenLaunchError,
  sdkTokenWorkspace,
} from "../packages/sdk/src/index.ts";

const workspace = "a".repeat(64);
const calls = (responses) => {
  const seen = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    const next = responses.shift();
    return Response.json(next.body, { status: next.status ?? 200 });
  };
  return { fetch, seen };
};

test("agent SDK uses the API contract, bearer token and idempotent queued actions", async () => {
  const action = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    deviceId: "123e4567-e89b-42d3-a456-426614174001",
    capability: "custom.sensor.read",
    args: {},
    status: "queued",
    createdAt: 1,
    expiresAt: 2,
  };
  const { fetch, seen } = calls([
    {
      body: {
        data: [{ id: action.deviceId, kind: "custom.sensor", online: true }],
      },
    },
    { status: 202, body: { data: action } },
    {
      body: { data: { ...action, status: "succeeded", result: { value: 42 } } },
    },
    { body: { data: action } },
  ]);
  const client = createClient({
    url: "https://api.example.test/",
    token: "ol_agent_secret",
    workspace,
    fetch,
  });
  assert.equal((await client.listDevices())[0].kind, "custom.sensor");
  const queued = await client.requestAction(action.deviceId, {
    capability: action.capability,
    arguments: {},
    idempotencyKey: "sensor-read-1",
  });
  assert.equal(queued.status, "queued");
  assert.equal((await client.getAction(action.id)).status, "succeeded");
  await client.cancelAction(action.id);
  assert.deepEqual(
    seen.map((r) => new URL(r.url).pathname),
    [
      "/v1/devices",
      `/v1/devices/${action.deviceId}/actions`,
      `/v1/actions/${action.id}`,
      `/v1/actions/${action.id}/cancel`,
    ],
  );
  assert.equal(seen[0].headers.get("authorization"), "Bearer ol_agent_secret");
  assert.equal(seen[0].headers.get("x-openlaunch-workspace"), workspace);
  const actionBody = await seen[1].json();
  assert.equal(actionBody.idempotencyKey, "sensor-read-1");
  assert.equal(
    actionBody.arguments && Object.keys(actionBody.arguments).length,
    0,
  );
});

test("broadcast preserves per-device queued/error outcomes", async () => {
  const { fetch, seen } = calls([
    {
      status: 202,
      body: {
        data: [
          { deviceId: "one", action: { id: "a", status: "queued" } },
          {
            deviceId: "two",
            error: { code: "offline", message: "Device offline" },
          },
        ],
      },
    },
  ]);
  const client = createClient({
    url: "https://api.example.test",
    token: "agent",
    fetch,
  });
  const outcomes = await client.broadcast({
    deviceIds: ["one", "two"],
    capability: "led.set",
    idempotencyKey: "broadcast-1",
  });
  assert.equal(outcomes[0].action.status, "queued");
  assert.equal(outcomes[1].error.code, "offline");
  assert.equal(new URL(seen[0].url).pathname, "/v1/broadcasts");
});

test("device bridge enrolls, polls and reports actual execution using device bearer credential", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const secret = "device-secret";
  const command = {
    id: "123e4567-e89b-42d3-a456-426614174001",
    status: "received",
  };
  const { fetch, seen } = calls([
    { status: 201, body: { data: { deviceId: id, token: secret } } },
    { body: { data: command } },
    {
      body: { data: { ...command, status: "succeeded", result: { ok: true } } },
    },
  ]);
  const device = createDevice({
    url: "https://api.example.test",
    workspace,
    fetch,
  });
  const enrolled = await device.enroll({
    token: "e".repeat(64),
    manifest: {
      name: "sensor",
      kind: "custom.rp2040",
      capabilities: ["custom.sensor.read"],
      functions: [
        {
          name: "custom.sensor.read",
          title: "Read sensor",
          description: "Read the value.",
          access: "read",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    },
  });
  assert.equal(device.deviceId, id);
  assert.equal(enrolled.token, secret);
  assert.equal((await device.nextAction()).id, command.id);
  assert.equal(
    (
      await device.submitResult(command.id, {
        status: "succeeded",
        result: { ok: true },
      })
    ).status,
    "succeeded",
  );
  assert.deepEqual(
    seen.map((r) => new URL(r.url).pathname),
    ["/v1/device/enroll", `/v1/device/${id}/next`, `/v1/device/${id}/result`],
  );
  assert.equal(seen[0].headers.get("authorization"), null);
  assert.equal((await seen[0].json()).token, "e".repeat(64));
  assert.equal(seen[1].headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(seen[1].headers.get("x-openlaunch-workspace"), workspace);
  assert.equal((await seen[2].json()).status, "succeeded");
});

test("device SDK attaches with the same SDK token and retries using one request ID", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const childCredential = "device-scoped-secret";
  const sdkToken = `ol_sdk_${workspace}_${"b".repeat(64)}`;
  const requestId = "123e4567-e89b-42d3-a456-426614174099";
  const manifest = {
    name: "sensor",
    kind: "custom.rp2040",
    capabilities: ["custom.sensor.read"],
    functions: [
      {
        name: "custom.sensor.read",
        title: "Read sensor",
        description: "Read the value.",
        access: "read",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ],
  };
  const seen = [];
  let attachAttempts = 0;
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    if (new URL(request.url).pathname === "/v1/sdk/devices") {
      attachAttempts++;
      if (attachAttempts === 1) throw new Error("response lost after attach");
      return Response.json({ data: { deviceId: id, token: childCredential } }, { status: 201 });
    }
    if (new URL(request.url).pathname.endsWith("/next"))
      return Response.json({ data: null });
    throw new Error("Unexpected request");
  };
  const device = createDevice({
    url: "https://api.example.test",
    token: sdkToken,
    fetch,
  });
  assert.equal(sdkTokenWorkspace(sdkToken), workspace);
  await assert.rejects(device.attach(manifest, requestId), (error) => error.status === 0);
  const identity = await device.attach(manifest, requestId);
  assert.deepEqual(identity, { deviceId: id, token: childCredential });
  assert.equal(device.deviceId, id);
  await device.nextAction();
  assert.deepEqual(
    seen.map((request) => new URL(request.url).pathname),
    ["/v1/sdk/devices", "/v1/sdk/devices", `/v1/device/${id}/next`],
  );
  for (const request of seen.slice(0, 2)) {
    assert.equal(request.headers.get("authorization"), `Bearer ${sdkToken}`);
    assert.equal(request.headers.get("x-openlaunch-workspace"), workspace);
    assert.deepEqual(await request.clone().json(), { requestId, manifest });
  }
  assert.equal(seen[2].headers.get("authorization"), `Bearer ${childCredential}`);
  assert.equal(seen[2].headers.get("authorization").includes(sdkToken), false);
});

test("device SDK reports owner quota errors without falling back to device credentials", async () => {
  const sdkToken = `ol_sdk_${workspace}_${"c".repeat(64)}`;
  const device = createDevice({
    url: "https://api.example.test",
    token: sdkToken,
    fetch: async () =>
      Response.json(
        { error: { code: "device_limit", message: "internal detail" } },
        { status: 429 },
      ),
  });
  await assert.rejects(
    device.attach(
      { name: "x", kind: "custom.device", capabilities: ["device.health"] },
      "123e4567-e89b-42d3-a456-426614174099",
    ),
    (error) => {
      assert.ok(error instanceof OpenLaunchError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "device_limit");
      assert.equal(error.message.includes("internal detail"), false);
      return true;
    },
  );
  assert.throws(
    () =>
      createDevice({
        url: "https://api.example.test",
        token: "malformed",
      }),
    /device setup token/,
  );
});

test("SDK rejects unsafe origins, missing retry keys, and hides server response text", async () => {
  assert.throws(
    () => createClient({ url: "http://public.example.test", token: "secret" }),
    /HTTPS/,
  );
  assert.throws(
    () => createDevice({ url: "https://api.example.test", workspace: "short" }),
    /workspace/,
  );
  assert.throws(
    () =>
      createDevice({
        url: "https://api.example.test",
        workspace,
        credential: "secret",
      }),
    /deviceId/,
  );
  const { fetch } = calls([
    {
      status: 401,
      body: { error: { code: "unauthorized", message: "secret leaked" } },
    },
  ]);
  const client = createClient({
    url: "http://127.0.0.1:8788",
    token: "secret",
    fetch,
  });
  await assert.rejects(client.listDevices(), (error) => {
    assert.ok(error instanceof OpenLaunchError);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("direct device SDK rejects legacy agent credentials without a network request", () => {
  let calls = 0;
  assert.throws(() => createDevice({
    url: "https://api.example.test",
    token: `ol_agent_${workspace}_${"c".repeat(64)}`,
    fetch: async () => { calls++; throw new Error("unexpected request"); },
  }), /agent tokens cannot pair devices/);
  assert.equal(calls, 0);
  // Routing extraction stays compatible for agent clients using legacy tokens.
  assert.equal(sdkTokenWorkspace(`ol_agent_${workspace}_${"c".repeat(64)}`), workspace);
});
