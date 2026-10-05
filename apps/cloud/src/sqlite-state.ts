import {
  Hub,
  emptyState,
  type State,
} from "../../../packages/core/src/index.ts";

/** The synchronous SQLite surface exposed by Cloudflare Durable Objects. */
export interface WorkspaceSQL {
  exec<
    T extends Record<string, string | number | ArrayBuffer | null> = Record<
      string,
      string | number | ArrayBuffer | null
    >,
  >(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

/** Durable Object storage supplies KV reads plus a transaction spanning SQL. */
export interface WorkspaceSQLiteStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transactionSync<T>(operation: () => T): T;
}

interface StoredRow extends Record<string, string | number> {
  collection: string;
  record_id: string;
  ordinal: number;
  body: string;
}

interface RowToWrite extends StoredRow {}

const schemaVersion = "1";
const metaTable = "openlaunch_meta";
const recordsTable = "openlaunch_records";
const migrationGuard = { version: "sqlite-migrated-v1" } as const;
const collections = [
  "devices",
  "actions",
  "enrollments",
  "grants",
  "agentConnections",
  "attachAttempts",
  "retiredActionKeys",
  "audit",
] as const;

function createSchema(sql: WorkspaceSQL) {
  const found = new Set(
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        metaTable,
        recordsTable,
      )
      .toArray()
      .map((row) => row.name),
  );
  if (!found.has(metaTable))
    sql.exec(
      `CREATE TABLE ${metaTable} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    );
  if (!found.has(recordsTable))
    sql.exec(
      `CREATE TABLE ${recordsTable} (collection TEXT NOT NULL, record_id TEXT NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection, record_id)) WITHOUT ROWID`,
    );
  const hasOrderIndex =
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        "openlaunch_records_order",
      )
      .toArray().length > 0;
  if (!hasOrderIndex)
    sql.exec(
      `CREATE INDEX openlaunch_records_order ON ${recordsTable} (collection, ordinal, record_id)`,
    );
}

function normalizeState(value: unknown): State {
  if (!value || typeof value !== "object" || (value as State).version !== 1)
    throw new Error(
      "Unsupported workspace state version; refusing to continue",
    );
  const state = value as State;
  if (
    Object.keys(state).some(
      (key) =>
        key !== "version" &&
        !collections.includes(key as (typeof collections)[number]),
    )
  )
    throw new Error("Unknown legacy workspace field; refusing to discard data");
  for (const collection of [
    "devices",
    "actions",
    "enrollments",
    "grants",
    "audit",
  ] as const)
    if (!Array.isArray(state[collection]))
      throw new Error(
        `Invalid legacy workspace state collection: ${collection}`,
      );
  state.agentConnections ??= [];
  state.attachAttempts ??= [];
  state.retiredActionKeys ??= [];
  if (
    !Array.isArray(state.agentConnections) ||
    !Array.isArray(state.attachAttempts) ||
    !Array.isArray(state.retiredActionKeys)
  )
    throw new Error("Invalid legacy workspace optional collections");
  return state;
}

function recordKey(
  collection: string,
  value: unknown,
  ordinal: number,
): string {
  const item = value as Record<string, unknown>;
  switch (collection) {
    case "retiredActionKeys":
      return typeof value === "string" ? value : invalidKey(collection);
    case "devices":
    case "actions":
    case "agentConnections":
      return typeof item.id === "string" ? item.id : invalidKey(collection);
    case "enrollments":
      return typeof item.hash === "string" ? item.hash : invalidKey(collection);
    case "grants":
      return typeof item.principal === "string" &&
        typeof item.deviceId === "string"
        ? JSON.stringify([item.principal, item.deviceId])
        : invalidKey(collection);
    case "attachAttempts":
      return typeof item.connectionId === "string" &&
        typeof item.requestId === "string"
        ? JSON.stringify([item.connectionId, item.requestId])
        : invalidKey(collection);
    case "audit":
      return crypto.randomUUID();
    default:
      throw new Error(`Unknown workspace state collection: ${collection}`);
  }
}

function invalidKey(collection: string): never {
  throw new Error(
    `Invalid record identifier in workspace state collection: ${collection}`,
  );
}

function stateCollections(state: State): Array<[string, unknown[]]> {
  return [
    ["devices", state.devices],
    ["actions", state.actions],
    ["enrollments", state.enrollments],
    ["grants", state.grants],
    ["agentConnections", state.agentConnections ?? []],
    ["attachAttempts", state.attachAttempts ?? []],
    ["retiredActionKeys", state.retiredActionKeys ?? []],
    ["audit", state.audit],
  ];
}

function loadRows(sql: WorkspaceSQL): {
  state: State;
  existing: Map<string, StoredRow>;
} {
  const rows = sql
    .exec<StoredRow>(
      `SELECT collection, record_id, ordinal, body FROM ${recordsTable} ORDER BY collection, ordinal, record_id`,
    )
    .toArray();
  const byCollection = new Map<
    string,
    Array<{ row: StoredRow; value: unknown }>
  >();
  const existing = new Map<string, StoredRow>();
  const ordinalsByCollection = new Map<string, Set<number>>();
  for (const row of rows) {
    if (!collections.includes(row.collection as (typeof collections)[number]))
      throw new Error(`Unknown SQLite workspace collection: ${row.collection}`);
    const key = `${row.collection}\0${row.record_id}`;
    if (existing.has(key)) throw new Error("Duplicate SQLite workspace record");
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0)
      throw new Error(
        "Invalid SQLite workspace ordering; refusing to continue",
      );
    existing.set(key, row);
    let value: unknown;
    try {
      value = JSON.parse(row.body);
    } catch {
      throw new Error("Invalid SQLite workspace record; refusing to continue");
    }
    const ordinals =
      ordinalsByCollection.get(row.collection) ?? new Set<number>();
    if (ordinals.has(row.ordinal))
      throw new Error(
        `Duplicate SQLite workspace ordering in ${row.collection}`,
      );
    ordinals.add(row.ordinal);
    ordinalsByCollection.set(row.collection, ordinals);
    const validId =
      row.collection === "audit"
        ? typeof row.record_id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.record_id,
          )
        : recordKey(row.collection, value, row.ordinal) === row.record_id;
    if (!validId)
      throw new Error(
        `SQLite workspace record identifier mismatch in ${row.collection}`,
      );
    const collectionRecords = byCollection.get(row.collection) ?? [];
    collectionRecords.push({ row, value });
    byCollection.set(row.collection, collectionRecords);
  }
  const state = emptyState();
  for (const collection of collections) {
    const records = byCollection.get(collection) ?? [];
    const storedCount = sql
      .exec<{ value: string }>(
        `SELECT value FROM ${metaTable} WHERE key = ?`,
        `count:${collection}`,
      )
      .toArray()[0]?.value;
    if (
      !(
        collection === "retiredActionKeys" &&
        storedCount === undefined &&
        records.length === 0
      ) &&
      (storedCount === undefined || storedCount !== String(records.length))
    )
      throw new Error(
        `SQLite workspace record count mismatch in ${collection}`,
      );
    const values = records.map(({ value }) => value) as never[];
    switch (collection) {
      case "devices":
        state.devices = values;
        break;
      case "retiredActionKeys":
        state.retiredActionKeys = values;
        break;
      case "actions":
        state.actions = values;
        break;
      case "enrollments":
        state.enrollments = values;
        break;
      case "grants":
        state.grants = values;
        break;
      case "agentConnections":
        state.agentConnections = values;
        break;
      case "attachAttempts":
        state.attachAttempts = values;
        break;
      case "audit":
        state.audit = values;
        break;
    }
  }
  return { state, existing };
}

function planDiff(
  state: State,
  existing: Map<string, StoredRow>,
): { writes: RowToWrite[]; deletes: string[]; counts: Map<string, number> } {
  const writes: RowToWrite[] = [];
  const nextKeys = new Set<string>();
  const counts = new Map<string, number>();
  for (const [collection, values] of stateCollections(state)) {
    if (collection === "audit") {
      const prior = [...existing.values()]
        .filter((row) => row.collection === collection)
        .sort((left, right) => left.ordinal - right.ordinal);
      let cursor = 0;
      let nextOrdinal =
        prior.reduce((highest, row) => Math.max(highest, row.ordinal), -1) + 1;
      for (const value of values) {
        const body = JSON.stringify(value);
        let match = -1;
        for (let i = cursor; i < prior.length; i++) {
          if (prior[i].body === body) {
            match = i;
            break;
          }
        }
        const old = match < 0 ? undefined : prior[match];
        if (old) cursor = match + 1;
        const row = {
          collection,
          record_id: old?.record_id ?? crypto.randomUUID(),
          ordinal: old?.ordinal ?? nextOrdinal++,
          body,
        };
        nextKeys.add(`${collection}\0${row.record_id}`);
        if (!old || old.body !== body) writes.push(row);
      }
      counts.set(collection, values.length);
      continue;
    }
    values.forEach((value, index) => {
      const id = recordKey(collection, value, index);
      const key = `${collection}\0${id}`;
      if (nextKeys.has(key))
        throw new Error(`Duplicate record identifier in ${collection}`);
      nextKeys.add(key);
      const old = existing.get(key);
      const row = {
        collection,
        record_id: id,
        ordinal: index,
        body: JSON.stringify(value),
      };
      if (!old || old.ordinal !== row.ordinal || old.body !== row.body)
        writes.push(row);
    });
    counts.set(collection, values.length);
  }
  return {
    writes,
    deletes: [...existing.keys()].filter((key) => !nextKeys.has(key)),
    counts,
  };
}

function persistDiff(
  storage: WorkspaceSQLiteStorage,
  sql: WorkspaceSQL,
  existing: Map<string, StoredRow>,
  state: State,
): boolean {
  const { writes, deletes, counts } = planDiff(state, existing);
  if (writes.length === 0 && deletes.length === 0) return false;
  storage.transactionSync(() => {
    for (const row of writes)
      sql.exec(
        `INSERT INTO ${recordsTable} (collection, record_id, ordinal, body) VALUES (?, ?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET ordinal = excluded.ordinal, body = excluded.body`,
        row.collection,
        row.record_id,
        row.ordinal,
        row.body,
      );
    for (const key of deletes) {
      const [collection, recordId] = key.split("\0");
      sql.exec(
        `DELETE FROM ${recordsTable} WHERE collection = ? AND record_id = ?`,
        collection,
        recordId,
      );
    }
    for (const collection of collections) {
      const priorCount = [...existing.values()].filter(
        (row) => row.collection === collection,
      ).length;
      if (priorCount === counts.get(collection)) continue;
      sql.exec(
        `INSERT INTO ${metaTable} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        `count:${collection}`,
        String(counts.get(collection) ?? 0),
      );
    }
  });
  // Keep the in-memory baseline aligned only after the complete SQL
  // transaction commits. A failed transaction leaves it untouched.
  for (const key of deletes) existing.delete(key);
  for (const row of writes)
    existing.set(`${row.collection}\0${row.record_id}`, row);
  return true;
}

