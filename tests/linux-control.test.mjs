import test from "node:test";
import assert from "node:assert/strict";
import { Hub, manifestSchema } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import { createToolCatalog, runTool } from "../packages/mcp/src/index.ts";
import {
  workspaceStorageCharge,
  PENDING_RESULT_RESERVE_BYTES,
} from "../packages/core/src/storage-budget.ts";
import { DESKTOP_RESULT_BYTES } from "../packages/core/src/limits.ts";
import { buildOpenApi } from "../packages/http/src/contracts.ts";
import Ajv2020 from "ajv/dist/2020.js";
const owner = { id: "owner", owner: true },
  agent = { id: "agent", owner: false };
const emptySchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const defs = [
  ["desktop.screenshot", "read"],
  ["desktop.input", "write"],
  ["system.exec", "write"],
  ...Array.from({ length: 17 }, (_, i) => [`fixture.f${i}`, "read"]),
].map(([name, access]) => ({
  name,
  access,
  title: "Fixture function",
  description: "Software contract fixture",
  inputSchema: emptySchema,
}));
const manifest = {
  name: "Linux control fixture",
  kind: "linux",
  capabilities: defs.map((f) => f.name),
  functions: defs,
};
async function fixture(kind = "linux") {
  const hub = new Hub();
  const m =
    kind === "linux"
      ? manifest
      : {
          ...manifest,
          kind,
          capabilities: defs.slice(0, 3).map((f) => f.name),
          functions: defs.slice(0, 3),
        };
  const enrollment = await hub.enrollment(owner, kind),
    device = await hub.enroll(enrollment.token, m);
  return { hub, device };
}
const resolver = async () => agent;
const api = (hub, path, data, token) =>
  handle(
    new Request("https://bridge.example" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    }),
    hub,
    resolver,
  );

test("Linux larger function catalog agrees with grants and OpenAPI; MCU ceiling stays 16", async () => {
  assert(manifestSchema.safeParse(manifest).success);
  assert(
    !manifestSchema.safeParse({ ...manifest, kind: "uno-r4-wifi" }).success,
  );
  const validate = new Ajv2020({ strict: false }).compile(
    buildOpenApi().components.schemas.Manifest,
  );
  assert(validate(manifest), JSON.stringify(validate.errors));
  assert(!validate({ ...manifest, kind: "uno-r4-wifi" }));
  const { hub, device } = await fixture();
  hub.grant(owner, agent.id, device.deviceId, manifest.capabilities);
  assert.equal(hub.functions(agent).length, 20);
  assert.throws(() =>
    hub.request(
      { ...agent, readOnly: true },
      device.deviceId,
      "desktop.input",
      {},
      "deny",
    ),
  );
  assert.throws(() =>
    hub.request(
      { ...agent, readOnly: true },
      device.deviceId,
      "system.exec",
      {},
      "deny-shell",
    ),
  );
  assert.equal(
    hub.request(
      { ...agent, readOnly: true },
      device.deviceId,
      "desktop.screenshot",
      {},
      "read",
    ).status,
    "queued",
  );
  hub.revokeGrant(owner, agent.id, device.deviceId);
  assert.equal(hub.functions(agent).length, 0);
});

