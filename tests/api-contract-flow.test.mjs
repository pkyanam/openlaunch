import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { createDeviceCredentialDeriver } from "../packages/core/src/device-credentials.ts";
import { handle } from "../packages/http/src/index.ts";
import { buildOpenApi } from "../packages/http/src/contracts.ts";

test("documented response schemas match a real local attach, grant, dispatch, result and revocation flow", async () => {
  const doc = buildOpenApi();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const hub = new Hub(emptyState());
  const owner = { id: "contract-owner", owner: true };
  const context = {
    workspace: "a".repeat(64),
    deviceCredentials: createDeviceCredentialDeriver(
      JSON.stringify({ v1: "b".repeat(64) }),
    ),
  };
  const request = async (
    template,
    method,
    body,
    token,
    ids = {},
    expected = 200,
  ) => {
    const path = template.replace(/\{(\w+)\}/g, (_, name) => ids[name]);
    const response = await handle(
      new Request(`https://contract.test${path}`, {
        method: method.toUpperCase(),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      hub,
      async () => owner,
      context,
    );
    assert.equal(response.status, expected, `${method} ${template}`);
    const schema =
      doc.paths[template][method].responses[String(expected)].content[
        "application/json"
      ].schema;
    const validate = ajv.compile({ ...schema, components: doc.components });
    const payload = await response.text();
    if (expected >= 200 && expected < 300)
      assert.equal(
        Number(response.headers.get("content-length")),
        Buffer.byteLength(payload),
      );
    const value = JSON.parse(payload);
    assert(
      validate(value),
      `${method} ${template}: ${JSON.stringify(validate.errors)}`,
    );
    return Object.hasOwn(value, "data") ? value.data : value;
  };
  const setup = await request(
    "/v1/device-setup-tokens",
    "post",
    { name: "fixture setup" },
    undefined,
    {},
    201,
  );
  const agent = await request(
    "/v1/agent-connections",
    "post",
    { name: "fixture agent" },
    undefined,
    {},
    201,
  );
  await request("/v1/device-setup-tokens", "get");
  await request("/v1/agent-connections", "get");
  const manifest = {
    name: "software contract fixture • café",
    kind: "custom.fixture",
    capabilities: ["device.health"],
  };
  const identity = await request(
    "/v1/sdk/devices",
    "post",
    { requestId: crypto.randomUUID(), manifest },
    setup.token,
    {},
    201,
  );
  const ids = { deviceId: identity.deviceId };
  // New agent connections are delegated an all-devices operator policy: the
  // attached device is covered without any grant.
  const visible = await request("/v1/devices", "get", undefined, agent.token);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, identity.deviceId);
  // Switch the connection to explicit selected mode; the historical
  // grant-only assertions below keep their meaning.
  await request("/v1/access-policies", "post", {
    principal: agent.principal,
    mode: "selected",
    excludedDevices: [],
    excludedFunctions: [],
    role: "operator",
    expiresAt: agent.expiresAt,
  });
  assert.deepEqual(
    await request("/v1/devices", "get", undefined, agent.token),
    [],
  );
  await request("/v1/grants", "post", {
    principal: agent.principal,
    deviceId: identity.deviceId,
    capabilities: ["device.health"],
  });
  await request("/v1/grants", "get");
  await request("/v1/devices", "get", undefined, agent.token);
  await request("/v1/functions", "get", undefined, agent.token);
  const body = {
    capability: "device.health",
    arguments: {},
    idempotencyKey: "contract-health",
  };
  const queued = await request(
    "/v1/devices/{deviceId}/actions",
    "post",
    body,
    agent.token,
    ids,
    202,
  );
  const retry = await request(
    "/v1/devices/{deviceId}/actions",
    "post",
    body,
    agent.token,
    ids,
    202,
  );
  assert.equal(retry.id, queued.id);
  ids.actionId = queued.id;
  const dispatched = await request(
    "/v1/device/{deviceId}/next",
    "post",
    undefined,
    identity.token,
    ids,
  );
  assert.equal(dispatched.status, "received");
  await request(
    "/v1/actions/{actionId}/cancel",
    "post",
    undefined,
    agent.token,
    ids,
    409,
  );
  await request(
    "/v1/device/{deviceId}/result",
    "post",
    { actionId: queued.id, status: "succeeded", result: { simulated: true } },
    identity.token,
    ids,
  );
  const complete = await request(
    "/v1/actions/{actionId}",
    "get",
    undefined,
    agent.token,
    ids,
  );
  assert.equal(complete.status, "succeeded");
  await request("/v1/actions", "get");
  await request("/v1/actions/export", "get");
  assert.equal(
    await request(
      "/v1/device/{deviceId}/next",
      "post",
      undefined,
      identity.token,
      ids,
    ),
    null,
  );
  await request(
    "/v1/device/{deviceId}/manifest",
    "post",
    { manifest },
    identity.token,
    ids,
  );
  await request("/v1/grants/revoke", "post", {
    principal: agent.principal,
    deviceId: identity.deviceId,
  });
  assert.deepEqual(
    await request("/v1/functions", "get", undefined, agent.token),
    [],
  );
  await request(
    "/v1/devices/{deviceId}/revoke",
    "post",
    undefined,
    undefined,
    ids,
  );
});
