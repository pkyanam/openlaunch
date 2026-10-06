import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  Hub,
  emptyState,
} from "../packages/core/src/index.ts";
import { withWorkspaceSQLiteState } from "../apps/cloud/src/sqlite-state.ts";

const owner = { id: "owner", owner: true };
const workspace = "a".repeat(64);

const allPolicy = (principal, overrides = {}) => ({
  principal,
  mode: "all",
  excludedDevices: [],
  excludedFunctions: [],
  role: "operator",
  expiresAt: null,
  ...overrides,
});

const device = async (hub, name = "fixture") => {
  const enrollment = await hub.enrollment(owner, "custom.device");
  const { deviceId } = await hub.enroll(enrollment.token, {
    name,
    kind: "custom.device",
    capabilities: ["device.health", "led.set"],
  });
  return deviceId;
};

const agentConnection = async (hub, name = "app") => {
  const connection = await hub.createConnection(
    owner,
    workspace,
    name,
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  return {
    connection,
    principal: await hub.authenticateConnection(connection.token, workspace),
  };
};

test("new agent connections default to all functions and dispatch obeys the live policy", async () => {
  const hub = new Hub(emptyState());
  const first = await device(hub, "one");
  const second = await device(hub, "two");
  const { connection, principal } = await agentConnection(hub);
  assert.deepEqual(hub.effectiveAccess(principal).deviceIds, [first, second]);
  assert.equal(
    hub.request(principal, second, "led.set", { on: true }, "d1").status,
    "queued",
  );
  // Dispatch re-check passes while the policy is live.
  assert.equal(hub.next(second).capability, "led.set");
  const action = hub.request(principal, first, "led.set", { on: false }, "d2");
  hub.setAccessPolicy(owner, allPolicy(connection.principal, {
    excludedDevices: [first],
  }));
  assert.equal(action.status, "cancelled");
  assert.throws(
    () => hub.request(principal, first, "led.set", { on: true }, "d3"),
    (e) => e.status === 403,
  );
  assert.equal(hub.next(first), null);
  assert.equal(hub.next(second), null);
  // get/cancel obey the same policy.
  const allowed = hub.request(principal, second, "led.set", { on: true }, "d4");
  assert.equal(hub.get(principal, allowed.id).id, allowed.id);
  assert.equal(hub.cancel(principal, allowed.id).status, "cancelled");
  const blocked = hub.request(owner, first, "led.set", { on: true }, "own1");
  assert.throws(() => hub.get(principal, blocked.id), (e) => e.status === 403);
});

test("legacy purpose-unspecified connections and pre-upgrade state keep grants-only behavior", async () => {
  const hub = new Hub(emptyState());
  const deviceId = await device(hub);
  const legacy = await hub.createConnection(owner, workspace, "legacy");
  const principal = await hub.authenticateConnection(legacy.token, workspace);
  assert.equal(hub.state.accessPolicies.length, 0);
  assert.throws(
    () => hub.request(principal, deviceId, "led.set", { on: true }, "l1"),
    (e) => e.status === 403,
  );
  hub.grant(owner, principal.id, deviceId, ["led.set"]);
  assert.equal(hub.request(principal, deviceId, "led.set", { on: true }, "l2").status, "queued");
  // Pre-upgrade persisted state hydrates with the selected default.
  const saved = JSON.parse(JSON.stringify(hub.state));
  delete saved.accessPolicies;
  delete saved.agentAccessDefault;
  const restored = new Hub(saved);
  assert.equal(restored.state.agentAccessDefault, "selected");
});

test("owner policy exclusions limit devices and functions and survive manifest revisions", async () => {
  const hub = new Hub(emptyState());
  const first = await device(hub, "one");
  const second = await device(hub, "two");
  const { connection, principal } = await agentConnection(hub);
  hub.setAccessPolicy(owner, allPolicy(connection.principal, {
    excludedFunctions: [
      { deviceId: null, capability: "led.set" },
      { deviceId: second, capability: "device.health" },
    ],
  }));
  assert.deepEqual(hub.effectiveAccess(principal).deviceIds, [first]);
  assert.equal(hub.list(principal).length, 1);
  assert.deepEqual(
    hub.list(principal).map((d) => d.capabilities),
    [["device.health"]],
  );
  assert.equal(
    hub.request(principal, first, "device.health", {}, "h1").status,
    "queued",
  );
  assert.throws(
    () => hub.request(principal, first, "led.set", { on: true }, "x1"),
    (e) => e.status === 403,
  );
  assert.throws(
    () => hub.request(principal, second, "device.health", {}, "x2"),
    (e) => e.status === 403,
  );
  assert.throws(
    () => hub.setAccessPolicy(owner, { ...allPolicy(connection.principal), mode: "nonsense" }),
  );
  // Exclusions survive manifest revisions and still cancel stale-schema work.
  const queued = hub.request(principal, first, "device.health", {}, "h2");
  hub.publishManifest(first, {
    name: "one",
    kind: "custom.device",
    capabilities: ["device.health", "led.set", "switch.set"],
    functions: [
      {
        name: "switch.set",
        title: "Switch",
        description: "Set a switch",
        access: "write",
        inputSchema: {
          type: "object",
          properties: { on: { type: "boolean" } },
          required: ["on"],
          additionalProperties: false,
        },
      },
    ],
  });
  assert.equal(queued.status, "cancelled");
  const entry = hub.list(principal).find((d) => d.id === first);
  assert.deepEqual(entry.capabilities, ["device.health", "switch.set"]);
  assert.equal(
    hub.request(principal, first, "switch.set", { on: true }, "s1").status,
    "queued",
  );
});

test("all-mode revokeGrant excludes the device and grant never wipes exclusions", async () => {
  const hub = new Hub(emptyState());
  const deviceId = await device(hub);
  const { connection, principal } = await agentConnection(hub);
  hub.revokeGrant(owner, connection.principal, deviceId);
  assert.throws(
    () => hub.request(principal, deviceId, "led.set", { on: true }, "r1"),
    (e) => e.status === 403,
  );
  assert.deepEqual(hub.effectiveAccess(principal).excludedDevices, [deviceId]);
  // Granting one capability does not re-admit the excluded device and never
  // clears unrelated exclusions; owners update the policy explicitly instead.
  hub.grant(owner, connection.principal, deviceId, ["device.health"]);
  assert.throws(
    () => hub.request(principal, deviceId, "device.health", {}, "r2"),
    (e) => e.status === 403,
  );
  assert.deepEqual(
    hub.state.accessPolicies.find((p) => p.principal === connection.principal)
      .excludedDevices,
    [deviceId],
  );
  // Function-level exclusions survive grants for other capabilities.
  const other = await device(hub, "other");
  hub.setAccessPolicy(
    owner,
    allPolicy(connection.principal, {
      excludedFunctions: [{ deviceId: other, capability: "led.set" }],
    }),
  );
  hub.grant(owner, connection.principal, other, ["device.health"]);
  assert.deepEqual(
    hub.state.accessPolicies.find((p) => p.principal === connection.principal)
      .excludedFunctions,
    [{ deviceId: other, capability: "led.set" }],
  );
  assert.throws(
    () => hub.request(principal, other, "led.set", { on: true }, "r3"),
    (e) => e.status === 403,
  );
  assert.equal(
    hub.request(principal, other, "device.health", {}, "r4").status,
    "queued",
  );
  // Devices without exclusions remain granted by the all policy.
  const fresh = await device(hub, "fresh");
  assert.equal(
    hub.request(principal, fresh, "led.set", { on: true }, "r5").status,
    "queued",
  );
});

test("new all policies include gateway-discovered devices automatically", async () => {
  const hub = new Hub(emptyState());
  const { principal } = await agentConnection(hub);
  const gateway = await hub.enrollment(owner, "gateway.ha");
  const { deviceId: gatewayId } = await hub.enroll(gateway.token, {
    name: "hub",
    kind: "gateway.ha",
    capabilities: ["device.health"],
  });
  hub.state.devices.find((d) => d.id === gatewayId).gatewayDeviceLimit = 5;
  const outcomes = hub.gatewayChildren(gatewayId, [
    { key: "k1", manifest: { name: "bulb", kind: "home-assistant.light", capabilities: ["device.health"] } },
  ]);
  assert.equal(outcomes[0].revoked, false);
  const childId = outcomes[0].deviceId;
  assert.deepEqual(hub.list(principal).map((d) => d.id).sort(), [childId, gatewayId].sort());
});

test("delegated administrators manage operator policies only and cannot self-escalate", async () => {
  const hub = new Hub(emptyState());
  const deviceId = await device(hub);
  const { connection: admin, principal: adminSession } = await agentConnection(hub, "admin");
  const { connection: peer, principal: peerSession } = await agentConnection(hub, "peer");
  hub.setAccessPolicy(owner, allPolicy(admin.principal, { role: "administrator" }));
  const admitted = hub.applyAccessPolicy(adminSession);
  assert.equal(admitted.administrator, true);
  // Stale flags alone never escalate.
  assert.throws(() => hub.accessPolicies(adminSession), (e) => e.status === 403);
  assert.equal(hub.accessPolicies(admitted).length >= 2, true);
  // Managing an operator peer policy is allowed.
  hub.setAccessPolicy(admitted, allPolicy(peer.principal, { excludedDevices: [deviceId] }));
  assert.throws(
    () => hub.request(peerSession, deviceId, "led.set", { on: true }, "p1"),
    (e) => e.status === 403,
  );
  // Own policy, ancestors, administrator minting and delegation are forbidden.
  assert.throws(
    () => hub.setAccessPolicy(admitted, allPolicy(admin.principal)),
    (e) => e.status === 403,
  );
  assert.throws(
    () =>
      hub.setAccessPolicy(admitted, allPolicy(peer.principal, { role: "administrator" })),
    (e) => e.status === 403,
  );
  assert.throws(
    () =>
      hub.setAccessPolicy(admitted, {
        ...allPolicy("fresh.principal"),
        delegatedFrom: admin.principal,
      }),
    (e) => e.status === 403,
  );
  // Peer demotion of an existing administrator policy is owner-only.
  const { connection: secondAdmin } = await agentConnection(hub, "admin2");
  hub.setAccessPolicy(owner, allPolicy(secondAdmin.principal, { role: "administrator" }));
  assert.throws(
    () =>
      hub.setAccessPolicy(admitted, allPolicy(secondAdmin.principal, { role: "operator" })),
    (e) => e.status === 403,
  );
  // Administrator credential peers are owner-managed for grants and revocation.
  assert.throws(
    () =>
      hub.grant(admitted, secondAdmin.principal, deviceId, ["device.health"]),
    (e) => e.status === 403,
  );
  assert.throws(
    () => hub.revokeGrant(admitted, secondAdmin.principal, deviceId),
    (e) => e.status === 403,
  );
  assert.throws(
    () => hub.revokeConnection(admitted, secondAdmin.id),
    (e) => e.status === 403,
  );
  // The owner retains all of these powers.
  hub.setAccessPolicy(owner, allPolicy(secondAdmin.principal, { role: "operator" }));
  hub.revokeConnection(owner, secondAdmin.id);
  assert.equal(hub.state.agentConnections.find((c) => c.id === secondAdmin.id).revoked, true);
});

test("credentials minted by administrators delegate to the minting principal", async () => {
  const hub = new Hub(emptyState());
  const first = await device(hub, "one");
  const second = await device(hub, "two");
  const { connection: admin, principal: adminSession } = await agentConnection(hub, "admin");
  hub.setAccessPolicy(owner, allPolicy(admin.principal, {
    role: "administrator",
    excludedDevices: [second],
  }));
  const admitted = hub.applyAccessPolicy(adminSession);
  const minted = await hub.createConnection(
    admitted,
    workspace,
    "child",
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  const policy = hub.state.accessPolicies.find((p) => p.principal === minted.principal);
  assert.equal(policy.delegatedFrom, admin.principal);
  const childSession = await hub.authenticateConnection(minted.token, workspace);
  assert.equal(hub.request(childSession, first, "led.set", { on: true }, "c1").status, "queued");
  assert.throws(
    () => hub.request(childSession, second, "led.set", { on: true }, "c2"),
    (e) => e.status === 403,
  );
  // The child cannot escape the inherited ceiling by editing its own policy.
  const childAdmitted = hub.applyAccessPolicy(childSession);
  assert.equal(childAdmitted.administrator, false);
  assert.throws(
    () => hub.setAccessPolicy(childAdmitted, allPolicy(minted.principal)),
    (e) => e.status === 403,
  );
  // Revoking the parent connection denies the child even in all mode.
  hub.revokeConnection(owner, admin.id);
  const minted2 = await hub.createConnection(
    owner,
    workspace,
    "sibling",
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  assert.equal(
    hub.state.accessPolicies.find((p) => p.principal === minted2.principal)
      .delegatedFrom,
    undefined,
  );
  assert.throws(
    () => hub.request(childSession, first, "device.health", {}, "c3"),
    (e) => e.status === 403,
  );
  // Queued child work is cancelled at dispatch because the parent is gone.
  assert.equal(hub.next(first), null);
  assert.equal(
    hub.state.actions.find(
      (a) => a.clientKey === JSON.stringify([childSession.id, "c1"]),
    ).status,
    "cancelled",
  );
});

test("expired parent policy, deleted policy parent and pruned parent connection deny children", async () => {
  let now = 1_000_000;
  const hub = new Hub(emptyState(), () => now);
  const deviceId = await device(hub);
  const { connection: parent, principal: parentSession } = await agentConnection(hub, "parent");
  const child = await hub.createConnection(
    owner,
    workspace,
    "child",
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
    parent.principal,
  );
  assert.equal(
    hub.state.accessPolicies.find((p) => p.principal === child.principal).delegatedFrom,
    parent.principal,
  );
  const childSession = await hub.authenticateConnection(child.token, workspace);
  assert.equal(hub.request(childSession, deviceId, "led.set", { on: true }, "e1").status, "queued");
  // Active legacy grant plus expired parent policy denies the child.
  hub.grant(owner, child.principal, deviceId, ["led.set"], null);
  now += 10_000;
  hub.setAccessPolicy(owner, {
    ...allPolicy(parent.principal),
    expiresAt: now - 1,
  });
  assert.throws(
    () => hub.request(childSession, deviceId, "led.set", { on: true }, "e2"),
    (e) => e.status === 403,
  );
  assert.deepEqual(hub.effectiveAccess(childSession).deviceIds, []);
  // Deleted policy parent denies.
  hub.state.accessPolicies = hub.state.accessPolicies.filter(
    (p) => p.principal !== parent.principal,
  );
  assert.throws(
    () => hub.request(childSession, deviceId, "device.health", {}, "e3"),
    (e) => e.status === 403,
  );
  // Pruned connection parent denies: recreate a live parent policy without a
  // connection record by expiring and pruning the connection.
  const parent2 = await hub.createConnection(
    owner,
    workspace,
    "parent2",
    60,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  const child2 = await hub.createConnection(
    owner,
    workspace,
    "child2",
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
    parent2.principal,
  );
  const child2Session = await hub.authenticateConnection(child2.token, workspace);
  assert.equal(
    hub.request(child2Session, deviceId, "device.health", {}, "e4").status,
    "queued",
  );
  now += 100_000;
  hub.createConnection(owner, workspace, "prune-trigger", null, "act", {
    canAttach: false,
    deviceLimit: 0,
  }, "agent");
  assert.equal(
    hub.state.agentConnections.some((c) => c.principal === parent2.principal),
    false,
  );
  assert.throws(
    () => hub.request(child2Session, deviceId, "device.health", {}, "e5"),
    (e) => e.status === 403,
  );
});

test("expired own policy denies even with active legacy grants", async () => {
  let now = 1_000_000;
  const hub = new Hub(emptyState(), () => now);
  const deviceId = await device(hub);
  const { connection, principal } = await agentConnection(hub);
  // Simulate a pre-upgrade principal: no policy record, grants are the
  // only source of access.
  hub.state.accessPolicies = hub.state.accessPolicies.filter(
    (p) => p.principal !== connection.principal,
  );
  hub.grant(owner, principal.id, deviceId, ["led.set"], null);
  assert.equal(
    hub.request(principal, deviceId, "led.set", { on: true }, "o1").status,
    "queued",
  );
  hub.setAccessPolicy(owner, {
    ...allPolicy(connection.principal, { mode: "selected" }),
    expiresAt: now - 1,
  });
  // The presence of an expired explicit policy denies; grants never revive.
  assert.throws(
    () => hub.request(principal, deviceId, "led.set", { on: true }, "o2"),
    (e) => e.status === 403,
  );
  assert.equal(hub.list(principal).length, 0);
  // Expired constraint policies deny as well.
  hub.setAccessPolicy(owner, allPolicy("agent:member"));
  const member = { id: "agent:member", owner: false, accessConstraints: [connection.principal] };
  assert.throws(
    () => hub.request(member, deviceId, "led.set", { on: true }, "o3"),
    (e) => e.status === 403,
  );
});

test("access constraints intersect member access with client policies", async () => {
  const hub = new Hub(emptyState());
  const first = await device(hub, "one");
  const second = await device(hub, "two");
  hub.setAccessPolicy(owner, allPolicy("agent:member"));
  hub.setAccessPolicy(owner, allPolicy("client-fixture", {
    excludedDevices: [second],
    excludedFunctions: [{ deviceId: null, capability: "led.set" }],
  }));
  const member = { id: "agent:member", owner: false, accessConstraints: ["client-fixture"] };
  const access = hub.effectiveAccess(member);
  assert.deepEqual(access.excludedDevices, [second]);
  assert.deepEqual(access.evaluatedConstraints, ["client-fixture"]);
  assert.equal(access.deviceIds.includes(first), true);
  assert.equal(access.deviceIds.includes(second), false);
  assert.equal(hub.list(member).length, 1);
  assert.equal(hub.request(member, first, "device.health", {}, "m1").status, "queued");
  assert.throws(
    () => hub.request(member, first, "led.set", { on: true }, "m2"),
    (e) => e.status === 403,
  );
  assert.throws(
    () => hub.request(member, second, "device.health", {}, "m3"),
    (e) => e.status === 403,
  );
  // Constraints without any explicit policy stay admission/scope only.
  hub.setAccessPolicy(owner, allPolicy("agent:member2"));
  const member2 = { id: "agent:member2", owner: false, accessConstraints: ["unknown-client"] };
  const third = await device(hub, "three");
  assert.equal(hub.request(member2, third, "led.set", { on: true }, "m4").status, "queued");
  // Constraints persist on actions and deny dispatch after tightening.
  const action = hub.request(member, first, "device.health", {}, "m5");
  hub.setAccessPolicy(owner, allPolicy("client-fixture", { excludedDevices: [first] }));
  assert.equal(action.status, "cancelled");
  assert.equal(hub.next(first), null);
});

test("applyAccessPolicy caps administrator role by delegation ancestors and constraints", async () => {
  const hub = new Hub(emptyState());
  const { connection: admin, principal: adminSession } = await agentConnection(hub, "admin");
  hub.setAccessPolicy(owner, allPolicy(admin.principal, { role: "administrator" }));
  assert.equal(hub.applyAccessPolicy(adminSession).administrator, true);
  hub.setAccessPolicy(owner, allPolicy(admin.principal, { role: "operator" }));
  const demoted = hub.applyAccessPolicy({ ...adminSession, administrator: true });
  assert.equal(demoted.administrator, false);
  // Constraint with an explicit operator policy caps the member role.
  hub.setAccessPolicy(owner, allPolicy("client-fixture", { role: "operator" }));
  hub.setAccessPolicy(owner, allPolicy("agent:member", { role: "administrator" }));
  const member = { id: "agent:member", owner: false, accessConstraints: ["client-fixture"] };
  assert.equal(hub.applyAccessPolicy(member).administrator, false);
  // Member without constraints keeps the administrator role.
  assert.equal(hub.applyAccessPolicy({ id: "agent:member", owner: false }).administrator, true);
});

test("builtin OAuth clients default to all only in new workspaces, preserving explicit policies", async () => {
  const hub = new Hub(emptyState());
  assert.equal(hub.state.agentAccessDefault, "all");
  const deviceId = await device(hub);
  const builtin = hub.admitOAuthClient(
    { id: "builtin-client", owner: false, oauthClient: true },
    ["builtin-client"],
  );
  assert.equal(builtin.owner, false);
  const policy = hub.state.accessPolicies.find((p) => p.principal === "builtin-client");
  assert.deepEqual(policy, allPolicy("builtin-client"));
  assert.equal(hub.list(builtin).length, 1);
  assert.equal(hub.request(builtin, deviceId, "device.health", {}, "b1").status, "queued");
  // Existing explicit policies are preserved on re-admission.
  hub.setAccessPolicy(owner, allPolicy("builtin-client", { excludedDevices: [deviceId] }));
  hub.admitOAuthClient(
    { id: "builtin-client", owner: false, oauthClient: true },
    ["builtin-client"],
  );
  assert.deepEqual(
    hub.state.accessPolicies.find((p) => p.principal === "builtin-client").excludedDevices,
    [deviceId],
  );
  // Legacy workspace (selected default) never expands built-in clients.
  const legacyState = emptyState();
  legacyState.agentAccessDefault = "selected";
  const legacy = new Hub(legacyState);
  const legacyDevice = await device(legacy);
  const legacyBuiltin = legacy.admitOAuthClient(
    {
      id: "builtin-client",
      owner: false,
      oauthClient: true,
    },
    ["builtin-client"],
  );
  assert.equal(legacy.state.accessPolicies.length, 0);
  assert.equal(legacy.list(legacyBuiltin).length, 0);
  assert.throws(
    () => legacy.request(legacyBuiltin, legacyDevice, "device.health", {}, "b2"),
    (e) => e.status === 403,
  );
});

test("newly registered OAuth clients default to all; pre-upgrade records keep grants", async () => {
  const hub = new Hub(emptyState());
  const deviceId = await device(hub);
  const client = hub.registerOAuthClient(
    owner,
    {
      name: "Executor",
      redirectUris: ["https://v2.executor.sh/api/oauth/callback"],
      public: true,
      access: "act",
    },
    {
      applicationId: "oapp_1",
      clientId: "client-1",
      redirectUris: ["https://v2.executor.sh/api/oauth/callback"],
      public: true,
    },
  );
  assert.equal(
    hub.state.accessPolicies.find((p) => p.principal === client.principal).mode,
    "all",
  );
  const admitted = hub.admitOAuthClient({
    id: client.principal,
    owner: false,
    oauthClient: true,
  });
  assert.equal(hub.list(admitted).length, 1);
  assert.equal(hub.request(admitted, deviceId, "led.set", { on: true }, "n1").status, "queued");
  // Pre-upgrade registration without a policy keeps grant-only behavior.
  const preUpgrade = JSON.parse(JSON.stringify(hub.state));
  preUpgrade.accessPolicies = preUpgrade.accessPolicies.filter(
    (p) => p.principal !== client.principal,
  );
  const restored = new Hub(preUpgrade);
  const restoredAdmitted = restored.admitOAuthClient({
    id: client.principal,
    owner: false,
    oauthClient: true,
  });
  assert.equal(restored.list(restoredAdmitted).length, 0);
});

test("policy changes cancel violating queued actions and cycles fail closed", async () => {
  const hub = new Hub(emptyState());
  const deviceId = await device(hub);
  const { connection, principal } = await agentConnection(hub);
  const action = hub.request(principal, deviceId, "led.set", { on: true }, "q1");
  // Switching to selected without grants cancels the queued action.
  hub.setAccessPolicy(owner, allPolicy(connection.principal, { mode: "selected" }));
  assert.equal(action.status, "cancelled");
  // Delegation cycles are rejected at write time and fail closed at runtime.
  const { connection: a } = await agentConnection(hub, "a");
  const { connection: b } = await agentConnection(hub, "b");
  hub.setAccessPolicy(owner, { ...allPolicy(a.principal), delegatedFrom: b.principal });
  assert.throws(
    () =>
      hub.setAccessPolicy(owner, { ...allPolicy(b.principal), delegatedFrom: a.principal }),
    (e) => e.status === 400,
  );
});

test("access policies and defaults persist through SQLite across restarts", async () => {
  const harness = () => {
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec(query, ...bindings) {
        const trimmed = query.trim();
        if (/^(SELECT|PRAGMA)/i.test(trimmed))
          return { toArray: () => db.prepare(query).all(...bindings) };
        db.prepare(query).run(...bindings);
        return { toArray: () => [] };
      },
      db,
    };
    const kv = new Map();
    const storage = {
      async get(key) {
        const value = kv.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      async put(key, value) {
        kv.set(key, structuredClone(value));
      },
      transactionSync(operation) {
        db.exec("BEGIN");
        try {
          const result = operation();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      kv,
    };
    return { sql, storage, close: () => db.close() };
  };

  // Fresh workspace: seeded all, policies persist across restart.
  {
    const h = harness();
    const deviceId = await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      device(hub),
    );
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.setAccessPolicy(owner, allPolicy("agent:member", { excludedDevices: [deviceId] })),
    );
    const result = await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => ({
      default: hub.state.agentAccessDefault,
      policies: hub.accessPolicies(owner),
      list: hub.list({ id: "agent:member", owner: false }).map((d) => d.id),
    }));
    assert.equal(result.default, "all");
    assert.deepEqual(
      result.policies.find((p) => p.principal === "agent:member").excludedDevices,
      [deviceId],
    );
    assert.deepEqual(result.list, []);
    h.close();
  }

  // Pre-existing legacy KV workspace: selected default, no silent expansion.
  {
    const h = harness();
    h.storage.kv.set("state", {
      version: 1,
      devices: [
        {
          id: "device-1",
          name: "legacy",
          kind: "raspberry-pi-4",
          capabilities: ["device.health"],
          tokenHash: "hash",
          revoked: false,
          lastSeen: 1,
        },
      ],
      actions: [],
      enrollments: [],
      grants: [],
      audit: [],
    });
    const result = await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => {
      const builtin = hub.admitOAuthClient(
        {
          id: "builtin-client",
          owner: false,
          oauthClient: true,
        },
        ["builtin-client"],
      );
      return {
        default: hub.state.agentAccessDefault,
        installed: hub.state.accessPolicies.length,
        list: hub.list(builtin).length,
      };
    });
    assert.equal(result.default, "selected");
    assert.equal(result.installed, 0);
    assert.equal(result.list, 0);
    // The marker survives reconstruction.
    const again = await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.state.agentAccessDefault,
    );
    assert.equal(again, "selected");
    h.close();
  }

  // Fresh workspace keeps its all default after restart.
  {
    const h = harness();
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => hub.state.agentAccessDefault);
    const again = await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.state.agentAccessDefault,
    );
    assert.equal(again, "all");
    h.close();
  }
});