async function loadOrMigrate(
  storage: WorkspaceSQLiteStorage,
  sql: WorkspaceSQL,
): Promise<{ state: State; existing: Map<string, StoredRow> }> {
  createSchema(sql);
  const marker = sql
    .exec<{ value: string }>(
      `SELECT value FROM ${metaTable} WHERE key = ?`,
      "schemaVersion",
    )
    .toArray()[0]?.value;
  if (marker !== undefined) {
    if (marker !== schemaVersion)
      throw new Error(`Unsupported SQLite workspace schema version: ${marker}`);
    await ensureMigrationGuard(storage);
    return loadRows(sql);
  }
  const rowCount =
    sql
      .exec<{ count: number }>(`SELECT count(*) AS count FROM ${recordsTable}`)
      .toArray()[0]?.count ?? 0;
  const metaCount =
    sql
      .exec<{ count: number }>(`SELECT count(*) AS count FROM ${metaTable}`)
      .toArray()[0]?.count ?? 0;
  if (rowCount !== 0 || metaCount !== 0)
    throw new Error(
      "SQLite workspace rows exist without a schema marker; refusing to continue",
    );
  const legacy = await storage.get<State>("state");
  const state =
    legacy === undefined
      ? emptyState()
      : normalizeState(structuredClone(legacy));
  if (legacy !== undefined) {
    const backup = await storage.get<State>("state:legacy-v1");
    if (backup === undefined)
      await storage.put("state:legacy-v1", structuredClone(legacy));
    else if (JSON.stringify(backup) !== JSON.stringify(legacy))
      throw new Error(
        "Legacy workspace changed during migration; refusing to overwrite its backup",
      );
  }
  storage.transactionSync(() => {
    for (const [collection, values] of stateCollections(state)) {
      values.forEach((value, ordinal) => {
        const row: RowToWrite = {
          collection,
          record_id: recordKey(collection, value, ordinal),
          ordinal,
          body: JSON.stringify(value),
        };
        sql.exec(
          `INSERT INTO ${recordsTable} (collection, record_id, ordinal, body) VALUES (?, ?, ?, ?)`,
          row.collection,
          row.record_id,
          row.ordinal,
          row.body,
        );
      });
    }
    sql.exec(
      `INSERT INTO ${metaTable} (key, value) VALUES (?, ?)`,
      "schemaVersion",
      schemaVersion,
    );
    for (const [collection, values] of stateCollections(state))
      sql.exec(
        `INSERT INTO ${metaTable} (key, value) VALUES (?, ?)`,
        `count:${collection}`,
        String(values.length),
      );
  });
  await ensureMigrationGuard(storage);
  return loadRows(sql);
}

