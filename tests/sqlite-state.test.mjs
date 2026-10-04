import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { withWorkspaceState } from "../apps/cloud/src/state.ts";
import { withWorkspaceSQLiteState } from "../apps/cloud/src/sqlite-state.ts";

function createHarness(initial) {
  const db = new DatabaseSync(":memory:");
  let failAt = 0;
  let mutationNumber = 0;
  const mutations = [];
  const sql = {
    exec(query, ...bindings) {
      const trimmed = query.trim();
      if (/^(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)/i.test(trimmed)) {
        mutationNumber++;
        mutations.push({ query: trimmed, bindings });
        if (failAt === mutationNumber)
          throw new Error("injected sqlite write failure");
      }
      if (/^(SELECT|PRAGMA)/i.test(trimmed))
        return { toArray: () => db.prepare(query).all(...bindings) };
      db.prepare(query).run(...bindings);
      return { toArray: () => [] };
    },
    clearMutations() {
      mutations.length = 0;
      mutationNumber = 0;
    },
    failOnMutation(number) {
      failAt = number;
      mutationNumber = 0;
    },
    get mutations() {
      return mutations;
    },
    db,
  };
  const kv = new Map(
    initial === undefined ? [] : [["state", structuredClone(initial)]],
  );
  const storage = {
    reads: [],
    writes: [],
    async get(key) {
      this.reads.push(key);
      const value = kv.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(key, value) {
      if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
        throw new Error("KV value exceeds 2 MiB");
      this.writes.push(key);
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
  return { storage, sql, close: () => db.close() };
}

const device = (lastSeen = 1) => ({
  id: "device-1",
  name: "fixture",
  kind: "raspberry-pi-4",
  capabilities: ["device.health"],
  tokenHash: "hash",
  revoked: false,
  lastSeen,
});
const legacyState = (overrides = {}) => ({
  version: 1,
  devices: [],
  actions: [],
  enrollments: [],
  grants: [],
  agentConnections: [],
  attachAttempts: [],
  audit: [],
  ...overrides,
});

test("stores aggregate state larger than a KV value across SQLite rows", async () => {
  const state = legacyState({
    audit: Array.from({ length: 4 }, (_, i) => ({
      at: i,
      event: "fixture",
      target: "x".repeat(600_000),
      principal: "owner",
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024);
  const h = createHarness();
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => {
      hub.state.audit = state.audit;
    });
    const restored = await withWorkspaceSQLiteState(
      h.storage,
      h.sql,
      (hub) => hub.state.audit,
    );
    assert.deepEqual(restored, state.audit);
    assert.equal(h.storage.kv.get("state:legacy-v1"), undefined);
    assert.deepEqual(h.storage.kv.get("state"), {
      version: "sqlite-migrated-v1",
    });
    assert.equal(
      h.sql
        .exec("SELECT count(*) AS count FROM openlaunch_records")
        .toArray()[0].count,
      4,
    );
  } finally {
    h.close();
  }
});

test("read-only work issues no SQLite or KV writes after migration", async () => {
  const h = createHarness();
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    h.sql.clearMutations();
    h.storage.writes.length = 0;
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    assert.equal(h.sql.mutations.length, 0);
    assert.equal(h.storage.writes.length, 0);
  } finally {
    h.close();
  }
});

test("idle device polling updates only that device record", async () => {
  const h = createHarness(legacyState({ devices: [device(1)] }));
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    h.sql.clearMutations();
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.next("device-1"),
    );
    const inserts = h.sql.mutations.filter(({ query }) =>
      query.startsWith("INSERT INTO openlaunch_records"),
    );
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].bindings[0], "devices");
    assert.equal(h.sql.mutations.length, 1);
    assert.equal(
      h.sql.mutations.filter(({ query }) =>
        query.startsWith("DELETE FROM openlaunch_records"),
      ).length,
      0,
    );
  } finally {
    h.close();
  }
});