test("Large authenticated Linux screenshots become native MCP images without base64 text; retry is idempotent", async () => {
  const { hub, device } = await fixture();
  hub.grant(owner, agent.id, device.deviceId, manifest.capabilities);
  const queued = hub.request(
    agent,
    device.deviceId,
    "desktop.screenshot",
    {},
    "capture",
  );
  hub.next(device.deviceId);
  const charge = workspaceStorageCharge(hub.state);
  const result = {
    mimeType: "image/jpeg",
    imageBase64: Buffer.concat([
      Buffer.from([255, 216, 255]),
      Buffer.alloc(32765, 3),
    ]).toString("base64"),
    width: 1024,
    height: 768,
    screenWidth: 1920,
    screenHeight: 1080,
  };
  const body = { actionId: queued.id, status: "succeeded", result };
  assert.equal(
    (await api(hub, `/v1/device/${device.deviceId}/result`, body, "bad-token"))
      .status,
    401,
  );
  const response = await api(
    hub,
    `/v1/device/${device.deviceId}/result`,
    body,
    device.token,
  );
  assert.equal(response.status, 200);
  assert(
    workspaceStorageCharge(hub.state) <= charge,
    "reserved image admission must drain",
  );
  assert.equal(
    (await api(hub, `/v1/device/${device.deviceId}/result`, body, device.token))
      .status,
    200,
  );
  const receipt = JSON.stringify(hub.get(agent, queued.id));
  assert(receipt.includes(result.imageBase64));
  const tool = createToolCatalog(hub, agent).find(
    (t) => t.name === "get_action",
  );
  const reply = runTool(tool.fn, { actionId: queued.id });
  assert.equal(reply.content[1].type, "image");
  assert.equal(reply.content[1].mimeType, "image/jpeg");
  assert.equal(reply.content[1].data, result.imageBase64);
  assert(!reply.content[0].text.includes(result.imageBase64));
  assert.equal(reply.structuredContent.data.result.imageReturned, true);
  const request = hub.request(
    agent,
    device.deviceId,
    "desktop.screenshot",
    {},
    "pending",
  );
  const pending = runTool(tool.fn, { actionId: request.id });
  assert.equal(pending.content.length, 1);
  hub.cancel(agent, request.id);
  const large = hub.request(
    agent,
    device.deviceId,
    "desktop.screenshot",
    {},
    "oversize",
  );
  hub.next(device.deviceId);
  assert.equal(
    (
      await api(
        hub,
        `/v1/device/${device.deviceId}/result`,
        {
          actionId: large.id,
          status: "succeeded",
          result: { imageBase64: "A".repeat(DESKTOP_RESULT_BYTES) },
        },
        device.token,
      )
    ).status,
    413,
  );
});

test("Image allowance is capability and device-kind specific, with a larger pending reserve only for Linux screenshots", async () => {
  for (const kind of ["linux", "uno-r4-wifi"]) {
    const { hub, device } = await fixture(kind);
    hub.grant(
      owner,
      agent.id,
      device.deviceId,
      hub.state.devices[0].capabilities,
    );
    const action = hub.request(
      agent,
      device.deviceId,
      kind === "linux" ? "system.exec" : "desktop.screenshot",
      {},
      "large",
    );
    hub.next(device.deviceId);
    assert.equal(
      (
        await api(
          hub,
          `/v1/device/${device.deviceId}/result`,
          {
            actionId: action.id,
            status: "succeeded",
            result: { text: "A".repeat(5000) },
          },
          device.token,
        )
      ).status,
      413,
    );
  }
  const { hub, device } = await fixture();
  const before = workspaceStorageCharge(hub.state);
  const a = hub.request(
    owner,
    device.deviceId,
    "desktop.screenshot",
    {},
    "reserve",
  );
  const withImage = workspaceStorageCharge(hub.state);
  a.capability = "system.exec";
  const normal = workspaceStorageCharge(hub.state);
  // Difference includes just the name's encoded length and image reserve.
  assert.equal(
    withImage - normal,
    DESKTOP_RESULT_BYTES -
      PENDING_RESULT_RESERVE_BYTES +
      "desktop.screenshot".length -
      "system.exec".length,
  );
  assert(withImage > before);
});

test("Console screenshot preview accepts only bounded final JPEG data sources", async () => {
  const { screenshotSource } = await import("../apps/web/src/receipt.ts");
  const receipt = {
    capability: "desktop.screenshot",
    status: "succeeded",
    result: { mimeType: "image/jpeg", imageBase64: "/9j/AA==" },
  };
  assert.equal(screenshotSource(receipt), "data:image/jpeg;base64,/9j/AA==");
  for (const changed of [
    { ...receipt, status: "queued" },
    { ...receipt, capability: "system.exec" },
    { ...receipt, result: { mimeType: "text/html", imageBase64: "/9j/AA==" } },
    {
      ...receipt,
      result: { mimeType: "image/jpeg", imageBase64: "javascript:alert(1)" },
    },
    {
      ...receipt,
      result: { mimeType: "image/jpeg", imageBase64: "A".repeat(50000) },
    },
  ])
    assert.equal(screenshotSource(changed), undefined);
});
