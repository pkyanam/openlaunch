import { z } from "zod";
export const kinds = ["uno-r4-wifi", "raspberry-pi-4"] as const;
const boundedText = z
  .string()
  .max(96)
  .regex(/^[\p{L}\p{N}\p{P}\p{Zs}]*$/u);
export const capabilitySchemas = {
  "device.health": z.object({}).strict(),
  "display.text": z.object({ text: boundedText }).strict(),
  "led.set": z.object({ on: z.boolean() }).strict(),
} as const;
export type Capability = keyof typeof capabilitySchemas;
export const manifestSchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: z.enum(kinds),
    capabilities: z
      .array(z.enum(["device.health", "display.text", "led.set"]))
      .min(1)
      .max(3),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Status =
  | "queued"
  | "received"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled"
  | "unknown";
export interface Device extends Manifest {
  id: string;
  tokenHash: string;
  revoked: boolean;
  lastSeen: number;
}
export interface Action {
  id: string;
  deviceId: string;
  capability: Capability;
  args: Record<string, unknown>;
  status: Status;
  createdAt: number;
  expiresAt: number;
  dispatchedAt?: number;
  result?: unknown;
  clientKey: string;
  fingerprint: string;
  principalId: string;
  ownerAuthorized: boolean;
}
interface Enrollment {
  hash: string;
  expiresAt: number;
  used: boolean;
  kind: Manifest["kind"];
}
interface Grant {
  principal: string;
  deviceId: string;
  capabilities: Capability[];
  expiresAt: number;
}
export interface State {
  version: 1;
  devices: Device[];
  actions: Action[];
  enrollments: Enrollment[];
  grants: Grant[];
  audit: { at: number; event: string; target: string; principal: string }[];
}
export interface Principal {
  id: string;
  owner: boolean;
  readOnly?: boolean;
}
export class Fault extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function emptyState(): State {
  return {
    version: 1,
    devices: [],
    actions: [],
    enrollments: [],
    grants: [],
    audit: [],
  };
}
export const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : value,
  );
