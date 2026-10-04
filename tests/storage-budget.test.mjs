import test from "node:test";
import assert from "node:assert/strict";
import { Fault, emptyState } from "../packages/core/src/index.ts";
import {
  ACTION_METADATA_RESERVE_BYTES,
  AUDIT_RING_RESERVE_BYTES,
  PENDING_RESULT_RESERVE_BYTES,
  RECORD_OVERHEAD_BYTES,
  WORKSPACE_STORAGE_BUDGET_BYTES,
  assertWorkspaceStorageBudget,
  assertWorkspaceStorageBudgetDelta,
  workspaceStorageCharge,
} from "../packages/core/src/storage-budget.ts";

const action = (overrides = {}) => ({
  id: "action-1",
  deviceId: "device-1",
  capability: "device.health",
  args: {},
  status: "queued",
  createdAt: 1,
  expiresAt: 60_000,
  clientKey: "request-1",
  fingerprint: "fingerprint",
  principalId: "owner",
  ownerAuthorized: true,
  ...overrides,
});

test("charges UTF-8 row JSON, fixed row overhead, audit ring, and pending action reserve", () => {
  const state = emptyState();
  const emptyCharge = workspaceStorageCharge(state);
  assert.equal(emptyCharge, AUDIT_RING_RESERVE_BYTES);

  const pending = action();
  state.actions.push(pending);
  const base = { ...pending };
  delete base.status;
  delete base.dispatchedAt;
  delete base.result;
  const expectedActionCharge =
    Buffer.byteLength(JSON.stringify(base), "utf8") +
    ACTION_METADATA_RESERVE_BYTES +
    PENDING_RESULT_RESERVE_BYTES;
  assert.equal(
    workspaceStorageCharge(state) - emptyCharge,
    expectedActionCharge,
  );

  state.devices.push({
    id: "d",
    name: "device",
    kind: "test",
    capabilities: [],
    tokenHash: "h",
    revoked: false,
    lastSeen: 0,
  });
  assert.equal(
    workspaceStorageCharge(state) - emptyCharge - expectedActionCharge,
    Buffer.byteLength(JSON.stringify(state.devices[0]), "utf8") +
      RECORD_OVERHEAD_BYTES,
  );
});

test("enqueue charge rejects the first byte over budget without a huge fixture", () => {
  const before = WORKSPACE_STORAGE_BUDGET_BYTES - 100;
  assertWorkspaceStorageBudgetDelta(before, WORKSPACE_STORAGE_BUDGET_BYTES);
  assert.throws(
    () =>
      assertWorkspaceStorageBudgetDelta(
        before,
        WORKSPACE_STORAGE_BUDGET_BYTES + 1,
      ),
    (error) => error instanceof Fault && error.status === 429,
  );
});

test("a 4096 UTF-16-unit Unicode result fits its pending reservation", () => {
  const before = emptyState();
  const pending = action();
  before.actions.push(pending);
  const after = structuredClone(before);
  after.actions[0].status = "succeeded";
  after.actions[0].result = "\u0800".repeat(4094);
  const encodedResult = JSON.stringify(after.actions[0].result);
  assert.equal(encodedResult.length, 4096);
  assert.ok(Buffer.byteLength(encodedResult, "utf8") <= 12 * 1024);
  const checked = assertWorkspaceStorageBudget(before, after, {
    mode: "drain",
  });
  assert.ok(checked.afterBytes < checked.beforeBytes);
  assert.ok(
    checked.beforeBytes - checked.afterBytes >=
      PENDING_RESULT_RESERVE_BYTES - 12 * 1024,
  );
});

