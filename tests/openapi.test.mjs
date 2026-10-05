import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { buildOpenApi } from "../packages/http/src/contracts.ts";
import {
  actionRequestSchema,
  attachRequestSchema,
  createAgentConnectionSchema,
  createSetupTokenSchema,
  grantRequestSchema,
  resultRequestSchema,
} from "../packages/http/src/contracts.ts";

test("OpenAPI contract covers hosted, owner, agent, setup, device and MCP routes", () => {
  const doc = buildOpenApi();
  assert.equal(doc.openapi, "3.1.0");
  const operationIds = Object.values(doc.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  assert.equal(new Set(operationIds).size, operationIds.length);
  for (const [path, methods] of Object.entries(doc.paths)) {
    const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1],
    );
    for (const operation of Object.values(methods)) {
      const actual = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name);
      assert.deepEqual(
        actual.sort(),
        expected.sort(),
        `path parameters for ${path}`,
      );
    }
  }
  for (const [path, method] of [
    ["/healthz", "get"],
    ["/v1/account", "get"],
    ["/v1/devices", "get"],
    ["/v1/actions", "get"],
    ["/v1/actions/export", "get"],
    ["/v1/actions/{actionId}", "get"],
    ["/v1/actions/{actionId}/cancel", "post"],
    ["/v1/functions", "get"],
    ["/v1/agent-connections", "get"],
    ["/v1/agent-connections", "post"],
    ["/v1/agent-connections/{connectionId}/revoke", "post"],
    ["/v1/device-setup-tokens", "get"],
    ["/v1/sdk-tokens", "post"],
    ["/v1/device-setup-tokens/{connectionId}/revoke", "post"],
    ["/v1/sdk-tokens/{connectionId}/revoke", "post"],
    ["/v1/oauth-clients", "get"],
    ["/v1/oauth-clients", "post"],
    ["/v1/oauth-clients/{clientId}/revoke", "post"],
    ["/v1/grants", "get"],
    ["/v1/grants", "post"],
    ["/v1/grants/revoke", "post"],
    ["/v1/enrollments", "post"],
    ["/v1/device/enroll", "post"],
    ["/v1/sdk/devices", "post"],
    ["/v1/broadcasts", "post"],
    ["/v1/devices/{deviceId}/actions", "post"],
    ["/v1/device/{deviceId}/manifest", "post"],
    ["/v1/device/{deviceId}/next", "post"],
    ["/v1/device/{deviceId}/result", "post"],
    ["/v1/device/{deviceId}/events-ticket", "post"],
    ["/v1/device/{deviceId}/events", "get"],
    ["/mcp", "post"],
    ["/.well-known/oauth-protected-resource", "get"],
    ["/.well-known/oauth-protected-resource/mcp", "get"],
  ])
    assert.ok(doc.paths[path]?.[method], `${method.toUpperCase()} ${path}`);
  assert.ok(doc.paths["/v1/device/{deviceId}/events"].get.responses["101"]);
  assert.equal(doc.servers[0].url, "https://www.openlaunch.dev");
  assert.ok(
    doc.paths["/v1/device/{deviceId}/result"].post.parameters.some(
      (parameter) => parameter.name === "x-openlaunch-workspace",
    ),
  );
  assert.equal(
    doc.paths["/v1/device/{deviceId}/events"].get.parameters.find(
      (parameter) => parameter.name === "workspace",
    ).required,
    true,
  );
  assert.match(
    doc.paths["/v1/device/{deviceId}/events"].get.description,
    /cannot establish/,
  );
  assert.match(
    doc.paths["/v1/sdk/devices"].post.description,
    /no function grants/,
  );
  assert.equal(
    doc.paths["/v1/sdk-tokens"].post.requestBody.content["application/json"]
      .schema.properties.ttlSeconds.default,
    600,
  );
  assert.deepEqual(
    doc.paths["/v1/sdk/devices"].post.requestBody.content["application/json"]
      .schema.properties.manifest,
    { $ref: "#/components/schemas/Manifest" },
  );
  assert.equal(doc.components.schemas.DeviceNext.anyOf[1].type, "null");
  assert.equal(
    doc.components.schemas.NewConnection.properties.token.type,
    "string",
  );
  assert.equal(
    doc.components.schemas.Account.properties.oauthClientRegistration.type,
    "boolean",
  );
  assert.equal(
    doc.components.schemas.BroadcastResult.properties.deviceId.format,
    "uuid",
  );
  assert.equal(
    doc.paths["/v1/devices/{deviceId}/actions"].post["x-codeSamples"].length,
    2,
  );
  assert.ok(
    doc.paths["/v1/actions/{actionId}"].get["x-codeSamples"].some((sample) =>
      sample.source.includes("ol actions watch"),
    ),
  );
  assert.ok(
    !JSON.stringify(doc).match(
      /(?:ol_(?:agent|sdk)_[a-f0-9]{64}_[a-f0-9]{64}|clientSecret.{0,20}[a-z0-9]{24,})/i,
    ),
  );
});

test("contract generation is deterministic and request schema exports preserve handler behavior", () => {
  assert.equal(JSON.stringify(buildOpenApi()), JSON.stringify(buildOpenApi()));
  assert.deepEqual(createAgentConnectionSchema.parse({ name: "a" }), {
    name: "a",
    ttlSeconds: 86400,
    access: "act",
  });
  assert.deepEqual(createSetupTokenSchema.parse({ name: "a" }), {
    name: "a",
    ttlSeconds: 600,
    deviceLimit: 1,
  });
  assert.deepEqual(
    grantRequestSchema.parse({
      principal: "p",
      deviceId: "00000000-0000-4000-8000-000000000001",
      capabilities: ["device.health"],
    }),
    {
      principal: "p",
      deviceId: "00000000-0000-4000-8000-000000000001",
      capabilities: ["device.health"],
      ttlSeconds: 3600,
    },
  );
  assert.equal(
    actionRequestSchema.safeParse({
      capability: "device.health",
      arguments: {},
      idempotencyKey: "x",
      unexpected: 1,
    }).success,
    false,
  );
  assert.equal(
    attachRequestSchema.safeParse({ requestId: "bad", manifest: {} }).success,
    false,
  );
  assert.equal(
    resultRequestSchema.safeParse({
      actionId: "00000000-0000-4000-8000-000000000001",
      status: "unknown",
      result: {},
    }).success,
    false,
  );
});

test("published manifest schema carries real function parameter bounds", () => {
  const doc = buildOpenApi();
  const validate = new Ajv2020({ strict: false }).compile(
    doc.components.schemas.Manifest,
  );
  const manifest = {
    name: "board",
    kind: "custom.board",
    capabilities: ["custom.echo"],
    functions: [
      {
        name: "custom.echo",
        title: "Echo",
        description: "Echo text",
        access: "read",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 12 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
  };
  assert.equal(validate(manifest), true);
  assert.equal(
    validate({
      ...manifest,
      functions: [
        {
          ...manifest.functions[0],
          inputSchema: {
            ...manifest.functions[0].inputSchema,
            properties: { text: { type: "string", maxLength: 1025 } },
          },
        },
      ],
    }),
    false,
  );
  const functionSchema =
    doc.components.schemas.Manifest.properties.functions.items;
  assert.equal(
    functionSchema.properties.inputSchema.properties.additionalProperties.const,
    false,
  );
  assert.equal(
    functionSchema.properties.inputSchema.properties.properties
      .additionalProperties.oneOf.length,
    3,
  );
});
