import test from "node:test";
import assert from "node:assert/strict";
import { Hub, Fault } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import {
  createToolCatalog,
  runToolAsync,
  toolNeedsActionScope,
  cloudRequest,
} from "../packages/mcp/src/index.ts";
import { MCP_VERSION } from "../packages/mcp/src/http-2026.ts";

const WORKSPACE = "a".repeat(64);
const owner = { id: "owner", owner: true };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deviceCredentials = {
  keyVersion: "v1",
  derive: async () => "derived-device-credential",
};
const oauthProvider = () => ({
  created: [],
  deleted: 0,
  async create(config) {
    const created = {
      applicationId: `app-${this.created.length + 1}`,
      clientId: `client_${this.created.length + 1}`,
      redirectUris: config.redirectUris,
      public: false,
      clientSecret: "provider-secret-123456",
    };
    this.created.push(created);
    return created;
  },
  async delete() {
    this.deleted += 1;
  },
});

const agentPrincipal = (connection, extra = {}) => ({
  id: connection.principal,
  owner: false,
  connectionPurpose: "agent",
  ...extra,
});
const managementTools = [
  "onboarding_status",
  "access_get",
  "policy_list",
  "policy_update",
  "agent_connection_list",
  "agent_connection_create",
  "agent_connection_revoke",
  "setup_token_create",
  "revoke_device",
  "oauth_client_list",
  "oauth_client_create",
  "oauth_client_revoke",
  "workspace_list",
  "workspace_select",
  "workspace_accept",
  "workspace_agents",
  "workspace_invite",
  "workspace_agent_revoke",
];