test("audit append and cap retain stable row IDs and write only one insert and delete", async () => {
  const audit = Array.from({ length: 1000 }, (_, i) => ({
    at: i === 3 || i === 4 ? 3 : i,
    event: i === 3 || i === 4 ? "duplicate" : "fixture",
    target: i === 3 || i === 4 ? "same" : `target-${i}`,
    principal: "owner",
  }));
  const h = createHarness(legacyState({ audit }));
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    h.sql.clearMutations();
    const appended = {
      at: 1001,
      event: "fixture",
      target: "new",
      principal: "owner",
    };
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => {
      hub.state.audit.push(appended);
      hub.state.audit = hub.state.audit.slice(-1000);
    });
    assert.equal(
      h.sql.mutations.filter(
        ({ query, bindings }) =>
          query.startsWith("INSERT INTO openlaunch_records") &&
          bindings[0] === "audit",
      ).length,
      1,
    );
    assert.equal(
      h.sql.mutations.filter(
        ({ query, bindings }) =>
          query.startsWith("DELETE FROM openlaunch_records") &&
          bindings[0] === "audit",
      ).length,
      1,
    );
    const roundTripped = await withWorkspaceSQLiteState(
      h.storage,
      h.sql,
      (hub) => structuredClone(hub.state.audit),
    );
    assert.deepEqual(roundTripped, [...audit.slice(1), appended]);
    assert.equal(
      roundTripped.filter(
        ({ event, target }) => event === "duplicate" && target === "same",
      ).length,
      2,
    );
  } finally {
    h.close();
  }
});

test("migration backs up legacy KV, guards rollback, and restarts without reading legacy data", async () => {
  const h = createHarness(legacyState({ devices: [device(10)] }));
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    const original = h.storage.kv.get("state:legacy-v1");
    h.storage.reads.length = 0;
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.next("device-1"),
    );
    assert.deepEqual(h.storage.kv.get("state:legacy-v1"), original);
    assert.deepEqual(h.storage.kv.get("state"), {
      version: "sqlite-migrated-v1",
    });
    await assert.rejects(
      withWorkspaceState(h.storage, async () => {}),
      /Unsupported state version/,
    );
    assert.equal(h.storage.reads.includes("state:legacy-v1"), false);
    assert.equal(h.storage.reads.includes("state"), true); // guard verification only
  } finally {
    h.close();
  }
});

test("failed multi-row persistence rolls back atomically", async () => {
  const h = createHarness(legacyState({ devices: [device(1)] }));
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    const before = h.sql
      .exec(
        "SELECT collection, record_id, ordinal, body FROM openlaunch_records ORDER BY collection, ordinal, record_id",
      )
      .toArray();
    h.sql.clearMutations();
    h.sql.failOnMutation(2);
    await assert.rejects(
      withWorkspaceSQLiteState(h.storage, h.sql, (hub) => {
        hub.state.devices[0].lastSeen = 987654;
        hub.state.audit.push({
          at: 1,
          event: "changed",
          target: "device-1",
          principal: "owner",
        });
      }),
      /injected sqlite write failure/,
    );
    const after = h.sql
      .exec(
        "SELECT collection, record_id, ordinal, body FROM openlaunch_records ORDER BY collection, ordinal, record_id",
      )
      .toArray();
    assert.deepEqual(after, before);
  } finally {
    h.close();
  }
});

test("unsupported schema and count corruption fail closed", async () => {
  const h = createHarness();
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    h.sql.exec(
      "UPDATE openlaunch_meta SET value = ? WHERE key = ?",
      "99",
      "schemaVersion",
    );
    await assert.rejects(
      withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
        hub.list({ id: "owner", owner: true }),
      ),
      /Unsupported SQLite workspace schema version/,
    );
  } finally {
    h.close();
  }

  const corrupted = createHarness(legacyState({ devices: [device(1)] }));
  try {
    await withWorkspaceSQLiteState(corrupted.storage, corrupted.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    corrupted.sql.exec(
      "DELETE FROM openlaunch_records WHERE collection = ?",
      "devices",
    );
    await assert.rejects(
      withWorkspaceSQLiteState(corrupted.storage, corrupted.sql, (hub) =>
        hub.list({ id: "owner", owner: true }),
      ),
      /record count mismatch/,
    );
  } finally {
    corrupted.close();
  }
});

test("interrupted guard is repaired before operations and changed legacy state fails closed", async () => {
  for (const changed of [false, true]) {
    const original = legacyState({ devices: [device(1)] });
    const h = createHarness(original);
    const put = h.storage.put.bind(h.storage);
    let operationRan = false;
    try {
      h.storage.put = async (key, value) => {
        if (key === "state") throw new Error("injected guard failure");
        return put(key, value);
      };
      await assert.rejects(
        withWorkspaceSQLiteState(h.storage, h.sql, () => {
          operationRan = true;
        }),
        /guard failure/,
      );
      assert.equal(operationRan, false);
      assert.deepEqual(h.storage.kv.get("state:legacy-v1"), original);
      h.storage.put = put;
      if (changed) {
        const oldWorkerWrite = structuredClone(original);
        oldWorkerWrite.devices[0].revoked = true;
        h.storage.kv.set("state", oldWorkerWrite);
        await assert.rejects(
          withWorkspaceSQLiteState(h.storage, h.sql, () => {
            operationRan = true;
          }),
          /changed after SQL import/,
        );
        assert.equal(operationRan, false);
      } else {
        await withWorkspaceSQLiteState(h.storage, h.sql, () => {
          operationRan = true;
        });
        assert.equal(operationRan, true);
        assert.deepEqual(h.storage.kv.get("state"), {
          version: "sqlite-migrated-v1",
        });
      }
    } finally {
      h.close();
    }
  }
});

