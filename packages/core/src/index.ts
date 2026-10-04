import { z } from "zod";
import type { ActionEnvelope, ActionState } from "../../protocol/src/index.ts";
import {
  capabilityName,
  functionDefinition,
  functionArguments,
} from "./functions.ts";
export { capabilityName, functionDefinition } from "./functions.ts";
export const kinds = ["uno-r4-wifi", "raspberry-pi-4"] as const;
export const deviceKind = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
export function agentTokenWorkspace(token: string): string | undefined {
  return /^ol_agent_([a-f0-9]{64})_[a-f0-9]{64}$/.exec(token)?.[1];
}
const boundedText = z
  .string()
  .max(96)
  .regex(/^[\p{L}\p{N}\p{P}\p{Zs}]*$/u);
export const capabilitySchemas = {
  "device.health": z.object({}).strict(),
  "display.text": z.object({ text: boundedText }).strict(),
  "led.set": z.object({ on: z.boolean() }).strict(),
} as const;
export type Capability = string;
export const manifestSchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: deviceKind,
    capabilities: z.array(capabilityName).min(1).max(16),
    functions: z.array(functionDefinition).max(16).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const definitions = manifest.functions ?? [];
    if (
      new Set(manifest.capabilities).size !== manifest.capabilities.length ||
      new Set(definitions.map((f) => f.name)).size !== definitions.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate device functions" });
    for (const definition of definitions) {
      if (
        Object.hasOwn(capabilitySchemas, definition.name) ||
        !manifest.capabilities.includes(definition.name)
      )
        ctx.addIssue({
          code: "custom",
          message: "Function definitions must match custom capabilities",
        });
    }
    if (
      manifest.capabilities.some(
        (name) =>
          !Object.hasOwn(capabilitySchemas, name) &&
          !definitions.some((f) => f.name === name),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Custom capabilities require function schemas",
      });
  });