export class Hub {
  constructor(
    public state: State = emptyState(),
    private now: () => number = Date.now,
  ) {
    if (state.version !== 1) throw new Error("Unsupported state version");
  }
  private audit(event: string, target: string, principal: string) {
    this.state.audit.push({ at: this.now(), event, target, principal });
    this.state.audit = this.state.audit.slice(-1000);
  }
  private owner(p: Principal) {
    if (!p.owner) throw new Fault("forbidden", 403, "Owner session required");
  }
  private device(id: string) {
    const d = this.state.devices.find((d) => d.id === id);
    if (!d || d.revoked)
      throw new Fault("not_found", 404, "Device not found or revoked");
    return d;
  }
  private allowed(p: Principal, d: string, c: Capability) {
    this.device(d);
    if (p.owner) return;
    if (
      !this.state.grants.some(
        (g) =>
          g.principal === p.id &&
          g.deviceId === d &&
          g.capabilities.includes(c) &&
          g.expiresAt > this.now(),
      )
    )
      throw new Fault("forbidden", 403, "Capability grant required");
  }
  private expire() {
    for (const a of this.state.actions) {
      if (
        (a.status === "queued" || a.status === "received") &&
        a.expiresAt <= this.now()
      )
        a.status = a.dispatchedAt ? "unknown" : "expired";
    }
  }
  list(p: Principal) {
    return this.state.devices
      .filter(
        (d) =>
          !d.revoked &&
          (p.owner ||
            this.state.grants.some(
              (g) =>
                g.principal === p.id &&
                g.deviceId === d.id &&
                g.expiresAt > this.now(),
            )),
      )
      .map(({ tokenHash, ...d }) => ({
        ...d,
        online: this.now() - d.lastSeen < 45000,
      }));
  }
  async enrollment(p: Principal, kind: Manifest["kind"]) {
    this.owner(p);
    if (!kinds.includes(kind))
      throw new Fault("invalid", 400, "Unsupported device kind");
    const token = secret();
    this.state.enrollments = this.state.enrollments.filter(
      (e) => !e.used && e.expiresAt > this.now(),
    );
    if (this.state.enrollments.length >= 10)
      throw new Fault("limit", 429, "Too many pending enrollments");
    this.state.enrollments.push({
      hash: await hash(token),
      expiresAt: this.now() + 600000,
      used: false,
      kind,
    });
    this.audit("enrollment.created", kind, p.id);
    return { token, expiresInSeconds: 600 };
  }
  async enroll(token: string, input: unknown) {
    const m = manifestSchema.parse(input);
    const tokenHash = await hash(token);
    const e = this.state.enrollments.find(
      (e) => e.hash === tokenHash && !e.used && e.expiresAt > this.now(),
    );
    if (!e || e.kind !== m.kind)
      throw new Fault(
        "invalid_enrollment",
        403,
        "Enrollment expired, consumed, or wrong device kind",
      );
    if (this.state.devices.filter((d) => !d.revoked).length >= 20)
      throw new Fault("limit", 429, "Device limit reached");
    const credential = secret();
    const d: Device = {
      ...m,
      id: crypto.randomUUID(),
      tokenHash: await hash(credential),
      revoked: false,
      lastSeen: this.now(),
    };
    e.used = true;
    this.state.devices.push(d);
    this.audit("device.enrolled", d.id, "device");
    return { deviceId: d.id, token: credential };
  }
  async authenticateDevice(id: string, token: string) {
    const d = this.device(id);
    if (!token || (await hash(token)) !== d.tokenHash)
      throw new Fault("unauthorized", 401, "Invalid device credential");
    return d;
  }
  grant(
    p: Principal,
    principal: string,
    id: string,
    capabilities: Capability[],
    ttlSeconds = 3600,
  ) {
    this.owner(p);
    const d = this.device(id);
    if (
      !principal ||
      principal.length > 128 ||
      capabilities.length > 3 ||
      !capabilities.every((c) => d.capabilities.includes(c)) ||
      ttlSeconds < 1 ||
      ttlSeconds > 86400
    )
      throw new Fault("invalid", 400, "Invalid grant");
    this.state.grants = this.state.grants.filter(
      (g) => g.principal !== principal || g.deviceId !== id,
    );
    this.state.grants.push({
      principal,
      deviceId: id,
      capabilities,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    this.audit("grant.updated", id, p.id);
    return { ok: true };
  }
  revokeGrant(p: Principal, principal: string, id: string) {
    this.owner(p);
    this.state.grants = this.state.grants.filter(
      (g) => g.principal !== principal || g.deviceId !== id,
    );
    for (const a of this.state.actions)
      if (
        a.deviceId === id &&
        a.status === "queued" &&
        a.principalId === principal
      )
        a.status = "cancelled";
    this.audit("grant.revoked", id, p.id);
    return { ok: true };
  }
  revoke(p: Principal, id: string) {
    this.owner(p);
    const d = this.device(id);
    d.revoked = true;
    this.state.grants = this.state.grants.filter((g) => g.deviceId !== id);
    for (const a of this.state.actions)
      if (
        a.deviceId === id &&
        (a.status === "queued" || a.status === "received")
      )
        a.status = a.dispatchedAt ? "unknown" : "cancelled";
    this.audit("device.revoked", id, p.id);
    return { ok: true };
  }
  request(
    p: Principal,
    id: string,
    capability: Capability,
    args: unknown,
    key: string,
    ttlSeconds = 30,
  ) {
    this.expire();
    if (p.readOnly && capability !== "device.health")
      throw new Fault("forbidden", 403, "Write scope required");
    this.allowed(p, id, capability);
    const d = this.device(id);
    if (!d.capabilities.includes(capability))
      throw new Fault("unsupported", 400, "Device capability unavailable");
    if (
      !key ||
      key.length > 128 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > 300
    )
      throw new Fault(
        "invalid",
        400,
        "Idempotency key and bounded TTL required",
      );
    const parsed = capabilitySchemas[capability].parse(args);
    const clientKey = JSON.stringify([p.id, key]);
    const fingerprint = canonical({ id, capability, args: parsed, ttlSeconds });
    const old = this.state.actions.find((a) => a.clientKey === clientKey);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Fault(
          "conflict",
          409,
          "Idempotency key reused with different arguments",
        );
      return old;
    }
    if (this.now() - d.lastSeen >= 45000)
      throw new Fault("offline", 409, "Device offline; no action queued");
    if (this.state.actions.length >= 5000)
      throw new Fault(
        "limit",
        429,
        "Action retention limit reached; export/archive before continuing",
      );
    const a: Action = {
      id: crypto.randomUUID(),
      deviceId: id,
      capability,
      args: parsed,
      status: "queued",
      createdAt: this.now(),
      expiresAt: this.now() + ttlSeconds * 1000,
      clientKey,
      fingerprint,
      principalId: p.id,
      ownerAuthorized: p.owner,
    };
    this.state.actions.push(a);
    this.audit("action.queued", a.id, p.id);
    return a;
  }
  get(p: Principal, id: string) {
    this.expire();
    const a = this.state.actions.find((a) => a.id === id);
    if (!a) throw new Fault("not_found", 404, "Action not found");
    this.allowed(p, a.deviceId, a.capability);
    return a;
  }
  cancel(p: Principal, id: string) {
    if (p.readOnly) throw new Fault("forbidden", 403, "Write scope required");
    const a = this.get(p, id);
    if (a.status !== "queued")
      throw new Fault(
        "conflict",
        409,
        "Only undispatched actions can be cancelled",
      );
    a.status = "cancelled";
    this.audit("action.cancelled", id, p.id);
    return a;
  }
  next(deviceId: string) {
    this.expire();
    const d = this.device(deviceId);
    d.lastSeen = this.now();
    const a = this.state.actions.find(
      (a) => a.deviceId === deviceId && a.status === "queued",
    );
    if (!a) return null;
    const principal = a.principalId;
    if (
      !this.state.grants.some(
        (g) =>
          g.principal === principal &&
          g.deviceId === deviceId &&
          g.capabilities.includes(a.capability) &&
          g.expiresAt > this.now(),
      ) &&
      !a.ownerAuthorized
    ) {
      a.status = "cancelled";
      return null;
    }
    a.status = "received";
    a.dispatchedAt = this.now();
    this.audit("action.dispatched", a.id, "device");
    const { clientKey, fingerprint, principalId, ownerAuthorized, ...command } =
      a;
    return command;
  }
  result(
    deviceId: string,
    id: string,
    status: "succeeded" | "failed",
    result: unknown,
  ) {
    this.expire();
    this.device(deviceId).lastSeen = this.now();
    const a = this.state.actions.find(
      (a) => a.id === id && a.deviceId === deviceId,
    );
    if (!a) throw new Fault("not_found", 404, "Action not found");
    if (a.status === status && canonical(a.result) === canonical(result))
      return a;
    if (a.status !== "received")
      throw new Fault(
        "conflict",
        409,
        "No dispatched action can accept this result",
      );
    const encoded = JSON.stringify(result);
    if (encoded === undefined)
      throw new Fault("invalid", 400, "JSON result required");
    if (encoded.length > 4096)
      throw new Fault("too_large", 413, "Result too large");
    a.status = status;
    a.result = result;
    this.audit("action." + status, a.id, "device");
    return a;
  }
}
