import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Miniflare } from "miniflare";
import { createClient } from "../packages/sdk/dist/index.js";
import { runAgentCli } from "../packages/sdk/dist/agent-cli.js";
import { writeAgentConfig } from "../packages/sdk/dist/agent-config.js";

// Disposable workerd acceptance. Trusted headers model verified Clerk identity;
// actual signature/issuer/scope validation is covered by clerk-verification.test.
// Every adapter result below is explicitly a software fixture, not hardware.
const directory = mkdtempSync(join(tmpdir(), "openlaunch-agent-onboarding-"));
chmodSync(directory, 0o700);
const workspace = "a".repeat(64),
  identity = "b".repeat(64);
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
const name = "openlaunch-agent-onboarding-acceptance";
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
          DEVICE_CREDENTIAL_KEYS: {
            type: "text",
            value: JSON.stringify({ v1: randomBytes(32).toString("hex") }),
          },
          DEVICE_CREDENTIAL_KEY_VERSION: { type: "text", value: "v1" },
          API_ORIGIN: { type: "text", value: "https://www.openlaunch.dev" },
          CONTROLS_ENABLED: { type: "text", value: "true" },
        },
      },
    },
  ],
};
let worker, stub;
async function start() {
  worker = new Miniflare(options);
  const namespace = await worker.getDurableObjectNamespace("HUBS");
  stub = namespace.get(namespace.idFromName(workspace));
}
async function api(path, method = "GET", body, opts = {}) {
  const headers = {
    "x-openlaunch-workspace": workspace,
    "content-type": "application/json",
  };
  if (opts.owner !== false)
    headers["x-openlaunch-principal"] = JSON.stringify({
      id: "owner",
      owner: true,
    });
  if (opts.identity) headers["x-openlaunch-identity"] = opts.identity;
  if (opts.member) headers["x-openlaunch-member"] = "true";
  if (opts.session) headers["x-openlaunch-session"] = "true";
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  const response = await stub.fetch("https://www.openlaunch.dev" + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    opts.status ??
      (method === "POST" &&
      [
        "/v1/workspace/invitations",
        "/v1/device-setup-tokens",
        "/v1/sdk/devices",
      ].includes(path)
        ? 201
        : /\/actions$/.test(path) && method === "POST"
          ? 202
          : 200),
    `${path}: ${response.status} ${JSON.stringify(result.error ?? {})}`,
  );
  return Object.hasOwn(result, "data") ? result.data : result.error;
}
const policy = (principal, rest = {}) => ({
  principal,
  mode: "all",
  excludedDevices: [],
  excludedFunctions: [],
  role: "administrator",
  expiresAt: null,
  ...rest,
});
let rpcId = 0;
async function mcp(token, method, params = {}) {
  const response = await stub.fetch("https://www.openlaunch.dev/mcp", {
    method: "POST",
    headers: {
      "x-openlaunch-workspace": workspace,
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "openlaunch fixture",
            version: "1",
          },
        },
      },
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  return result.result;
}
try {
  await start();
  const issued = await api("/v1/workspace/invitations", "POST", {
    name: "Fixture agent",
    role: "administrator",
  });
  const joined = await api(
    "/__workspace/accept",
    "POST",
    { invitation: issued.invitation },
    { owner: false, identity },
  );
  const member = { identity, member: true, session: true };
  const account = await api("/v1/account", "GET", undefined, member);
  assert.equal(account.principal.owner, false);
  assert.equal(account.principal.administrator, true);
  assert.equal(account.principal.id, joined.principalId);
  await api(
    "/__workspace/accept",
    "POST",
    { invitation: issued.invitation },
    { owner: false, identity: "c".repeat(64), status: 401 },
  );
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await api(
    "/v1/cli-login/authorize",
    "POST",
    { callbackUrl: "http://127.0.0.1:4321/callback", state, challenge },
    member,
  );
  const login = await api(
    "/v1/cli-login/exchange",
    "POST",
    { code: code.code, verifier },
    { owner: false },
  );
  const agent = { owner: false, token: login.token };
  assert.equal(login.role, "administrator");
  await api(
    "/v1/cli-login/exchange",
    "POST",
    { code: code.code, verifier },
    { owner: false, status: 401 },
  );
  // An alias credential must not edit the parent identity's access policy.
  await api("/v1/access-policies", "POST", policy(joined.principalId), {
    ...agent,
    status: 403,
  });
  const setup = await api(
    "/v1/device-setup-tokens",
    "POST",
    { name: "Fixture adapter", deviceLimit: 1, ttlSeconds: 600 },
    agent,
  );
  const paired = await api(
    "/v1/sdk/devices",
    "POST",
    {
      requestId: crypto.randomUUID(),
      manifest: {
        name: "Software fixture",
        kind: "custom.device",
        capabilities: ["device.health", "led.set"],
      },
    },
    { owner: false, token: setup.token },
  );
  const toolList = await mcp(login.token, "tools/list");
  for (const tool of [
    "invoke_device_function",
    "access_get",
    "setup_token_create",
    "workspace_list",
  ])
    assert(
      toolList.tools.some((t) => t.name === tool),
      tool,
    );
  const access = await mcp(login.token, "tools/call", {
    name: "access_get",
    arguments: {},
  });
  assert.equal(access.structuredContent.data.role, "administrator");
  const fixtureFetch = (url, init = {}) =>
    stub.fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        "x-openlaunch-workspace": workspace,
      },
    });
  const sdk = createClient({
    url: "https://www.openlaunch.dev",
    token: login.token,
    fetch: fixtureFetch,
  });
  assert.equal((await sdk.listDevices())[0].id, paired.deviceId);
  let cliOutput = "";
  const cliDirectory = join(directory, "cli");
  await writeAgentConfig(
    {
      version: 2,
      mode: "agentid",
      url: "https://www.openlaunch.dev",
      ...login,
    },
    cliDirectory,
  );
  await runAgentCli(
    ["devices", "list"],
    {},
    {
      write: (value) => {
        cliOutput += value;
      },
    },
    { fetch: fixtureFetch, configDirectory: cliDirectory },
  );
  assert.equal(JSON.parse(cliOutput)[0].id, paired.deviceId);
  const request = {
    capability: "device.health",
    arguments: {},
    idempotencyKey: "fixture-health",
    ttlSeconds: 60,
  };
  const action = await api(
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    request,
    agent,
  );
  const device = { owner: false, token: paired.token };
  const command = await api(
    `/v1/device/${paired.deviceId}/next`,
    "POST",
    {},
    device,
  );
  assert.equal(command.id, action.id);
  await api(
    `/v1/device/${paired.deviceId}/result`,
    "POST",
    {
      actionId: action.id,
      status: "succeeded",
      result: { fixture: true, physicalVerified: false },
    },
    device,
  );
  assert.equal(
    (await api(`/v1/actions/${action.id}`, "GET", undefined, agent)).status,
    "succeeded",
  );
  assert.equal(
    (
      await api(
        `/v1/devices/${paired.deviceId}/actions`,
        "POST",
        request,
        agent,
      )
    ).id,
    action.id,
  );
  const denyHealth = policy(joined.principalId, {
    excludedFunctions: [{ deviceId: null, capability: "device.health" }],
  });
  await api("/v1/access-policies", "POST", denyHealth);
  await api(
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    { ...request, idempotencyKey: "blocked-health" },
    { ...agent, status: 403 },
  );
  assert.equal(
    (await api("/v1/functions", "GET", undefined, agent)).some(
      (f) => f.definition.name === "device.health",
    ),
    false,
  );
  await worker.dispose();
  worker = undefined;
  await start();
  await api(
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    { ...request, idempotencyKey: "blocked-after-restart" },
    { ...agent, status: 403 },
  );
  await api(`/v1/device/${paired.deviceId}/heartbeat`, "POST", {}, device);
  const pending = await api(
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    {
      capability: "led.set",
      arguments: { on: true },
      idempotencyKey: "cancel-on-exclusion",
      ttlSeconds: 60,
    },
    agent,
  );
  await api(
    "/v1/access-policies",
    "POST",
    policy(joined.principalId, { excludedDevices: [paired.deviceId] }),
  );
  assert.equal(
    await api(`/v1/device/${paired.deviceId}/next`, "POST", {}, device),
    null,
  );
  assert.equal((await api(`/v1/actions/${pending.id}`)).status, "cancelled");
  await api(`/v1/workspace/agents/${joined.principalId}/revoke`, "POST", {});
  await api("/v1/devices", "GET", undefined, { ...agent, status: 401 });
  await api("/v1/account", "GET", undefined, { ...member, status: 403 });
  await api(
    "/__workspace/accept",
    "POST",
    { invitation: issued.invitation },
    { owner: false, identity, status: 403 },
  );
  const restoredInvite = await api("/v1/workspace/invitations", "POST", {
    name: "Restored agent",
    role: "operator",
  });
  await api(
    "/__workspace/accept",
    "POST",
    { invitation: restoredInvite.invitation },
    { owner: false, identity },
  );
  assert.equal(
    (await api("/v1/account", "GET", undefined, member)).principal
      .administrator,
    false,
  );
  // Restoration cannot resurrect the old credential.
  await api("/v1/devices", "GET", undefined, { ...agent, status: 401 });
  const privateResponse = await worker.dispatchFetch(
    "https://www.openlaunch.dev/__workspace/accept",
    { method: "POST", body: "{}" },
  );
  assert.equal(privateResponse.status, 404);
  console.log(
    "PASS: workerd agent invite, PKCE CLI login, delegated setup, fixture action, exclusion persistence, replay, revocation and explicit restoration",
  );
} finally {
  await worker?.dispose();
  rmSync(directory, { recursive: true, force: true });
}
