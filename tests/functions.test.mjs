import test from "node:test";
import assert from "node:assert/strict";
import { Hub, manifestSchema } from "../packages/core/src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcp, functionToolName } from "../packages/mcp/src/index.ts";
const owner = { id: "owner", owner: true },
  agent = { id: "agent", owner: false };
const definition = {
  name: "light.brightness",
  title: "Set brightness",
  description: "Set this lamp's brightness from 0 to 100.",
  access: "write",
  inputSchema: {
    type: "object",
    properties: { value: { type: "integer", minimum: 0, maximum: 100 } },
    required: ["value"],
    additionalProperties: false,
  },
};
const manifest = {
  name: "desk lamp",
  kind: "raspberry-pi-4",
  capabilities: ["device.health", definition.name],
  functions: [definition],
};
async function fixture() {
  const hub = new Hub();
  const enrollment = await hub.enrollment(owner, manifest.kind);
  const device = await hub.enroll(enrollment.token, manifest);
  return { hub, device };
}
test("custom function schemas enforce bounds, grants, scope and revocation", async () => {
  const { hub, device } = await fixture();
  assert.equal(hub.functions(agent).length, 0);
  assert.throws(() =>
    hub.request(agent, device.deviceId, definition.name, { value: 50 }, "a"),
  );
  hub.grant(owner, agent.id, device.deviceId, [definition.name]);
  assert.equal(hub.functions(agent).length, 1);
  assert.throws(() =>
    hub.request(agent, device.deviceId, definition.name, { value: 101 }, "a"),
  );
  assert.throws(() =>
    hub.request(
      agent,
      device.deviceId,
      definition.name,
      { value: 50, extra: true },
      "a",
    ),
  );
  assert.throws(() =>
    hub.request(
      { ...agent, readOnly: true },
      device.deviceId,
      definition.name,
      { value: 50 },
      "a",
    ),
  );
  assert.equal(
    hub.request(agent, device.deviceId, definition.name, { value: 50 }, "a")
      .status,
    "queued",
  );
  hub.revokeGrant(owner, agent.id, device.deviceId);
  assert.equal(hub.functions(agent).length, 0);
});
test("manifests reject unknown functions, built-in overrides, external schemas and duplicates", () => {
  assert.equal(
    manifestSchema.safeParse({ ...manifest, functions: [] }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      functions: [{ ...definition, name: "device.health" }],
    }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      functions: [
        { ...definition, inputSchema: { $ref: "https://example.com/schema" } },
      ],
    }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      functions: [definition, definition],
    }).success,
    false,
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      capabilities: [definition.name, definition.name],
    }).success,
    false,
  );
});
test("MCP discovers granted custom tools and validates their arguments through the command service", async () => {
  const { hub, device } = await fixture();
  hub.grant(owner, agent.id, device.deviceId, [definition.name]);
  const server = createMcp(hub, agent);
  const client = new Client({ name: "function-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((tool) => tool.name.startsWith("device_"));
    assert(tool);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.title, "Set brightness — desk lamp");
    assert.match(tool.description, /Set this lamp/);
    const result = await client.callTool({
      name: tool.name,
      arguments: { arguments: { value: 35 }, idempotencyKey: "mcp-custom" },
    });
    assert.equal(result.structuredContent.data.status, "queued");
    hub.revokeGrant(owner, agent.id, device.deviceId);
    const denied = await client.callTool({
      name: tool.name,
      arguments: { arguments: { value: 40 }, idempotencyKey: "mcp-revoked" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("broadcasts check each device grant and retain independent idempotent outcomes", async () => {
  const { hub, device } = await fixture();
  const enrollment = await hub.enrollment(owner, manifest.kind);
  const other = await hub.enroll(enrollment.token, {
    ...manifest,
    name: "other lamp",
  });
  hub.grant(owner, agent.id, device.deviceId, [definition.name]);
  const ids = [device.deviceId, other.deviceId];
  const results = hub.broadcast(
    agent,
    ids,
    definition.name,
    { value: 20 },
    "broadcast",
  );
  assert.equal(results[0].action.status, "queued");
  assert.equal(results[1].error.code, "forbidden");
  const retry = hub.broadcast(
    agent,
    ids,
    definition.name,
    { value: 20 },
    "broadcast",
  );
  assert.equal(retry[0].action.id, results[0].action.id);
  assert.equal(hub.state.actions.length, 1);
  assert.throws(() =>
    hub.broadcast(
      agent,
      [device.deviceId, device.deviceId],
      definition.name,
      { value: 20 },
      "duplicate",
    ),
  );
});

test("custom MCP tool names are bounded and independent of discovery order", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const first = "custom.identical_prefix.first";
  const second = "custom.identical_prefix.second";
  const names = [first, second].map((capability) =>
    functionToolName(id, capability),
  );
  assert.notEqual(names[0], names[1]);
  for (const name of names) {
    assert(name.length <= 64);
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
  }
  assert.deepEqual(
    [second, first].map((capability) => functionToolName(id, capability)),
    names.toReversed(),
  );
});

test("function publication rejects contradictory choices and impossible integer ranges", () => {
  const withProperty = (property) => ({
    ...manifest,
    functions: [
      {
        ...definition,
        inputSchema: {
          ...definition.inputSchema,
          properties: { value: property },
        },
      },
    ],
  });
  for (const property of [
    { type: "string", maxLength: 2, enum: ["long"] },
    { type: "string", minLength: 1, maxLength: 2, enum: [""] },
    { type: "string", maxLength: 2, enum: ["a", "a"] },
    { type: "integer", minimum: 0.1, maximum: 0.2 },
    {
      type: "integer",
      minimum: Number.MAX_SAFE_INTEGER + 1,
      maximum: Number.MAX_SAFE_INTEGER + 2,
    },
  ])
    assert.equal(
      manifestSchema.safeParse(withProperty(property)).success,
      false,
    );
  assert.equal(
    manifestSchema.safeParse(
      withProperty({ type: "integer", minimum: 0.1, maximum: 1.2 }),
    ).success,
    true,
  );
  assert.equal(
    manifestSchema.safeParse(
      withProperty({ type: "string", maxLength: 2, enum: ["", "ok"] }),
    ).success,
    true,
  );
});

test("runtime enforces enum bounds even for an older persisted definition", async () => {
  const { functionArguments } =
    await import("../packages/core/src/functions.ts");
  const older = {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        value: { type: "string", maxLength: 2, enum: ["ok", "long"] },
      },
    },
  };
  assert.deepEqual(functionArguments(older, { value: "ok" }), { value: "ok" });
  assert.throws(() => functionArguments(older, { value: "long" }));
  assert.throws(() => functionArguments(older, { value: "no" }));
  assert.throws(() => functionArguments(older, { value: "ok", extra: true }));
});
