import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repo =
  process.env.OPENLAUNCH_REPO ??
  fileURLToPath(new URL("../../", import.meta.url));
const fromRepo = createRequire(resolve(repo, "package.json"));
const [{ Hub, emptyState, Fault }, { handle }, sdk, mcpClient, mcpTransport] =
  await Promise.all([
    import(pathToFileURL(resolve(repo, "packages/core/src/index.ts")).href),
    import(pathToFileURL(resolve(repo, "packages/http/src/index.ts")).href),
    import(pathToFileURL(resolve(repo, "packages/sdk/src/index.ts")).href),
    import(
      pathToFileURL(
        fromRepo.resolve("@modelcontextprotocol/sdk/client/index.js"),
      ).href
    ),
    import(
      pathToFileURL(
        fromRepo.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      ).href
    ),
  ]);

const { createClient, createDevice, OpenLaunchError } = sdk;
const { Client } = mcpClient;
const { StreamableHTTPClientTransport } = mcpTransport;
const workspace = "a".repeat(64);
const baseUrl = "http://127.0.0.1:8788";
const owner = { id: "owner-fixture", owner: true };
const driveArgs = { velocityMmS: 120, radiusMm: 0, durationMs: 500 };
const sketchDir = repo;
const roombaManifest = JSON.parse(
  execFileSync("sh", [resolve(sketchDir, "tests/host/roomba/manifest.sh")], {
    encoding: "utf8",
  }),
);