test("grant and device growth are charged while remaining within the budget", () => {
  const before = emptyState();
  const after = structuredClone(before);
  after.grants.push({
    principal: "agent-1",
    deviceId: "device-1",
    capabilities: ["device.health"],
    expiresAt: 1000,
  });
  after.devices.push({
    id: "device-1",
    name: "fixture",
    kind: "test",
    capabilities: ["device.health"],
    tokenHash: "hash",
    revoked: false,
    lastSeen: 1,
  });
  const measured = assertWorkspaceStorageBudget(before, after);
  assert.ok(measured.afterBytes > measured.beforeBytes);
  assert.ok(measured.afterBytes < WORKSPACE_STORAGE_BUDGET_BYTES);
});

test("admitted pending outcomes, revocation, cancellation, and expiry drain within budget", () => {
  const before = emptyState();
  before.devices.push({
    id: "device-1",
    name: "fixture",
    kind: "test",
    capabilities: [],
    tokenHash: "hash",
    revoked: false,
    lastSeen: 1,
  });
  before.grants.push({
    principal: "agent-1",
    deviceId: "device-1",
    capabilities: ["device.health"],
    expiresAt: 1000,
  });
  before.actions.push(
    action(),
    action({ id: "action-2", status: "received" }),
    action({ id: "action-3" }),
  );
  const after = structuredClone(before);
  after.actions[0].status = "cancelled";
  after.actions[1].status = "succeeded";
  after.actions[1].result = "\u0800".repeat(4094);
  after.actions[2].status = "expired";
  after.devices[0].revoked = true;
  after.grants = [];
  after.audit.push({
    at: 100,
    event: "device.revoked",
    target: "device-1",
    principal: "owner",
  });
  const measured = assertWorkspaceStorageBudget(before, after, {
    mode: "drain",
  });
  assert.ok(measured.afterBytes < measured.beforeBytes);
});

test("audit keeps a fixed ring reserve and exact retries do not grow charge", () => {
  const before = emptyState();
  const after = structuredClone(before);
  after.audit = Array.from({ length: 1000 }, (_, at) => ({
    at,
    event: "e",
    target: "t",
    principal: "p",
  }));
  assert.equal(workspaceStorageCharge(before), workspaceStorageCharge(after));
  assertWorkspaceStorageBudgetDelta(
    WORKSPACE_STORAGE_BUDGET_BYTES + 100,
    WORKSPACE_STORAGE_BUDGET_BYTES + 100,
    { mode: "idempotent" },
  );
});

test("over-budget legacy state permits only non-growing drain or exact idempotent replay", () => {
  const over = WORKSPACE_STORAGE_BUDGET_BYTES + 10;
  assertWorkspaceStorageBudgetDelta(over, over - 1, { mode: "drain" });
  assertWorkspaceStorageBudgetDelta(over, over, { mode: "drain" });
  assertWorkspaceStorageBudgetDelta(over, over, { mode: "idempotent" });
  assert.throws(
    () => assertWorkspaceStorageBudgetDelta(over, over, { mode: "dispatch" }),
    (error) => error instanceof Fault && error.status === 429,
  );
  assert.throws(
    () => assertWorkspaceStorageBudgetDelta(over, over + 1, { mode: "drain" }),
    (error) => error instanceof Fault && error.status === 429,
  );
});