async function ensureMigrationGuard(
  storage: WorkspaceSQLiteStorage,
): Promise<void> {
  const current = await storage.get<unknown>("state");
  if (
    current &&
    typeof current === "object" &&
    (current as { version?: unknown }).version === migrationGuard.version
  )
    return;
  const backup = await storage.get<unknown>("state:legacy-v1");
  if (JSON.stringify(current) !== JSON.stringify(backup))
    throw new Error(
      "Legacy workspace changed after SQL import; explicit recovery required",
    );
  await storage.put("state", migrationGuard);
  const verified = await storage.get<{ version?: unknown }>("state");
  if (verified?.version !== migrationGuard.version)
    throw new Error(
      "Workspace migration guard was not saved; refusing new operations",
    );
}

/**
 * Per-Durable-Object hydrated Hub cache. Construct one instance per WorkspaceHub
 * and call it only inside the object's serialized blockConcurrencyWhile path.
 * Hibernation/reconstruction naturally creates a cold cache and revalidates SQL
 * schema plus the legacy KV guard. WebSocket message handling must stay
 * independent; the current handler accepts only socket ping frames.
 */
export class WorkspaceSQLiteStateCache {
  private cached?: { state: State; existing: Map<string, StoredRow> };

  constructor(
    private readonly storage: WorkspaceSQLiteStorage,
    private readonly sql: WorkspaceSQL,
  ) {}

  async withState<T>(operation: (hub: Hub) => Promise<T> | T): Promise<T> {
    let loaded: { state: State; existing: Map<string, StoredRow> } | undefined;
    try {
      loaded = this.cached ?? (await loadOrMigrate(this.storage, this.sql));
      this.cached = loaded;
      const hub = new Hub(loaded.state);
      const result = await operation(hub);
      persistDiff(this.storage, this.sql, loaded.existing, hub.state);
      loaded.state = hub.state;
      this.cached = loaded;
      return result;
    } catch (error) {
      // A failed callback may have mutated its Hub before throwing; a failed
      // persistence transaction must also reload from the committed baseline.
      this.cached = undefined;
      throw error;
    }
  }
}

/** Stateless convenience API for tests and one-shot callers. */
export async function withWorkspaceSQLiteState<T>(
  storage: WorkspaceSQLiteStorage,
  sql: WorkspaceSQL,
  operation: (hub: Hub) => Promise<T> | T,
): Promise<T> {
  return new WorkspaceSQLiteStateCache(storage, sql).withState(operation);
}
