import { Fault, type State } from "./index.ts";
import { DESKTOP_RESULT_BYTES, isDesktopScreenshot } from "./limits.ts";

/** Logical encoded-workspace ceiling; independent of SQLite/KV implementation. */
export const WORKSPACE_STORAGE_BUDGET_BYTES = 16 * 1024 * 1024;
export const AUDIT_RING_RESERVE_BYTES = 1024 * 1024;
export const PENDING_RESULT_RESERVE_BYTES = 16 * 1024;
export const ACTION_METADATA_RESERVE_BYTES = 512;
export const RECORD_OVERHEAD_BYTES = 128;

export type StorageBudgetMode =
  "new-work" | "dispatch" | "drain" | "idempotent";

export interface StorageBudgetOptions {
  /**
   * When already over budget, only non-growing drains and exact idempotent
   * replays may proceed. New work and queued dispatch remain blocked.
   */
  mode?: StorageBudgetMode;
}

const encoder = new TextEncoder();
const collections = [
  "devices",
  "enrollments",
  "grants",
  "agentConnections",
  "attachAttempts",
  "retiredActionKeys",
] as const;

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Fault("invalid", 400, "Workspace data must be JSON serializable");
  return encoder.encode(encoded).byteLength;
}

function add(total: number, amount: number): number {
  const next = total + amount;
  if (!Number.isSafeInteger(next))
    throw new Fault("too_large", 429, "Workspace storage budget exceeded");
  return next;
}

/**
 * Estimate durable logical bytes without serializing the complete State at
 * once. Each collection row is measured independently using UTF-8 JSON bytes.
 * Audit reserves its complete bounded ring even when few events exist.
 */
export function workspaceStorageCharge(state: State): number {
  let total = 0;
  for (const collection of collections) {
    const records = state[collection] ?? [];
    for (const record of records)
      total = add(total, jsonBytes(record) + RECORD_OVERHEAD_BYTES);
  }

  const auditBytes = state.audit.reduce(
    (sum, record) => add(sum, jsonBytes(record) + RECORD_OVERHEAD_BYTES),
    0,
  );
  total = add(total, Math.max(AUDIT_RING_RESERVE_BYTES, auditBytes));

  for (const action of state.actions) {
    const {
      status,
      dispatchedAt: _dispatchedAt,
      result,
      ...immutableAction
    } = action;
    let actionCharge = add(
      ACTION_METADATA_RESERVE_BYTES,
      jsonBytes(immutableAction),
    );
    if (status === "queued" || status === "received") {
      const kind =
        state.devices.find((device) => device.id === action.deviceId)?.kind ??
        "";
      actionCharge = add(
        actionCharge,
        isDesktopScreenshot(kind, action.capability)
          ? DESKTOP_RESULT_BYTES
          : PENDING_RESULT_RESERVE_BYTES,
      );
    } else if (result !== undefined) {
      actionCharge = add(actionCharge, jsonBytes(result));
    }
    total = add(total, actionCharge);
  }
  return total;
}

/**
 * Check a precomputed before/after logical byte delta. Over-budget legacy
 * state can drain without growth or replay an exact idempotent request, while
 * new work and queued dispatch fail closed until the workspace is reduced.
 */
export function assertWorkspaceStorageBudgetDelta(
  beforeBytes: number,
  afterBytes: number,
  options: StorageBudgetOptions = {},
): void {
  if (
    !Number.isSafeInteger(beforeBytes) ||
    beforeBytes < 0 ||
    !Number.isSafeInteger(afterBytes) ||
    afterBytes < 0
  )
    throw new Fault(
      "invalid",
      400,
      "Invalid workspace storage budget estimate",
    );

  const mode = options.mode ?? "new-work";
  if (beforeBytes > WORKSPACE_STORAGE_BUDGET_BYTES) {
    if (mode === "drain" && afterBytes <= beforeBytes) return;
    if (mode === "idempotent" && afterBytes === beforeBytes) return;
    throw new Fault(
      "storage_full",
      429,
      "Workspace storage limit reached. New work is paused; received results and history remain available.",
    );
  }
  if (afterBytes > WORKSPACE_STORAGE_BUDGET_BYTES)
    throw new Fault(
      "storage_full",
      429,
      "Workspace storage limit reached. New work is paused; received results and history remain available.",
    );
}

/** Measure both states and reject mutations that would exceed the budget. */
export function assertWorkspaceStorageBudget(
  before: State,
  after: State,
  options: StorageBudgetOptions = {},
): { beforeBytes: number; afterBytes: number } {
  const beforeBytes = workspaceStorageCharge(before);
  const afterBytes = workspaceStorageCharge(after);
  assertWorkspaceStorageBudgetDelta(beforeBytes, afterBytes, options);
  return { beforeBytes, afterBytes };
}