test("migration preserves the exact older state shape and refuses unknown fields", async () => {
  const original = legacyState({ devices: [device(1)] });
  delete original.agentConnections;
  delete original.attachAttempts;
  const h = createHarness(original);
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) =>
      hub.list({ id: "owner", owner: true }),
    );
    assert.deepEqual(h.storage.kv.get("state:legacy-v1"), original);
  } finally {
    h.close();
  }
  const unknown = createHarness({
    ...original,
    futureField: { data: "preserve" },
  });
  try {
    await assert.rejects(
      withWorkspaceSQLiteState(unknown.storage, unknown.sql, () => {}),
      /Unknown legacy workspace field/,
    );
    assert.deepEqual(unknown.storage.kv.get("state"), {
      ...original,
      futureField: { data: "preserve" },
    });
  } finally {
    unknown.close();
  }
});

test("migrated device credentials, grants, idempotency and correlated outcomes remain valid", async () => {
  const owner = { id: "owner", owner: true };
  const agent = { id: "agent", owner: false };
  const previous = new Hub(emptyState());
  const enrollment = await previous.enrollment(owner, "custom.device");
  const enrolled = await previous.enroll(enrollment.token, {
    name: "migration fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  previous.grant(owner, agent.id, enrolled.deviceId, ["device.health"], 60);
  const queued = previous.request(
    agent,
    enrolled.deviceId,
    "device.health",
    {},
    "persisted-before-migration",
    60,
  );
  const h = createHarness(previous.state);
  const run = (operation) =>
    withWorkspaceSQLiteState(h.storage, h.sql, operation);
  try {
    await run((hub) =>
      hub.authenticateDevice(enrolled.deviceId, enrolled.token),
    );
    const retried = await run((hub) =>
      hub.request(
        agent,
        enrolled.deviceId,
        "device.health",
        {},
        "persisted-before-migration",
        60,
      ),
    );
    assert.equal(retried.id, queued.id);
    assert.equal(
      (await run((hub) => hub.next(enrolled.deviceId))).id,
      queued.id,
    );
    await run((hub) =>
      hub.result(enrolled.deviceId, queued.id, "succeeded", {
        processHealth: true,
      }),
    );
    const exported = await run((hub) => hub.exportHistory(owner));
    assert.equal(exported.actions.length, 1);
    assert.deepEqual(exported.actions[0].result, { processHealth: true });
    assert.equal(exported.actions[0].status, "succeeded");
    await run((hub) => hub.revoke(owner, enrolled.deviceId));
    await assert.rejects(
      run((hub) => hub.authenticateDevice(enrolled.deviceId, enrolled.token)),
    );
    assert.deepEqual(await run((hub) => hub.list(agent)), []);
    assert.equal(
      (await run((hub) => hub.exportHistory(owner))).actions.length,
      1,
    );
  } finally {
    h.close();
  }
});

test("non-audit collection order survives replacement and pruning", async () => {
  const state = legacyState({
    grants: [
      {
        principal: "first",
        deviceId: "device-1",
        capabilities: ["device.health"],
        expiresAt: 1,
      },
      {
        principal: "second",
        deviceId: "device-1",
        capabilities: ["device.health"],
        expiresAt: 2,
      },
    ],
  });
  const h = createHarness(state);
  try {
    await withWorkspaceSQLiteState(h.storage, h.sql, () => {});
    const changed = [state.grants[1], { ...state.grants[0], expiresAt: 3 }];
    await withWorkspaceSQLiteState(h.storage, h.sql, (hub) => {
      hub.state.grants = changed;
    });
    const restored = await withWorkspaceSQLiteState(
      h.storage,
      h.sql,
      (hub) => hub.state.grants,
    );
    assert.deepEqual(restored, changed);
  } finally {
    h.close();
  }
});