async function jsonRequest(
  hub,
  url,
  { method = "GET", principal = owner, body, context = {} } = {},
) {
  return handle(
    new Request(`https://bridge.test${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    hub,
    async () => principal,
    { workspace: WORKSPACE, ...context },
  );
}

async function createConnectionHTTP(hub, body) {
  const response = await jsonRequest(hub, "/v1/agent-connections", {
    method: "POST",
    body,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text).data;
}

async function attachDevice(hub, name, capabilities) {
  const enrollment = await hub.enrollment(owner, "uno-r4-wifi");
  return hub.enroll(enrollment.token, {
    name,
    kind: "uno-r4-wifi",
    capabilities,
  });
}

let rpcId = 0;
async function mcpMessage(hub, message, principal, context = {}) {
  return handle(
    new Request("https://bridge.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_VERSION,
        "mcp-method": message.method,
        ...(message.method === "tools/call"
          ? { "mcp-name": message.params.name }
          : {}),
      },
      body: JSON.stringify(message),
    }),
    hub,
    async () => principal,
    { workspace: WORKSPACE, ...context },
  );
}
async function mcpCall(hub, principal, name, args = {}, context = {}) {
  const message = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  return mcpMessage(hub, message, principal, context);
}
async function mcpToolsList(hub, principal, context = {}) {
  const message = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const response = await mcpMessage(hub, message, principal, context);
  assert.equal(response.status, 200);
  return (await response.json()).result.tools;
}

async function callTool(hub, principal, name, args, context = {}) {
  const tool = createToolCatalog(hub, principal, context).find(
    (candidate) => candidate.name === name,
  );
  assert.ok(tool, `${name} exists in the catalog`);
  return runToolAsync(tool.fn, await tool.schema.parseAsync(args ?? {}));
}
async function expectToolOk(hub, principal, name, args, context = {}) {
  const result = await callTool(hub, principal, name, args, context);
  assert.equal(
    result.isError,
    undefined,
    `${name}: ${result.content?.[0]?.text ?? ""}`,
  );
  return result.structuredContent.data;
}
async function expectToolError(hub, principal, name, args, pattern, context = {}) {
  const result = await callTool(hub, principal, name, args, context);
  assert.equal(result.isError, true, `${name} should fail`);
  assert.match(result.content[0].text, pattern, name);
  return result.content[0].text;
}

test("new agent connections default to an all-devices operator policy and preserve explicit ceilings", async () => {
  const hub = new Hub();
  const operator = await createConnectionHTTP(hub, { name: "ops" });
  assert.ok(operator.token.startsWith("ol_agent_"));
  assert.equal(operator.access, "act");
  const policy = hub.state.accessPolicies.find(
    (candidate) => candidate.principal === operator.principal,
  );
  assert.deepEqual(
    {
      mode: policy.mode,
      role: policy.role,
      excludedDevices: policy.excludedDevices,
      excludedFunctions: policy.excludedFunctions,
      expiresAt: policy.expiresAt,
      delegatedFrom: policy.delegatedFrom,
    },
    {
      mode: "all",
      role: "operator",
      excludedDevices: [],
      excludedFunctions: [],
      expiresAt: operator.expiresAt,
      delegatedFrom: undefined,
    },
  );
  // An explicit read ceiling is preserved on the connection itself.
  const watcher = await createConnectionHTTP(hub, {
    name: "watch",
    access: "read",
  });
  assert.equal(watcher.access, "read");
  assert.equal(
    hub.state.accessPolicies.find((p) => p.principal === watcher.principal)
      .role,
    "operator",
  );
  // Only an owner session may request the administrator role.
  const admin = await createConnectionHTTP(hub, {
    name: "admin",
    role: "administrator",
  });
  assert.equal(
    hub.state.accessPolicies.find((p) => p.principal === admin.principal)
      .role,
    "administrator",
  );
});

test("access policy endpoints round-trip; /v1/access reports effective access", async () => {
  const hub = new Hub();
  const device = await attachDevice(hub, "board", ["device.health"]);
  const connection = await createConnectionHTTP(hub, { name: "ops" });
  const agent = agentPrincipal(connection);

  let response = await jsonRequest(hub, "/v1/access-policies");
  assert.equal(response.status, 200);
  const listed = (await response.json()).data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].principal, connection.principal);

  response = await jsonRequest(hub, "/v1/access-policies", {
    method: "POST",
    body: {
      principal: connection.principal,
      mode: "all",
      excludedDevices: [device.deviceId],
      excludedFunctions: [{ deviceId: null, capability: "system.exec" }],
      role: "operator",
      expiresAt: null,
    },
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()).data;
  assert.deepEqual(updated.excludedDevices, [device.deviceId]);
  assert.deepEqual(updated.excludedFunctions, [
    { deviceId: null, capability: "system.exec" },
  ]);

  response = await jsonRequest(hub, "/v1/access", { principal: agent });
  assert.equal(response.status, 200);
  const effective = (await response.json()).data;
  assert.equal(effective.role, "operator");
  assert.equal(effective.mode, "all");
  assert.deepEqual(effective.excludedDevices, [device.deviceId]);

  assert.equal(
    (
      await jsonRequest(hub, "/v1/access-policies", {
        method: "POST",
        body: { principal: connection.principal, role: "admin" },
      })
    ).status,
    400,
  );
  // A plain agent principal has no management authority at all.
  const denied = await jsonRequest(hub, "/v1/access-policies", {
    method: "POST",
    principal: agent,
    body: { principal: connection.principal, role: "administrator" },
  });
  assert.equal(denied.status, 403);
  // A delegated administrator cannot grant the administrator role either.
  const adminConnection = await createConnectionHTTP(hub, {
    name: "admin",
    role: "administrator",
  });
  const adminDenied = await jsonRequest(hub, "/v1/access-policies", {
    method: "POST",
    principal: agentPrincipal(adminConnection),
    body: { principal: connection.principal, role: "administrator" },
  });
  assert.equal(adminDenied.status, 403);
  assert.match((await adminDenied.json()).error.message, /owner/);
});

test("management tools enforce the live role; operators get a forbidden next step", async () => {
  const hub = new Hub();
  const operatorConnection = await createConnectionHTTP(hub, { name: "ops" });
  const operator = agentPrincipal(operatorConnection);

  for (const [name, args] of [
    ["agent_connection_create", { name: "sneaky" }],
    ["policy_update", { principal: operator.id, mode: "all" }],
    ["setup_token_create", { name: "sneaky" }],
    ["revoke_device", { deviceId: uuid(1) }],
  ]) {
    const response = await mcpCall(hub, operator, name, args);
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /administrator role/, name);
    assert.match(result.content[0].text, /Next step/, name);
  }

  // Read-only tokens are stopped at the scope layer for management writes.
  const readOnly = agentPrincipal(operatorConnection, { readOnly: true });
  const blocked = await mcpCall(hub, readOnly, "policy_update", {
    principal: "someone-else",
  });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, "insufficient_scope");
});

test("delegated administrators act within their policy and cannot self-escalate", async () => {
  const hub = new Hub();
  const adminConnection = await createConnectionHTTP(hub, {
    name: "admin",
    role: "administrator",
  });
  // Mirror real admission: handle() applies the live policy to the principal
  // before any tool runs.
  const admin = hub.applyAccessPolicy(agentPrincipal(adminConnection));
  assert.equal(hub.effectiveAccess(admin).role, "administrator");
  const otherConnection = await createConnectionHTTP(hub, { name: "other" });

  // Live role: the delegated administrator can manage another principal's
  // operator policy.
  const updated = await expectToolOk(hub, admin, "policy_update", {
    principal: otherConnection.principal,
    role: "operator",
  });
  assert.equal(updated.role, "operator");

  await expectToolError(
    hub,
    admin,
    "policy_update",
    { principal: admin.id, mode: "all" },
    /own or ancestor/,
  );
  await expectToolError(
    hub,
    admin,
    "policy_update",
    { principal: otherConnection.principal, role: "administrator" },
    /Only the owner can grant/,
  );
  await expectToolError(
    hub,
    admin,
    "policy_update",
    { principal: otherConnection.principal, delegatedFrom: admin.id },
    /Only the owner can change policy delegation/,
  );
  await expectToolError(
    hub,
    admin,
    "agent_connection_create",
    { name: "escalated", role: "administrator" },
    /owner/,
  );
  await expectToolError(
    hub,
    admin,
    "workspace_invite",
    { name: "escalated", role: "administrator" },
    /owner/,
  );

  // The owner retains full authority, including administrator delegation.
  const ownerUpdate = await callTool(hub, owner, "policy_update", {
    principal: otherConnection.principal,
    role: "administrator",
  });
  assert.equal(ownerUpdate.isError, undefined);
  assert.equal(
    hub.state.accessPolicies.find(
      (policy) => policy.principal === otherConnection.principal,
    ).role,
    "administrator",
  );
});

test("policy exclusions deny devices and functions across the live chain", async () => {
  const hub = new Hub();
  const deviceA = await attachDevice(hub, "excluded", ["device.health"]);
  const deviceB = await attachDevice(hub, "kept", [
    "device.health",
    "display.text",
  ]);
  const connection = await createConnectionHTTP(hub, { name: "ops" });
  const agent = agentPrincipal(connection);

  let response = await jsonRequest(hub, "/v1/devices", { principal: agent });
  assert.deepEqual(
    (await response.json()).data.map((device) => device.id).sort(),
    [deviceA.deviceId, deviceB.deviceId].sort(),
  );

  // Excluding device A immediately narrows the agent's live view.
  await expectToolOk(hub, owner, "policy_update", {
    principal: connection.principal,
    excludedDevices: [deviceA.deviceId],
  });
  response = await jsonRequest(hub, "/v1/devices", { principal: agent });
  assert.deepEqual(
    (await response.json()).data.map((device) => device.id),
    [deviceB.deviceId],
  );
  assert.throws(
    () => hub.request(agent, deviceA.deviceId, "device.health", {}, "a-1"),
    (error) => error instanceof Fault && error.status === 403,
  );

  // A patch that only changes exclusions keeps the device exclusion too.
  await expectToolOk(hub, owner, "policy_update", {
    principal: connection.principal,
    excludedFunctions: [{ deviceId: null, capability: "device.health" }],
  });
  const policy = hub.state.accessPolicies.find(
    (candidate) => candidate.principal === connection.principal,
  );
  assert.deepEqual(policy.excludedDevices, [deviceA.deviceId]);
  assert.throws(
    () => hub.request(agent, deviceB.deviceId, "device.health", {}, "b-1"),
    (error) => error instanceof Fault && error.status === 403,
  );
  // Another function on the same device still works.
  const receipt = hub.request(
    agent,
    deviceB.deviceId,
    "display.text",
    { text: "hello" },
    "b-2",
  );
  assert.equal(receipt.status, "queued");
});

test("delegation inherits parent exclusions and parent expiry denies the child", async () => {
  const hub = new Hub();
  const device = await attachDevice(hub, "board", ["device.health"]);
  const parent = await createConnectionHTTP(hub, { name: "parent" });
  await expectToolOk(hub, owner, "policy_update", {
    principal: parent.principal,
    excludedDevices: [device.deviceId],
  });
  // Only an owner may choose an explicit delegation parent.
  const child = await hub.createConnection(
    owner,
    WORKSPACE,
    "child",
    86400,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
    parent.principal,
  );
  const childAgent = agentPrincipal(child);
  const childPolicy = hub.state.accessPolicies.find(
    (candidate) => candidate.principal === child.principal,
  );
  assert.equal(childPolicy.delegatedFrom, parent.principal);
  // The child inherits the parent exclusion even though its own mode is all.
  assert.deepEqual(hub.list(childAgent), []);
  assert.throws(
    () => hub.request(childAgent, device.deviceId, "device.health", {}, "c-1"),
    (error) => error instanceof Fault && error.status === 403,
  );

  // Expiring the parent policy denies the whole child chain.
  await expectToolOk(hub, owner, "policy_update", {
    principal: parent.principal,
    expiresAt: Date.now() - 1,
  });
  assert.deepEqual(hub.list(childAgent), []);
  const effective = hub.effectiveAccess(childAgent);
  assert.equal(effective.role, null);
  assert.deepEqual(effective.deviceIds, []);
  assert.throws(
    () => hub.request(childAgent, device.deviceId, "device.health", {}, "c-2"),
    (error) => error instanceof Fault && error.status === 403,
  );
  // New delegation from an expired parent fails closed.
  await assert.rejects(
    hub.createConnection(
      owner,
      WORKSPACE,
      "orphan",
      86400,
      "act",
      { canAttach: false, deviceLimit: 0 },
      "agent",
      parent.principal,
    ),
    /live policy/,
  );
});

test("credential tools show secrets once and never leak them on partial failure", async () => {
  const hub = new Hub();
  const context = { workspace: WORKSPACE };
  const existing = await createConnectionHTTP(hub, { name: "existing" });
  const setupToken = await expectToolOk(hub, owner, "setup_token_create", {
    name: "bench",
  }, context);
  assert.ok(setupToken.token.startsWith("ol_sdk_"));
  assert.equal(setupToken.purpose, "device-setup");
  assert.equal(setupToken.canAttach, true);

  const listed = await expectToolOk(hub, owner, "agent_connection_list", undefined, context);
  assert.ok(listed.length >= 1);
  assert.ok(listed.every((connection) => !("token" in connection)));
  assert.ok(listed.every((connection) => !("tokenHash" in connection)));

  // Administrator-role upgrade failing after creation: no secret is returned.
  const failing = hub.setAccessPolicy;
  hub.setAccessPolicy = () => {
    throw new Error("storage unavailable");
  };
  try {
    const partial = await callTool(hub, owner, "agent_connection_create", {
      name: "flaky",
      role: "administrator",
    }, context);
    assert.equal(partial.isError, true);
    assert.match(partial.content[0].text, /not issued/);
    assert.ok(!JSON.stringify(partial).includes("ol_agent_"));
  } finally {
    hub.setAccessPolicy = failing;
  }
  // Recovery: connections can still be created and revoked.
  const connection = await createConnectionHTTP(hub, { name: "revocable" });
  const revoked = await expectToolOk(hub, owner, "agent_connection_revoke", {
    connectionId: connection.id,
  }, context);
  assert.equal(revoked.ok, true);
  const after = await expectToolOk(hub, owner, "agent_connection_list", undefined, context);
  assert.ok(!after.some((candidate) => candidate.id === connection.id));
  assert.ok(after.some((candidate) => candidate.id === existing.id));
});

test("onboarding status reflects live policies: all-mode needs no grants, legacy does", async () => {
  let hub = new Hub();
  await attachDevice(hub, "board", ["device.health"]);
  await createConnectionHTTP(hub, { name: "ops" });
  let response = await jsonRequest(hub, "/v1/onboarding", {
    context: { deviceCredentials },
  });
  assert.equal(response.status, 200);
  let summary = (await response.json()).data;
  assert.equal(summary.devices.length, 1);
  assert.equal(summary.setup.attachmentConfigured, true);
  assert.equal(summary.setup.agentConnections.length, 1);
  assert.ok(!summary.nextSteps.some((step) => /grant/i.test(step)));
  assert.ok(!summary.nextSteps.some((step) => /agent API connection/i.test(step)));

  // A legacy-purpose connection (no policy) still needs explicit grants.
  hub = new Hub();
  await attachDevice(hub, "board", ["device.health"]);
  await hub.createConnection(owner, WORKSPACE, "legacy", 86400, "act", {
    canAttach: false,
    deviceLimit: 0,
  });
  response = await jsonRequest(hub, "/v1/onboarding");
  summary = (await response.json()).data;
  assert.ok(summary.nextSteps.some((step) => /Grant device functions/i.test(step)));
  assert.ok(!summary.nextSteps.some((step) => /attach your first device/i.test(step)));

  // Operators are told what to ask for instead of getting management data.
  const connection = await createConnectionHTTP(hub, { name: "ops" });
  const operatorResponse = await jsonRequest(hub, "/v1/onboarding", {
    principal: agentPrincipal(connection),
  });
  assert.equal(operatorResponse.status, 403);
  assert.match((await operatorResponse.json()).error.message, /administrator/);
});

test("every management tool answers a real live call for the owner", async () => {
  const hub = new Hub();
  const provider = oauthProvider();
  const cloudCalls = [];
  const context = {
    workspace: WORKSPACE,
    deviceCredentials,
    oauthClients: provider,
    cloud: async (method, path, body) => {
      cloudCalls.push({ method, path, body });
      return { ok: true };
    },
  };
  const device = await attachDevice(hub, "board", ["device.health"]);
  const connection = await createConnectionHTTP(hub, { name: "managed" });

  await expectToolOk(hub, owner, "onboarding_status", {}, context);
  const access = await expectToolOk(hub, owner, "access_get", {}, context);
  assert.equal(access.source, "owner");
  const policies = await expectToolOk(hub, owner, "policy_list", {}, context);
  assert.ok(policies.some((policy) => policy.principal === connection.principal));
  const connections = await expectToolOk(
    hub,
    owner,
    "agent_connection_list",
    {},
    context,
  );
  assert.ok(connections.some((candidate) => candidate.id === connection.id));
  const created = await expectToolOk(hub, owner, "agent_connection_create", {
    name: "loop-connection",
  }, context);
  assert.ok(created.token.startsWith("ol_agent_"));
  await expectToolOk(hub, owner, "policy_update", {
    principal: created.principal,
    role: "operator",
  }, context);
  const setupToken = await expectToolOk(hub, owner, "setup_token_create", {
    name: "loop-token",
  }, context);
  assert.ok(setupToken.token.startsWith("ol_sdk_"));
  await expectToolOk(hub, owner, "revoke_device", {
    deviceId: device.deviceId,
  }, context);
  const oauthClient = await expectToolOk(hub, owner, "oauth_client_create", {
    name: "loop-oauth",
    redirectUris: ["https://loop.test/callback"],
    access: "read",
    public: false,
  }, context);
  assert.equal(oauthClient.purpose, "oauth");
  const oauthList = await expectToolOk(hub, owner, "oauth_client_list", {}, context);
  assert.equal(oauthList.available, true);
  assert.ok(oauthList.clients.some((candidate) => candidate.id === oauthClient.id));
  const oauthRevoked = await expectToolOk(hub, owner, "oauth_client_revoke", {
    connectionId: oauthClient.id,
  }, context);
  assert.deepEqual(oauthRevoked, { ok: true, providerCleanupPending: false });
  assert.equal(provider.deleted, 1);
  await expectToolOk(hub, owner, "workspace_list", {}, context);
  await expectToolOk(hub, owner, "workspace_select", {
    workspace: WORKSPACE,
  }, context);
  await expectToolOk(hub, owner, "workspace_accept", {
    invitation: "ol_inv_workspace_test",
  }, context);
  await expectToolOk(hub, owner, "workspace_agents", {}, context);
  await expectToolOk(hub, owner, "workspace_invite", {
    name: "loop-invite",
  }, context);
  await expectToolOk(hub, owner, "workspace_agent_revoke", {
    agentId: `agent:${"b".repeat(64)}`,
  }, context);
  await expectToolOk(hub, owner, "agent_connection_revoke", {
    connectionId: created.id,
  }, context);
  // Every whitelisted workspace route was exercised through the gateway.
  assert.deepEqual(
    cloudCalls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /v1/workspaces",
      "POST /v1/workspaces/select",
      "POST /v1/workspaces/accept",
      "GET /v1/workspace/agents",
      "POST /v1/workspace/invitations",
      `POST /v1/workspace/agents/agent:${"b".repeat(64)}/revoke`,
    ],
  );
});

test("workspace tools call only whitelisted hosted routes through the context gateway", async () => {
  const hub = new Hub();
  const calls = [];
  const context = {
    workspace: WORKSPACE,
    cloud: async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true };
    },
  };
  const listed = await mcpCall(hub, owner, "workspace_list", {}, context);
  assert.equal((await listed.json()).result.structuredContent.data.ok, true);
  await mcpCall(hub, owner, "workspace_invite", { name: "helper" }, context);
  await mcpCall(
    hub,
    owner,
    "workspace_agent_revoke",
    { agentId: `agent:${"b".repeat(64)}` },
    context,
  );
  assert.deepEqual(calls, [
    { method: "GET", path: "/v1/workspaces", body: undefined },
    {
      method: "POST",
      path: "/v1/workspace/invitations",
      body: { name: "helper" },
    },
    {
      method: "POST",
      path: `/v1/workspace/agents/agent:${"b".repeat(64)}/revoke`,
      body: undefined,
    },
  ]);

  // No cloud gateway: clear setup requirement, no silent fallback.
  const withoutCloud = await mcpCall(hub, owner, "workspace_list");
  const payload = (await withoutCloud.json()).result;
  assert.equal(payload.isError, true);
  assert.match(payload.content[0].text, /hosted service/);
  // Non-whitelisted routes are refused; there is no generic HTTP proxy tool.
  await assert.rejects(
    cloudRequest(
      { cloud: async () => ({}), workspace: WORKSPACE },
      "GET",
      "/v1/devices",
    ),
    /not whitelisted/,
  );
  await assert.rejects(
    cloudRequest({ workspace: WORKSPACE }, "GET", "/v1/workspaces"),
    /hosted service/,
  );
});

test("management tools are static and compact across transports with action-scope checks", async () => {
  const hub = new Hub();
  const catalog = createToolCatalog(hub, owner, { workspace: WORKSPACE });
  const names = catalog.map((tool) => tool.name);
  for (const name of managementTools) assert.ok(names.includes(name), name);
  // tools/list over the per-request 2026 protocol exposes the same catalog.
  const listed = await mcpToolsList(hub, owner, { workspace: WORKSPACE });
  const listedNames = listed.map((tool) => tool.name);
  for (const name of managementTools)
    assert.ok(listedNames.includes(name), name);

  // Management writes require the act scope; inspections stay readable.
  assert.equal(toolNeedsActionScope(hub, owner, "policy_update", {}), true);
  assert.equal(
    toolNeedsActionScope(hub, owner, "agent_connection_create", {}),
    true,
  );
  assert.equal(toolNeedsActionScope(hub, owner, "revoke_device", {}), true);
  assert.equal(toolNeedsActionScope(hub, owner, "policy_list", {}), false);
  assert.equal(toolNeedsActionScope(hub, owner, "access_get", {}), false);
  assert.equal(
    toolNeedsActionScope(hub, owner, "onboarding_status", {}),
    false,
  );
});

test("oauth management tools reuse the shared provider handlers", async () => {
  const hub = new Hub();
  const provider = oauthProvider();
  const context = { workspace: WORKSPACE, oauthClients: provider };
  const client = await expectToolOk(hub, owner, "oauth_client_create", {
    name: "bridge",
    redirectUris: ["https://bridge.test/callback"],
    access: "read",
    public: false,
  }, context);
  assert.equal(client.purpose, "oauth");
  assert.equal(client.clientSecret, "provider-secret-123456");

  const listed = await expectToolOk(hub, owner, "oauth_client_list", {}, context);
  assert.equal(listed.available, true);
  assert.equal(listed.clients.length, 1);
  assert.ok(!("clientSecret" in listed.clients[0]));

  const revoked = await expectToolOk(hub, owner, "oauth_client_revoke", {
    connectionId: client.id,
  }, context);
  assert.deepEqual(revoked, { ok: true, providerCleanupPending: false });
  assert.equal(provider.deleted, 1);
  // The secret was shown exactly once: never in the list response.
  assert.ok(!JSON.stringify(listed).includes("provider-secret"));
});
