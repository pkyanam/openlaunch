import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../packages/core/src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcp, functionToolName } from "../packages/mcp/src/index.ts";
import { functionGuide } from "../packages/core/src/function-guides.ts";

const owner = { id: "owner", owner: true };
const agent = { id: "guide-agent", owner: false };
const clean = {
  name: "roomba.clean",
  title: "Clean",
  description: "Board description for cleaning.",
  access: "write",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", maxLength: 8, enum: ["standard", "spot", "max"] },
    },
    required: ["mode"],
    additionalProperties: false,
  },
};

test("Linux inventory guide documents optional thermal data only for its exact read schema", () => {
  const info = {
    name: "system.info",
    title: "Inspect Linux system",
    description: "Host inventory",
    access: "read",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
  assert.match(functionGuide("linux", info), /temperatureC/);
  assert.match(
    functionGuide("linux", info),
    /no separate temperature capability/,
  );
  assert.doesNotMatch(functionGuide("uno-r4-wifi", info), /temperatureC/);
  assert.doesNotMatch(
    functionGuide("linux", { ...info, access: "write" }),
    /temperatureC/,
  );
  assert.doesNotMatch(
    functionGuide("linux", {
      ...info,
      inputSchema: {
        ...info.inputSchema,
        properties: { other: { type: "boolean" } },
      },
    }),
    /temperatureC/,
  );
});

test("hosted Roomba guides match only the verified kind, name, access and full schema", () => {
  const guide = functionGuide("uno-r4-wifi", clean);
  assert.match(guide, /general cleaning request/);
  assert.match(guide, /succeeded result confirms serial transmission only/);
  assert.match(guide, /serial-only builds need no D6\/D7 contacts/);
  assert.match(guide, /contact-enabled builds require their local switches/);
  assert.match(guide, /Call only on an explicit owner request/);
  assert.match(guide, /\{"mode":"spot"\}/);
  assert.doesNotMatch(
    functionGuide("raspberry-pi-4", clean),
    /built-in routine/,
  );
  assert.doesNotMatch(
    functionGuide("uno-r4-wifi", { ...clean, access: "read" }),
    /built-in routine/,
  );
  assert.doesNotMatch(
    functionGuide("uno-r4-wifi", {
      ...clean,
      inputSchema: {
        ...clean.inputSchema,
        properties: {
          mode: {
            ...clean.inputSchema.properties.mode,
            enum: ["standard", "spot"],
          },
        },
      },
    }),
    /built-in routine/,
  );
  assert.doesNotMatch(
    functionGuide("uno-r4-wifi", { ...clean, name: "vendor.clean" }),
    /built-in routine/,
  );
});

test("MCP keeps declared tool identity and argument schema while adding a hosted guide", async () => {
  const hub = new Hub();
  const enrollment = await hub.enrollment(owner, "uno-r4-wifi");
  const device = await hub.enroll(enrollment.token, {
    name: "hall Roomba",
    kind: "uno-r4-wifi",
    capabilities: [clean.name],
    functions: [clean],
  });
  hub.grant(owner, agent.id, device.deviceId, [clean.name]);
  const server = createMcp(hub, agent);
  const client = new Client({ name: "function-guide-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(
      (item) => item.name === functionToolName(device.deviceId, clean.name),
    );
    assert(tool);
    assert.equal(tool.title, "Clean — hall Roomba");
    assert.match(tool.description, /Board description for cleaning\./);
    assert.match(tool.description, /Function guide:/);
    assert.match(tool.description, /standard clean/);
    assert.deepEqual(
      tool.inputSchema.properties.arguments.properties.mode.allOf,
      [
        { type: "string", minLength: 0, maxLength: 8 },
        { enum: ["standard", "spot", "max"], type: "string" },
      ],
    );
    const queued = await client.callTool({
      name: tool.name,
      arguments: {
        arguments: { mode: "spot" },
        idempotencyKey: "guide-clean-1",
      },
    });
    assert.equal(queued.structuredContent.data.status, "queued");
  } finally {
    await client.close();
    await server.close();
  }
});

test("unknown custom functions retain board documentation and receive schema-only guidance", async () => {
  const hub = new Hub();
  const definition = {
    name: "vendor.clean",
    title: "Vendor clean",
    description: "Custom board-specific behavior.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: { cycles: { type: "integer", minimum: 1, maximum: 3 } },
      required: ["cycles"],
      additionalProperties: false,
    },
  };
  const enrollment = await hub.enrollment(owner, "uno-r4-wifi");
  const device = await hub.enroll(enrollment.token, {
    name: "custom device",
    kind: "uno-r4-wifi",
    capabilities: [definition.name],
    functions: [definition],
  });
  hub.grant(owner, agent.id, device.deviceId, [definition.name]);
  const server = createMcp(hub, agent);
  const client = new Client({ name: "custom-function-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(
      (item) =>
        item.name === functionToolName(device.deviceId, definition.name),
    );
    assert(tool);
    assert.match(tool.description, /Custom board-specific behavior\./);
    assert.match(tool.description, /Function guide:/);
    assert.match(tool.description, /cycles \(required; integer; 1–3\)/);
    assert.match(tool.description, /idempotencyKey/);
    assert.doesNotMatch(tool.description, /begins cleaning/);
    assert.equal(
      tool.inputSchema.properties.arguments.properties.cycles.maximum,
      3,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
