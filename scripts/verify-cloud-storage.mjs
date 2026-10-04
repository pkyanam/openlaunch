import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Miniflare } from "miniflare";

// Exercise the built Durable Object in workerd with disposable local storage.
// Trusted principals model the edge-to-object boundary; Clerk auth has separate tests.
const directory = mkdtempSync(join(tmpdir(), "openlaunch-cloud-storage-"));
chmodSync(directory, 0o700);
const workspace = "a".repeat(64);
const owner = { id: "storage-owner", owner: true };
const keys = JSON.stringify({ v1: randomBytes(32).toString("hex") });
const bundle = resolve(
  "apps/cloud/.cloudflare/output/v0/workers/default/bundle/index.js",
);
const built = JSON.parse(
  readFileSync(
    resolve(
      "apps/cloud/.cloudflare/output/v0/workers/default/worker.config.json",
    ),
    "utf8",
  ),
);
const name = "openlaunch-storage-acceptance";
const options = {
  resourcePersistencePath: join(directory, "resources"),
  isolatedResourcePersistencePath: join(directory, "isolated"),
  telemetry: { enabled: false },
  workers: [
    {
      config: {
        name,
        compatibilityDate: built.compatibilityDate,
        ...(built.compatibilityFlags
          ? { compatibilityFlags: built.compatibilityFlags }
          : {}),
        exports: built.exports,
        manifest: {
          mainModule: "index.js",
          modulesRoot: dirname(bundle),
          modules: {
            "index.js": { type: "esm", contents: readFileSync(bundle, "utf8") },
          },
        },
        env: {
          HUBS: {
            type: "durable-object",
            worker: name,
            exportName: "WorkspaceHub",
          },
          DEVICE_CREDENTIAL_KEYS: { type: "text", value: keys },
          DEVICE_CREDENTIAL_KEY_VERSION: { type: "text", value: "v1" },
        },
      },
    },
  ],
};
let worker;
async function object() {
  worker = new Miniflare(options);
  const namespace = await worker.getDurableObjectNamespace("HUBS");
  return namespace.get(namespace.idFromName(workspace));
}
async function api(stub, path, method = "GET", body, credential) {
  const response = await stub.fetch(`https://www.openlaunch.dev${path}`, {
    method,
    headers: {
      "x-openlaunch-workspace": workspace,
      "x-openlaunch-principal": JSON.stringify(owner),
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status >= 200 && response.status < 300,
    true,
    `${path}: HTTP ${response.status}`,
  );
  return (await response.json()).data;
}
try {
  let stub = await object();
  const connection = await api(stub, "/v1/sdk-tokens", "POST", {
    name: "storage fixture",
    ttlSeconds: 3600,
    access: "act",
    canAttach: true,
    deviceLimit: 1,
  });
  const request = {
    requestId: crypto.randomUUID(),
    manifest: {
      name: "storage fixture",
      kind: "custom.device",
      capabilities: ["device.health"],
    },
  };
  const paired = await api(
    stub,
    "/v1/sdk/devices",
    "POST",
    request,
    connection.token,
  );
  assert.deepEqual(
    await api(stub, "/v1/sdk/devices", "POST", request, connection.token),
    paired,
  );
  await api(stub, "/v1/grants", "POST", {
    principal: connection.principal,
    deviceId: paired.deviceId,
    capabilities: ["device.health"],
    ttlSeconds: 3600,
  });
  const actionRequest = {
    capability: "device.health",
    arguments: {},
    ttlSeconds: 60,
    idempotencyKey: "survives-restart",
  };
  const action = await api(
    stub,
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    actionRequest,
    connection.token,
  );
  assert.equal(action.status, "queued");
  await worker.dispose();
  worker = undefined;
  stub = await object();
  assert.equal(
    (
      await api(
        stub,
        `/v1/devices/${paired.deviceId}/actions`,
        "POST",
        actionRequest,
        connection.token,
      )
    ).id,
    action.id,
  );
  assert.equal(
    (
      await api(
        stub,
        `/v1/device/${paired.deviceId}/next`,
        "POST",
        {},
        paired.token,
      )
    ).id,
    action.id,
  );
  const result = await api(
    stub,
    `/v1/device/${paired.deviceId}/result`,
    "POST",
    {
      actionId: action.id,
      status: "succeeded",
      result: { softwareFixture: true },
    },
    paired.token,
  );
  assert.equal(result.status, "succeeded");
  const history = await api(stub, "/v1/actions/export");
  assert.equal(history.actions.length, 1);
  assert.deepEqual(history.actions[0].result, { softwareFixture: true });
  await api(stub, `/v1/devices/${paired.deviceId}/revoke`, "POST", {});
  assert.deepEqual(await api(stub, "/v1/devices"), []);
  console.log(
    "PASS: workerd SQLite attachment, restart, idempotency, grants, outcome, export and revocation",
  );
} finally {
  if (worker) await worker.dispose();
  rmSync(directory, { recursive: true, force: true });
}