export type Manifest = z.infer<typeof manifestSchema>;
export type Status = ActionState;
export interface Device extends Manifest {
  id: string;
  tokenHash: string;
  revoked: boolean;
  lastSeen: number;
}
export interface Action extends ActionEnvelope {
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
interface AgentConnection {
  id: string;
  principal: string;
  name: string;
  tokenHash: string;
  expiresAt: number;
  revoked: boolean;
  access: "read" | "act";
}
export interface State {
  version: 1;
  devices: Device[];
  actions: Action[];
  enrollments: Enrollment[];
  grants: Grant[];
  agentConnections?: AgentConnection[];
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
    agentConnections: [],
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
    state.agentConnections ??= [];
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
  functions(p: Principal) {
    return this.list(p).flatMap((device) =>
      (device.functions ?? [])
        .filter(
          (fn) =>
            !(p.readOnly && fn.access === "write") &&
            (p.owner ||
              this.state.grants.some(
                (grant) =>
                  grant.principal === p.id &&
                  grant.deviceId === device.id &&
                  grant.capabilities.includes(fn.name) &&
                  grant.expiresAt > this.now(),
              )),
        )
        .map((definition) => ({
          deviceId: device.id,
          deviceName: device.name,
          definition,
        })),
    );
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
  history(p: Principal) {
    this.owner(p);
    this.expire();
    return [...this.state.actions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map(({ clientKey, ...action }) => action);
  }
  grants(p: Principal) {
    this.owner(p);
    return this.state.grants
      .filter(
        (grant) =>
          grant.expiresAt > this.now() &&
          this.state.devices.some(
            (device) => device.id === grant.deviceId && !device.revoked,
          ),
      )
      .map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }));
  }
  async enrollment(p: Principal, kind: Manifest["kind"]) {
    this.owner(p);
    deviceKind.parse(kind);
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
  publishManifest(id: string, input: unknown) {
    const device = this.device(id);
    const manifest = manifestSchema.parse(input);
    if (manifest.kind !== device.kind)
      throw new Fault(
        "invalid",
        400,
        "Changing device kind requires a new enrollment",
      );
    const describe = (m: Manifest) =>
      JSON.stringify({
        name: m.name,
        kind: m.kind,
        capabilities: m.capabilities,
        functions: m.functions ?? [],
      });
    if (describe(device) === describe(manifest))
      return { ok: true, grantsRevoked: false };
    Object.assign(device, manifest);
    device.functions = manifest.functions;
    this.state.grants = this.state.grants.filter(
      (grant) => grant.deviceId !== id,
    );
    for (const action of this.state.actions)
      if (
        action.deviceId === id &&
        ["queued", "received"].includes(action.status)
      )
        action.status = action.dispatchedAt ? "unknown" : "cancelled";
    this.audit("device.manifest_updated", id, "device");
    return { ok: true, grantsRevoked: true };
  }
  connections(p: Principal) {
    this.owner(p);
    return this.state
      .agentConnections!.filter((c) => !c.revoked && c.expiresAt > this.now())
      .map(({ tokenHash, ...connection }) => connection);
  }
  async createConnection(
    p: Principal,
    workspace: string,
    name: string,
    ttlSeconds = 86400,
    access: "read" | "act" = "act",
  ) {
    this.owner(p);
    if (
      !/^[a-f0-9]{64}$/.test(workspace) ||
      !name.trim() ||
      name.length > 64 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 2592000 ||
      !["read", "act"].includes(access)
    )
      throw new Fault("invalid", 400, "Invalid agent connection");
    this.state.agentConnections = this.state.agentConnections!.filter(
      (c) => !c.revoked && c.expiresAt > this.now(),
    );
    if (this.state.agentConnections.length >= 20)
      throw new Fault("limit", 429, "Agent connection limit reached");
    const id = crypto.randomUUID();
    const token = `ol_agent_${workspace}_${secret()}`;
    const connection: AgentConnection = {
      id,
      principal: `connection:${id}`,
      name: name.trim(),
      tokenHash: await hash(token),
      expiresAt: this.now() + ttlSeconds * 1000,
      revoked: false,
      access,
    };
    this.state.agentConnections.push(connection);
    this.audit("connection.created", id, p.id);
    const { tokenHash, ...safe } = connection;
    return { ...safe, token };
  }
  async authenticateConnection(
    token: string,
    workspace: string,
  ): Promise<Principal> {
    if (agentTokenWorkspace(token) !== workspace)
      throw new Fault("unauthorized", 401, "Invalid agent connection");
    const tokenHash = await hash(token);
    const connection = this.state.agentConnections!.find(
      (c) =>
        c.tokenHash === tokenHash && !c.revoked && c.expiresAt > this.now(),
    );
    if (!connection)
      throw new Fault(
        "unauthorized",
        401,
        "Agent connection expired or revoked",
      );
    return {
      id: connection.principal,
      owner: false,
      readOnly: connection.access === "read",
    };
  }
  revokeConnection(p: Principal, id: string) {
    this.owner(p);
    const connection = this.state.agentConnections!.find((c) => c.id === id);
    if (!connection)
      throw new Fault("not_found", 404, "Agent connection not found");
    connection.revoked = true;
    this.state.grants = this.state.grants.filter(
      (g) => g.principal !== connection.principal,
    );
    for (const action of this.state.actions)
      if (
        action.principalId === connection.principal &&
        action.status === "queued"
      )
        action.status = "cancelled";
    this.audit("connection.revoked", id, p.id);
    return { ok: true };
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
      capabilities.length < 1 ||
      capabilities.length > 16 ||
      new Set(capabilities).size !== capabilities.length ||
      !Number.isInteger(ttlSeconds) ||
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
  broadcast(
    p: Principal,
    ids: string[],
    capability: Capability,
    args: unknown,
    key: string,
    ttlSeconds = 30,
  ) {
    if (
      !ids.length ||
      ids.length > 20 ||
      new Set(ids).size !== ids.length ||
      !key ||
      key.length > 64
    )
      throw new Fault(
        "invalid",
        400,
        "Choose 1–20 distinct devices and an idempotency key of at most 64 characters",
      );
    return ids.map((deviceId) => {
      try {
        return {
          deviceId,
          action: this.request(
            p,
            deviceId,
            capability,
            args,
            `${key}:${deviceId}`,
            ttlSeconds,
          ),
        };
      } catch (error) {
        return {
          deviceId,
          error: {
            code: error instanceof Fault ? error.code : "invalid",
            message:
              error instanceof Fault
                ? error.message
                : "Function arguments are invalid",
          },
        };
      }
    });
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
    this.allowed(p, id, capability);
    const d = this.device(id);
    const definition = d.functions?.find((f) => f.name === capability);
    if (
      p.readOnly &&
      (definition?.access ??
        (capability === "device.health" ? "read" : "write")) !== "read"
    )
      throw new Fault("forbidden", 403, "Write scope required");
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
    const builtIn = Object.hasOwn(capabilitySchemas, capability)
      ? capabilitySchemas[capability as keyof typeof capabilitySchemas]
      : undefined;
    const parsed = builtIn
      ? builtIn.parse(args)
      : definition
        ? functionArguments(definition, args)
        : (() => {
            throw new Fault("unsupported", 400, "Function schema unavailable");
          })();
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
    const connectionValid =
      !principal.startsWith("connection:") ||
      this.state.agentConnections!.some(
        (c) =>
          c.principal === principal && !c.revoked && c.expiresAt > this.now(),
      );
    if (
      (!connectionValid ||
        !this.state.grants.some(
          (g) =>
            g.principal === principal &&
            g.deviceId === deviceId &&
            g.capabilities.includes(a.capability) &&
            g.expiresAt > this.now(),
        )) &&
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