test("Roomba manifest, discovery, bounded actions, expiry and dispatch revocation cross HTTP + SDK", async () => {
  let now = 1_000_000;
  const hub = new Hub(emptyState(), () => now);
  const resolvePrincipal = async (request) => {
    if (request.headers.get("authorization") === "Bearer owner-fixture")
      return owner;
    throw new Fault("unauthorized", 401, "owner fixture required");
  };
  const apiFetch = async (input, init) =>
    handle(new Request(input, init), hub, resolvePrincipal, {
      workspace,
      deviceCredentials: {
        keyVersion: "fixture-key-v1",
        derive: async () => "b".repeat(64),
      },
    });
  const ownerApi = async (path, method, body) =>
    apiFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: "Bearer owner-fixture",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const connectionResponse = await ownerApi("/v1/agent-connections", "POST", {
    name: "roomba function integration",
    ttlSeconds: 3600,
    access: "act",
  });
  assert.equal(connectionResponse.status, 201);
  const connection = (await connectionResponse.json()).data;
  const setupTokenResponse = await ownerApi("/v1/sdk-tokens", "POST", {
    name: "roomba device setup",
    ttlSeconds: 3600,
    deviceLimit: 1,
  });
  assert.equal(setupTokenResponse.status, 201);
  const setupToken = (await setupTokenResponse.json()).data;
  const device = createDevice({
    url: baseUrl,
    workspace,
    token: setupToken.token,
    fetch: apiFetch,
  });
  const requestId = "12345678-1234-4234-8234-123456789abc";
  const enrolled = await device.attach(roombaManifest, requestId);
  const newAgent = createClient({
    url: baseUrl,
    token: connection.token,
    workspace,
    fetch: apiFetch,
  });
  assert(
    (await newAgent.listFunctions()).some(
      (entry) => entry.definition.name === "roomba.stop",
    ),
    "New agent connections include advertised Roomba functions without individual grants",
  );
  // Keep the remainder of this test's explicit-grant, expiry and revocation contract.
  const selectedPolicy = await ownerApi("/v1/access-policies", "POST", {
    principal: connection.principal,
    mode: "selected",
    role: "operator",
    excludedDevices: [],
    excludedFunctions: [],
    expiresAt: null,
  });
  assert.equal(selectedPolicy.status, 200);
  const grantResponse = await ownerApi("/v1/grants", "POST", {
    principal: connection.principal,
    deviceId: enrolled.deviceId,
    capabilities: ["roomba.drive"],
    ttlSeconds: 60,
  });
  assert.equal(grantResponse.status, 200);

  const agent = createClient({
    url: baseUrl,
    token: connection.token,
    workspace,
    fetch: apiFetch,
  });
  const deviceList = await agent.listDevices();
  assert.equal(deviceList.length, 1);
  assert.equal(deviceList[0].id, enrolled.deviceId);

  const toolClient = new Client({ name: "roomba-http-test", version: "1" });
  const toolTransport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${connection.token}`,
          "x-openlaunch-workspace": workspace,
        },
      },
      fetch: apiFetch,
    },
  );
  await toolClient.connect(toolTransport);
  try {
    const { tools } = await toolClient.listTools();
    const driveTool = tools.find((tool) =>
      tool.description.includes("roomba.drive"),
    );
    assert(driveTool, "granted Roomba drive function should be discoverable");
    assert.equal(
      tools.some((tool) => tool.description.includes("roomba.stop")),
      false,
      "ungranted stop function should not be discoverable",
    );

    const toolResult = await toolClient.callTool({
      name: driveTool.name,
      arguments: {
        arguments: driveArgs,
        idempotencyKey: "roomba-drive-api-1",
      },
    });
    assert.notEqual(toolResult.isError, true);
    const queued = toolResult.structuredContent.data;
    assert.equal(queued.capability, "roomba.drive");
    assert.equal(queued.status, "queued");

    const duplicate = await agent.requestAction(enrolled.deviceId, {
      capability: "roomba.drive",
      arguments: driveArgs,
      idempotencyKey: "roomba-drive-api-1",
    });
    assert.equal(duplicate.id, queued.id);
    await assert.rejects(
      agent.requestAction(enrolled.deviceId, {
        capability: "roomba.drive",
        arguments: { ...driveArgs, velocityMmS: 130 },
        idempotencyKey: "roomba-drive-api-1",
      }),
      (error) => error instanceof OpenLaunchError && error.code === "conflict",
    );
    await assert.rejects(
      agent.requestAction(enrolled.deviceId, {
        capability: "roomba.drive",
        arguments: { ...driveArgs, durationMs: 1001 },
        idempotencyKey: "roomba-drive-api-invalid",
      }),
      (error) => error instanceof OpenLaunchError && error.status === 400,
    );
    await assert.rejects(
      agent.requestAction(enrolled.deviceId, {
        capability: "roomba.stop",
        arguments: {},
        idempotencyKey: "roomba-stop-ungranted",
      }),
      (error) => error instanceof OpenLaunchError && error.code === "forbidden",
    );

    const received = await device.nextAction();
    assert.equal(received.id, queued.id);
    assert.equal(received.args.radiusMm, 0);
    const result = await device.submitResult(received.id, {
      status: "succeeded",
      result: {
        accepted: true,
        physicalVerified: false,
        transport: "serial_command_sent",
      },
    });
    assert.deepEqual(result.result, {
      accepted: true,
      physicalVerified: false,
      transport: "serial_command_sent",
    });

    const expiring = await agent.requestAction(enrolled.deviceId, {
      capability: "roomba.drive",
      arguments: driveArgs,
      idempotencyKey: "roomba-drive-expiry",
      ttlSeconds: 1,
    });
    now += 1001;
    assert.equal((await agent.getAction(expiring.id)).status, "expired");

    const queuedBeforeRevoke = await agent.requestAction(enrolled.deviceId, {
      capability: "roomba.drive",
      arguments: { ...driveArgs, radiusMm: 500 },
      idempotencyKey: "roomba-drive-revoke-before-dispatch",
    });
    const revoked = await ownerApi("/v1/grants/revoke", "POST", {
      principal: connection.principal,
      deviceId: enrolled.deviceId,
    });
    assert.equal(revoked.status, 200);
    assert.equal(await device.nextAction(), null);
    assert.equal(
      hub.state.actions.find((action) => action.id === queuedBeforeRevoke.id)
        .status,
      "cancelled",
    );
    await assert.rejects(
      agent.requestAction(enrolled.deviceId, {
        capability: "roomba.drive",
        arguments: driveArgs,
        idempotencyKey: "roomba-drive-after-revoke",
      }),
      (error) => error instanceof OpenLaunchError && error.code === "forbidden",
    );
  } finally {
    await toolClient.close();
  }
});