async function overBudgetHub() {
  const { Hub } = await import("../packages/core/src/index.ts");
  const owner = { id: "budget-owner", owner: true };
  const hub = new Hub(emptyState(), () => 1000);
  const enrollment = await hub.enrollment(owner, "custom.fixture");
  const paired = await hub.enroll(enrollment.token, {
    name: "budget fixture",
    kind: "custom.fixture",
    capabilities: ["device.health"],
  });
  const connection = await hub.createConnection(
    owner,
    "a".repeat(64),
    "budget fixture",
    3600,
    "act",
    { canAttach: true, deviceLimit: 1 },
  );
  const pendingEnrollment = await hub.enrollment(owner, "custom.fixture");
  const received = hub.request(
    owner,
    paired.deviceId,
    "device.health",
    {},
    "received",
  );
  hub.next(paired.deviceId);
  const queued = hub.request(
    owner,
    paired.deviceId,
    "device.health",
    {},
    "queued",
  );
  // A legacy history containing bounded custom-function arguments. Identical
  // arguments are intentional: accounting charges every durable row separately.
  const args = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`p${i}`, "x".repeat(1024)]),
  );
  const historical = {
    ...received,
    status: "succeeded",
    args,
    fingerprint: JSON.stringify(args),
    result: {},
  };
  const single = emptyState();
  single.actions.push(historical);
  const rowBytes = workspaceStorageCharge(single) - AUDIT_RING_RESERVE_BYTES;
  const count =
    Math.ceil(
      (WORKSPACE_STORAGE_BUDGET_BYTES - workspaceStorageCharge(hub.state)) /
        rowBytes,
    ) + 1;
  for (let i = 0; i < count; i++)
    hub.state.actions.push({
      ...historical,
      id: crypto.randomUUID(),
      clientKey: `legacy-${i}`,
    });
  assert.ok(workspaceStorageCharge(hub.state) > WORKSPACE_STORAGE_BUDGET_BYTES);
  return {
    hub,
    owner,
    paired,
    connection,
    pendingEnrollment,
    received,
    queued,
  };
}

test("core rejects over-cap admissions atomically while preserving retries and received results", async () => {
  const {
    hub,
    owner,
    paired,
    connection,
    pendingEnrollment,
    received,
    queued,
  } = await overBudgetHub();
  const before = {
    devices: hub.state.devices.length,
    actions: hub.state.actions.length,
    grants: hub.state.grants.length,
    attempts: hub.state.attachAttempts.length,
    enrollments: hub.state.enrollments.length,
    audit: hub.state.audit.length,
  };
  const full = (error) =>
    error instanceof Fault &&
    error.code === "storage_full" &&
    error.status === 429;
  assert.throws(
    () => hub.request(owner, paired.deviceId, "device.health", {}, "new"),
    full,
  );
  assert.throws(
    () => hub.grant(owner, "new-agent", paired.deviceId, ["device.health"]),
    full,
  );
  await assert.rejects(
    hub.enroll(pendingEnrollment.token, {
      name: "another",
      kind: "custom.fixture",
      capabilities: ["device.health"],
    }),
    full,
  );
  await assert.rejects(
    hub.attachDevice(
      { id: connection.principal, owner: false },
      "a".repeat(64),
      crypto.randomUUID(),
      {
        name: "another",
        kind: "custom.fixture",
        capabilities: ["device.health"],
      },
      { keyVersion: "v1", derive: async () => "b".repeat(64) },
    ),
    full,
  );
  assert.deepEqual(
    {
      devices: hub.state.devices.length,
      actions: hub.state.actions.length,
      grants: hub.state.grants.length,
      attempts: hub.state.attachAttempts.length,
      enrollments: hub.state.enrollments.length,
      audit: hub.state.audit.length,
    },
    before,
  );
  assert.equal(hub.state.enrollments.find((e) => !e.used).used, false);
  assert.equal(
    hub.request(owner, paired.deviceId, "device.health", {}, "received").id,
    received.id,
  );
  assert.throws(
    () =>
      hub.request(owner, paired.deviceId, "device.health", {}, "received", 60),
    (error) => error.code === "conflict",
  );
  assert.throws(() => hub.next(paired.deviceId), full);
  assert.equal(queued.status, "queued");
  const priorCharge = workspaceStorageCharge(hub.state);
  const result = "\u0800".repeat(4094);
  assert.equal(
    hub.result(paired.deviceId, received.id, "succeeded", result).status,
    "succeeded",
  );
  assert.ok(workspaceStorageCharge(hub.state) < priorCharge);
  assert.equal(
    hub.result(paired.deviceId, received.id, "succeeded", result).id,
    received.id,
  );
  hub.revoke(owner, paired.deviceId);
  assert.equal(queued.status, "cancelled");
});
