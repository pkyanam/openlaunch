import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../packages/sdk/src/index.ts";

test("createAdapter derives capabilities, schemas and handlers from one declaration", async () => {
  const inputSchema = {
    type: "object",
    properties: { text: { type: "string", maxLength: 32 } },
    required: ["text"],
    additionalProperties: false,
  };
  const handler = async ({ text }) => ({ text });
  const adapter = createAdapter({
    name: "Echo adapter",
    kind: "custom.echo",
    tools: {
      "custom.echo": {
        title: "Echo text",
        description: "Return the provided text.",
        access: "read",
        inputSchema,
        handler,
      },
    },
  });
  assert.deepEqual(adapter.manifest.capabilities, ["custom.echo"]);
  assert.deepEqual(adapter.manifest.functions, [
    {
      name: "custom.echo",
      title: "Echo text",
      description: "Return the provided text.",
      access: "read",
      inputSchema,
    },
  ]);
  assert.deepEqual(Object.keys(adapter.handlers), ["custom.echo"]);
  assert.equal(adapter.handlers["custom.echo"], handler);
  assert.deepEqual(await adapter.handlers["custom.echo"]({ text: "hi" }), { text: "hi" });
});

test("createAdapter requires explicit schemas and handlers instead of guessing operations", () => {
  const base = {
    name: "test",
    kind: "custom.test",
    tools: {
      "custom.test.run": {
        title: "Run",
        description: "Run an operation.",
        access: "write",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        handler: () => ({ ok: true }),
      },
    },
  };
  assert.throws(
    () => createAdapter({ ...base, tools: { "custom.test.run": { ...base.tools["custom.test.run"], inputSchema: undefined } } }),
    /explicit closed object input schema/,
  );
  assert.throws(
    () => createAdapter({ ...base, tools: { "custom.test.run": { ...base.tools["custom.test.run"], handler: undefined } } }),
    /requires a handler/,
  );
});
