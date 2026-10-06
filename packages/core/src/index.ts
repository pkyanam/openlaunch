import { z } from "zod";
import { assertWorkspaceStorageBudget } from "./storage-budget.ts";
import {
  deviceFunctionLimit,
  DESKTOP_RESULT_BYTES,
  isDesktopScreenshot,
} from "./limits.ts";
import type { ActionEnvelope, ActionState } from "../../protocol/src/index.ts";
import {
  capabilityName,
  functionDefinition,
  functionArguments,
  type FunctionDefinition,
} from "./functions.ts";
export { capabilityName, functionDefinition } from "./functions.ts";
export const kinds = ["uno-r4-wifi", "raspberry-pi-4"] as const;
export const deviceKind = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
export function agentTokenWorkspace(token: string): string | undefined {
  return /^ol_(?:sdk|agent)_([a-f0-9]{64})_[a-f0-9]{64}$/.exec(token)?.[1];
}
export function agentTokenPurpose(
  token: string,
): "agent" | "device-setup" | undefined {
  const match = /^ol_(sdk|agent)_[a-f0-9]{64}_[a-f0-9]{64}$/.exec(token);
  return match?.[1] === "sdk"
    ? "device-setup"
    : match?.[1] === "agent"
      ? "agent"
      : undefined;
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
const builtInFunctionDefinitions: Record<string, FunctionDefinition> = {
  "device.health": {
    name: "device.health",
    title: "Read device health",
    description: "Read a fresh health summary from this device.",
    access: "read",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  "display.text": {
    name: "display.text",
    title: "Display text",
    description:
      "Show up to 96 printable ASCII characters on the device display.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 0, maxLength: 96 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  "led.set": {
    name: "led.set",
    title: "Set LED",
    description: "Turn the device built-in LED on or off.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
      additionalProperties: false,
    },
  },
};
export type Capability = string;
export const manifestSchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: deviceKind,
    capabilities: z.array(capabilityName).min(1).max(64),
    functions: z.array(functionDefinition).max(64).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const definitions = manifest.functions ?? [];
    if (
      manifest.capabilities.length > deviceFunctionLimit(manifest.kind) ||
      definitions.length > deviceFunctionLimit(manifest.kind)
    )
      ctx.addIssue({
        code: "custom",
        message: "Device function limit exceeded",
      });
    if (
      new Set(manifest.capabilities).size !== manifest.capabilities.length ||
      new Set(definitions.map((f) => f.name)).size !== definitions.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate device functions" });
    for (const definition of definitions) {
      if (
        !manifest.kind.startsWith("home-assistant.") &&
        Object.values(definition.inputSchema.properties).some(
          (property) => property.type === "object",
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Structured service data is only supported by Home Assistant adapters",
        });
      if (
        manifest.kind !== "linux" &&
        Object.values(definition.inputSchema.properties).some(
          (property) => property.type === "string" && property.maxLength > 1024,
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Only Linux host functions support strings above 1024 characters",
        });
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
  attachedConnectionId?: string;
  gatewayId?: string;
  gatewayKey?: string;
  gatewayAvailable?: boolean;
  gatewayDeviceLimit?: number;
  gatewayConnected?: boolean;
}
export interface Action extends ActionEnvelope {
  dispatchedAt?: number;
  resultReceivedAt?: number;
  result?: unknown;
  clientKey: string;
  fingerprint: string;
  principalId: string;
  ownerAuthorized: boolean;
  /**
   * Policy principal that authorized this action when queued; dispatch
   * re-checks the live chain for that policy before delivering.
   */
  accessPolicy?: string;
  /**
   * Constraint principals (e.g. the original OAuth client of a linked
   * membership) re-checked against their live policies at dispatch time.
   */
  accessConstraints?: string[];
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
  expiresAt: number | null;
}
export interface AccessPolicyFunctionExclusion {
  /** `null` matches the capability on every device. */
  deviceId: string | null;
  capability: Capability;
}
export interface AccessPolicy {
  principal: string;
  mode: "all" | "selected";
  excludedDevices: string[];
  excludedFunctions: AccessPolicyFunctionExclusion[];
  role: "operator" | "administrator";
  /**
   * Parent policy principal. A child policy is always intersected with the
   * live parent chain, so delegated credentials can never escape parent
   * exclusions, expiry or role changes.
   */
  delegatedFrom?: string;
  expiresAt: number | null;
}
export const accessPolicySchema = z
  .object({
    principal: z.string().min(1).max(128).regex(/^\S+$/),
    mode: z.enum(["all", "selected"]),
    excludedDevices: z.array(z.string().min(1).max(128)).max(1000),
    excludedFunctions: z
      .array(
        z
          .object({
            deviceId: z.string().min(1).max(128).nullable(),
            capability: capabilityName,
          })
          .strict(),
      )
      .max(1000),
    role: z.enum(["operator", "administrator"]),
    delegatedFrom: z.string().min(1).max(128).regex(/^\S+$/).optional(),
    expiresAt: z.number().int().nullable(),
  })
  .strict();
/** Bounded delegation depth; deeper or cyclic chains fail closed. */
const POLICY_CHAIN_LIMIT = 8;

function grantIsActive(grant: Grant, now: number) {
  return grant.expiresAt === null || grant.expiresAt > now;
}
function connectionIsActive(connection: AgentConnection, now: number) {
  return (
    !connection.revoked &&
    (connection.expiresAt === null || connection.expiresAt > now)
  );
}
interface AgentConnection {
  id: string;
  principal: string;
  name: string;
  tokenHash: string;
  expiresAt: number | null;
  revoked: boolean;
  access: "read" | "act";
  purpose?: "agent" | "device-setup" | "oauth";
  oauth?: import("./oauth-clients.ts").OAuthClientMetadata;
  canAttach?: boolean;
  deviceLimit?: number;
  gatewayDeviceLimit?: number;
}
export interface DeviceCredentialDeriver {
  keyVersion: string;
  derive(version: string, context: string): Promise<string>;
}
interface AttachAttempt {
  connectionId: string;
  requestId: string;
  fingerprint: string;
  deviceId: string;
  keyVersion: string;
  expiresAt: number;
}
export interface State {
  version: 1;
  devices: Device[];
  actions: Action[];
  retiredActionKeys?: string[];
  enrollments: Enrollment[];
  grants: Grant[];
  agentConnections?: AgentConnection[];
  attachAttempts?: AttachAttempt[];
  accessPolicies?: AccessPolicy[];
  /**
   * Workspace-wide default for agent access without an explicit policy.
   * "all" for genuinely new workspaces, "selected" for pre-upgrade ones;
   * persisted so the default survives reconstruction.
   */
  agentAccessDefault?: "all" | "selected";
  audit: { at: number; event: string; target: string; principal: string }[];
}
export interface Principal {
  id: string;
  owner: boolean;
  readOnly?: boolean;
  /**
   * Live delegated-administrator flag. Recomputed from persisted policies by
   * applyAccessPolicy for the current request only; stale flags never
   * escalate because every owner-level check re-verifies the live chain.
   */
  administrator?: boolean;
  /** Verified identity behind the session; set only by the trusted auth layer. */
  identityId?: string;
  /**
   * Constraint principals evaluated alongside this principal's own access
   * (e.g. the original OAuth client principal of a linked membership).
   * Set only by the trusted admission layer; never derived from
   * self-reported HTTP/MCP metadata.
   */
  accessConstraints?: string[];
  connectionPurpose?: "agent" | "device-setup" | "legacy";
  // Set only after issuer, token audience and OAuth scope verification.
  oauthClient?: boolean;
}
const isDeviceSetupPrincipal = (p: Principal) =>
  p.connectionPurpose === "device-setup";
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
    retiredActionKeys: [],
    enrollments: [],
    grants: [],
    agentConnections: [],
    attachAttempts: [],
    accessPolicies: [],
    agentAccessDefault: "all",
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
    state.attachAttempts ??= [];
    state.retiredActionKeys ??= [];
    state.accessPolicies ??= [];
    if (state.agentAccessDefault === undefined) {
      // Pre-upgrade workspaces keep the legacy grants-only default; only
      // genuinely new workspaces (emptyState) default to all access.
      state.agentAccessDefault = "selected";
    } else if (
      state.agentAccessDefault !== "all" &&
      state.agentAccessDefault !== "selected"
    ) {
      throw new Error("Invalid workspace agent access default");
    }
  }
  private capacity(
    changes: Partial<State> = {},
    mode: "new-work" | "dispatch" | "drain" = "new-work",
  ) {
    assertWorkspaceStorageBudget(
      this.state,
      { ...this.state, ...changes },
      { mode },
    );
  }
  private audit(event: string, target: string, principal: string) {
    this.state.audit.push({ at: this.now(), event, target, principal });
    this.state.audit = this.state.audit.slice(-1000);
  }
  private policyLive(policy: AccessPolicy) {
    return policy.expiresAt === null || policy.expiresAt > this.now();
  }
  private storedPolicy(principal: string) {
    return this.state.accessPolicies?.find(
      (policy) => policy.principal === principal,
    );
  }
  /**
   * A chain principal backed by a connection must still be an active
   * connection. A missing `connection:*` record (pruned after expiry or
   * revocation) is dead, not alive.
   */
  private principalAlive(principal: string) {
    const connection = this.state.agentConnections?.find(
      (c) => c.principal === principal,
    );
    if (principal.startsWith("connection:"))
      return !!connection && connectionIsActive(connection, this.now());
    return !connection || connectionIsActive(connection, this.now());
  }
  /**
   * Walk the delegation chain from a starting policy to its root. The
   * starting policy must be live too; every link must reference a live
   * policy of an alive principal. Expired policies, revoked or pruned
   * connections, missing parents, cycles and over-deep chains fail closed.
   */
  private resolveFrom(
    start: AccessPolicy,
  ): { kind: "denied" } | { kind: "chain"; chain: AccessPolicy[] } {
    const chain: AccessPolicy[] = [];
    const visited = new Set<string>();
    let current: AccessPolicy | undefined = start;
    while (current) {
      if (
        !this.policyLive(current) ||
        !this.principalAlive(current.principal) ||
        visited.has(current.principal) ||
        chain.length >= POLICY_CHAIN_LIMIT
      )
        return { kind: "denied" };
      visited.add(current.principal);
      chain.push(current);
      if (!current.delegatedFrom) break;
      // A declared parent that has no stored policy fails closed.
      current = this.storedPolicy(current.delegatedFrom);
      if (!current) return { kind: "denied" };
    }
    return { kind: "chain", chain };
  }
  /**
   * Resolve a principal's own access source. Principals without any stored
   * policy record keep legacy grant behavior; the presence of an expired
   * explicit policy denies instead of falling back to old grants.
   */
  private resolveOwn(
    principal: string,
    identityId?: string,
  ):
    | { kind: "legacy" }
    | { kind: "denied" }
    | { kind: "chain"; chain: AccessPolicy[] } {
    const start =
      this.storedPolicy(principal) ??
      (identityId ? this.storedPolicy(identityId) : undefined);
    if (!start) return { kind: "legacy" };
    return this.resolveFrom(start);
  }
  /**
   * Every chain level must allow: exclusions from any level deny, and a
   * "selected" level requires an active grant for that level's own principal.
   */
  private chainAllows(
    chain: AccessPolicy[],
    deviceId: string,
    capability: string,
  ) {
    for (const policy of chain) {
      if (policy.excludedDevices.includes(deviceId)) return false;
      if (
        policy.excludedFunctions.some(
          (f) =>
            (f.deviceId === null || f.deviceId === deviceId) &&
            f.capability === capability,
        )
      )
        return false;
      if (
        policy.mode === "selected" &&
        !this.grantAllows(policy.principal, deviceId, capability)
      )
        return false;
    }
    return true;
  }
  private grantAllows(
    principal: string,
    deviceId: string,
    capability: string,
  ) {
    return this.state.grants.some(
      (g) =>
        g.principal === principal &&
        g.deviceId === deviceId &&
        g.capabilities.includes(capability) &&
        grantIsActive(g, this.now()),
    );
  }
  /**
   * Own access (policy chain or legacy grants) intersected with every
   * constraint principal that has an explicit live policy. Constraint
   * principals without policies stay admission/scope enforcement only, so a
   * legacy client without grants never blocks a member's all-mode policy.
   */
  private principalAllowed(
    p: Principal,
    deviceId: string,
    capability: string,
  ) {
    if (p.owner) return true;
    const resolved = this.resolveOwn(p.id, p.identityId);
    if (resolved.kind === "denied") return false;
    if (
      resolved.kind === "legacy"
        ? !this.grantAllows(p.id, deviceId, capability)
        : !this.chainAllows(resolved.chain, deviceId, capability)
    )
      return false;
    for (const constraint of p.accessConstraints ?? []) {
      const constraintResolved = this.resolveOwn(constraint);
      if (constraintResolved.kind === "denied") return false;
      if (
        constraintResolved.kind === "chain" &&
        !this.chainAllows(constraintResolved.chain, deviceId, capability)
      )
        return false;
    }
    return true;
  }
  /** Dispatch-side re-check for a queued action, including stamped constraints. */
  private actionAllowed(a: Action) {
    if (a.ownerAuthorized) return true;
    const stamped = a.accessPolicy
      ? this.storedPolicy(a.accessPolicy)
      : undefined;
    // A stamped policy that no longer exists denies; never fall back to legacy.
    if (a.accessPolicy && !stamped) return false;
    const start = stamped ?? this.storedPolicy(a.principalId);
    const resolved = start
      ? this.resolveFrom(start)
      : ({ kind: "legacy" } as const);
    if (resolved.kind === "denied") return false;
    if (
      resolved.kind === "legacy"
        ? !this.grantAllows(a.principalId, a.deviceId, a.capability)
        : !this.chainAllows(resolved.chain, a.deviceId, a.capability)
    )
      return false;
    for (const constraint of a.accessConstraints ?? []) {
      const constraintResolved = this.resolveOwn(constraint);
      if (constraintResolved.kind === "denied") return false;
      if (
        constraintResolved.kind === "chain" &&
        !this.chainAllows(constraintResolved.chain, a.deviceId, a.capability)
      )
        return false;
    }
    return true;
  }
  /** Administrator role, capped by every delegation ancestor and constraint. */
  private effectiveAdministrator(p: Principal) {
    const resolved = this.resolveOwn(p.id, p.identityId);
    if (
      resolved.kind !== "chain" ||
      resolved.chain.some((policy) => policy.role !== "administrator")
    )
      return false;
    for (const constraint of p.accessConstraints ?? []) {
      const constraintResolved = this.resolveOwn(constraint);
      // Constraints without any explicit policy stay admission/scope only.
      if (constraintResolved.kind === "legacy") continue;
      if (
        constraintResolved.kind === "denied" ||
        constraintResolved.chain.some(
          (policy) => policy.role !== "administrator",
        )
      )
        return false;
    }
    return true;
  }
  /** Principals an administrator must never edit: itself and its ancestors. */
  private callerAncestry(p: Principal) {
    const principals = new Set<string>();
    principals.add(p.id);
    if (p.identityId) principals.add(p.identityId);
    const resolved = this.resolveOwn(p.id, p.identityId);
    if (resolved.kind === "chain")
      for (const policy of resolved.chain) principals.add(policy.principal);
    return principals;
  }
  /** Existing administrator-role policies are owner-managed only. */
  private administratorProtected(principal: string) {
    return this.storedPolicy(principal)?.role === "administrator";
  }
  /**
   * Validate a prospective policy set: every parent-chain dependency of the
   * delegated policy must exist, be live, be alive, acyclic and within the
   * bounded depth. The prospective array includes the policy being written so
   * cycles created by the write itself are rejected.
   */
  private validateDelegationChain(
    policies: AccessPolicy[],
    delegatedFrom: string,
  ) {
    z.string().min(1).max(128).regex(/^\S+$/).parse(delegatedFrom);
    let current = policies.find((p) => p.principal === delegatedFrom);
    if (
      !current ||
      !this.policyLive(current) ||
      !this.principalAlive(current.principal)
    )
      throw new Fault(
        "invalid",
        400,
        "Delegation parent must have a live policy",
      );
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.principal) || seen.size >= POLICY_CHAIN_LIMIT)
        throw new Fault("invalid", 400, "Invalid policy delegation chain");
      seen.add(current.principal);
      if (!current.delegatedFrom) break;
      current = policies.find((p) => p.principal === current!.delegatedFrom);
      if (!current)
        throw new Fault("invalid", 400, "Invalid policy delegation chain");
    }
  }
  private owner(p: Principal) {
    if (p.owner) return;
    if (p.administrator && !p.readOnly && this.effectiveAdministrator(p))
      return;
    throw new Fault("forbidden", 403, "Owner session required");
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
    if (isDeviceSetupPrincipal(p))
      throw new Fault(
        "forbidden",
        403,
        "Device setup tokens cannot access functions",
      );
    if (!this.principalAllowed(p, d, c))
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
    return this.functionCatalog(p).filter(
      (entry) =>
        !Object.hasOwn(builtInFunctionDefinitions, entry.definition.name),
    );
  }
  functionCatalog(p: Principal) {
    if (isDeviceSetupPrincipal(p)) return [];
    return this.state.devices
      .filter((device) => !device.revoked)
      .flatMap((device) => {
        const custom = new Map(
          (device.functions ?? []).map((definition) => [
            definition.name,
            definition,
          ]),
        );
        return device.capabilities
          .map((name) => custom.get(name) ?? builtInFunctionDefinitions[name])
          .filter((definition): definition is FunctionDefinition =>
            Boolean(definition),
          )
          .filter(
            (definition) =>
              !(p.readOnly && definition.access === "write") &&
              this.principalAllowed(p, device.id, definition.name),
          )
          .map((definition) => ({
            deviceId: device.id,
            deviceName: device.name,
            kind: device.kind,
            definition,
          }));
      });
  }
  list(p: Principal) {
    const permitted = new Map<string, Set<string>>();
    if (!p.owner)
      for (const entry of this.functionCatalog(p)) {
        const names = permitted.get(entry.deviceId) ?? new Set<string>();
        names.add(entry.definition.name);
        permitted.set(entry.deviceId, names);
      }
    return this.state.devices
      .filter((d) => !d.revoked && (p.owner || permitted.has(d.id)))
      .map(({ tokenHash, attachedConnectionId, ...d }) => ({
        ...d,
        ...(d.gatewayId
          ? {
              lastSeen:
                this.state.devices.find((parent) => parent.id === d.gatewayId)
                  ?.lastSeen ?? d.lastSeen,
            }
          : {}),
        ...(!p.owner
          ? {
              capabilities: d.capabilities.filter((name) =>
                permitted.get(d.id)!.has(name),
              ),
              functions: d.functions?.filter((definition) =>
                permitted.get(d.id)!.has(definition.name),
              ),
            }
          : {}),
        online: d.gatewayId
          ? d.gatewayAvailable !== false && this.gatewayOnline(d.gatewayId)
          : d.gatewayConnected !== false && this.now() - d.lastSeen < 45000,
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
  exportHistory(p: Principal) {
    this.owner(p);
    this.expire();
    return {
      format: "openlaunch.actions.v1",
      exportedAt: this.now(),
      actions: [...this.state.actions]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ clientKey, fingerprint, ...action }) => action),
    };
  }
  grants(p: Principal) {
    this.owner(p);
    return this.state.grants
      .filter(
        (grant) =>
          grantIsActive(grant, this.now()) &&
          this.state.devices.some(
            (device) => device.id === grant.deviceId && !device.revoked,
          ),
      )
      .map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }));
  }
  private copyPolicy(policy: AccessPolicy): AccessPolicy {
    return {
      ...policy,
      excludedDevices: [...policy.excludedDevices],
      excludedFunctions: policy.excludedFunctions.map((f) => ({ ...f })),
    };
  }
  /** Stored access policies, including expired ones (they deny while present). */
  accessPolicies(p: Principal) {
    this.owner(p);
    return (this.state.accessPolicies ?? []).map((policy) =>
      this.copyPolicy(policy),
    );
  }
  /**
   * Recompute the administrator flag for the current request from the live
   * persisted policy. Stale principal flags are stripped; a flag is only
   * granted when the whole delegation chain and every evaluated constraint
   * still carries the administrator role.
   */
  applyAccessPolicy(p: Principal): Principal {
    if (p.owner) return p;
    const administrator = !p.readOnly && this.effectiveAdministrator(p);
    return p.administrator === administrator ? p : { ...p, administrator };
  }
  /** Upsert one principal's access policy. Owner or delegated administrator. */
  setAccessPolicy(p: Principal, policy: unknown): AccessPolicy {
    this.owner(p);
    const parsed = accessPolicySchema.parse(policy);
    if (parsed.delegatedFrom === parsed.principal)
      throw new Fault("invalid", 400, "Policy cannot delegate from itself");
    const normalized: AccessPolicy = {
      principal: parsed.principal,
      mode: parsed.mode,
      excludedDevices: [...new Set(parsed.excludedDevices)],
      excludedFunctions: [
        ...new Map(
          parsed.excludedFunctions.map((f) => [
            JSON.stringify([f.deviceId, f.capability]),
            { ...f },
          ]),
        ).values(),
      ],
      role: parsed.role,
      ...(parsed.delegatedFrom
        ? { delegatedFrom: parsed.delegatedFrom }
        : {}),
      expiresAt: parsed.expiresAt,
    };
    if (!p.owner) {
      if (this.callerAncestry(p).has(normalized.principal))
        throw new Fault(
          "forbidden",
          403,
          "Administrators cannot change their own or ancestor access policies",
        );
      if (normalized.role === "administrator")
        throw new Fault(
          "forbidden",
          403,
          "Only the owner can grant the administrator role",
        );
      // Administrators manage operator policies only: an existing
      // administrator-role record (including demotion) is owner-only, so a
      // delegated admin can never demote or rewrite a peer administrator.
      const existing = this.storedPolicy(normalized.principal);
      if (existing?.role === "administrator")
        throw new Fault(
          "forbidden",
          403,
          "Only the owner can manage administrator access policies",
        );
      if (
        (normalized.delegatedFrom ?? undefined) !==
        (existing?.delegatedFrom ?? undefined)
      )
        throw new Fault(
          "forbidden",
          403,
          "Only the owner can change policy delegation",
        );
    }
    const policies = (this.state.accessPolicies ?? []).filter(
      (policy) => policy.principal !== normalized.principal,
    );
    policies.push(normalized);
    if (p.owner && normalized.delegatedFrom)
      this.validateDelegationChain(policies, normalized.delegatedFrom);
    this.capacity({ accessPolicies: policies });
    this.state.accessPolicies = policies;
    // Newly excluded access must not keep delivering queued work.
    for (const action of this.state.actions) {
      if (action.status !== "queued") continue;
      if (
        action.principalId !== normalized.principal &&
        action.accessPolicy !== normalized.principal &&
        !(action.accessConstraints ?? []).includes(normalized.principal)
      )
        continue;
      if (!this.actionAllowed(action)) action.status = "cancelled";
    }
    this.audit("access_policy.updated", normalized.principal, p.id);
    return this.copyPolicy(normalized);
  }
  /** Describe the effective access of this principal right now. */
  effectiveAccess(p: Principal) {
    const constraints = [...(p.accessConstraints ?? [])];
    if (p.owner)
      return {
        principal: p.id,
        source: "owner" as const,
        role: null,
        mode: null,
        delegatedFrom: null,
        expiresAt: null,
        excludedDevices: [] as string[],
        excludedFunctions: [] as AccessPolicyFunctionExclusion[],
        readOnly: !!p.readOnly,
        constraints,
        evaluatedConstraints: [] as string[],
        deviceIds: this.state.devices
          .filter((d) => !d.revoked)
          .map((d) => d.id),
      };
    const resolved = this.resolveOwn(p.id, p.identityId);
    const constraintsListed = [...(p.accessConstraints ?? [])];
    if (resolved.kind === "legacy" && !constraintsListed.length)
      return {
        principal: p.id,
        source: "legacy-grants" as const,
        role: null,
        mode: null,
        delegatedFrom: null,
        expiresAt: null,
        excludedDevices: [] as string[],
        excludedFunctions: [] as AccessPolicyFunctionExclusion[],
        readOnly: !!p.readOnly,
        constraints: constraintsListed,
        evaluatedConstraints: [] as string[],
        deviceIds: this.state.devices
          .filter(
            (d) =>
              !d.revoked &&
              this.state.grants.some(
                (g) =>
                  g.principal === p.id &&
                  g.deviceId === d.id &&
                  grantIsActive(g, this.now()),
              ),
          )
          .map((d) => d.id),
      };
    // Summarize the exact intersection the dispatcher enforces: the own chain
    // (when present) plus every constraint chain that has an explicit policy.
    const chains: AccessPolicy[] = resolved.kind === "chain" ? [...resolved.chain] : [];
    let denied = resolved.kind === "denied";
    if (denied) {
      const ownStart = this.storedPolicy(p.id) ?? this.storedPolicy(p.identityId!);
      if (ownStart) chains.push(ownStart);
    }
    const evaluatedConstraints: string[] = [];
    for (const constraint of constraintsListed) {
      const constraintResolved = this.resolveOwn(constraint);
      if (constraintResolved.kind === "legacy") continue;
      evaluatedConstraints.push(constraint);
      if (constraintResolved.kind === "denied") {
        denied = true;
        chains.push(this.storedPolicy(constraint)!);
      } else chains.push(...constraintResolved.chain);
    }
    const excludedDevices = [
      ...new Set(chains.flatMap((policy) => policy.excludedDevices)),
    ];
    const excludedFunctions = chains.flatMap((policy) =>
      policy.excludedFunctions.map((f) => ({ ...f })),
    );
    const selectedLevels = chains.filter((policy) => policy.mode === "selected");
    const expirations = chains
      .map((policy) => policy.expiresAt)
      .filter((expiresAt): expiresAt is number => expiresAt !== null);
    const baseDevices = () =>
      resolved.kind === "legacy"
        ? this.state.devices.filter(
            (d) =>
              !d.revoked &&
              this.state.grants.some(
                (g) =>
                  g.principal === p.id &&
                  g.deviceId === d.id &&
                  grantIsActive(g, this.now()),
              ),
          )
        : this.state.devices.filter((d) => !d.revoked);
    return {
      principal: p.id,
      source:
        resolved.kind === "chain"
          ? ("policy" as const)
          : ("legacy-grants" as const),
      role:
        denied || resolved.kind !== "chain"
          ? null
          : this.effectiveAdministrator(p)
            ? ("administrator" as const)
            : ("operator" as const),
      mode: selectedLevels.length
        ? ("selected" as const)
        : resolved.kind === "chain"
          ? ("all" as const)
          : null,
      delegatedFrom:
        resolved.kind === "chain"
          ? (resolved.chain[0]!.delegatedFrom ?? null)
          : null,
      expiresAt: expirations.length ? Math.min(...expirations) : null,
      excludedDevices,
      excludedFunctions,
      readOnly: !!p.readOnly,
      constraints: constraintsListed,
      evaluatedConstraints,
      // A device is reachable only when at least one of its capabilities
      // survives every exclusion and selected-level grant requirement, so the
      // summary matches what list/request actually enforce.
      deviceIds: denied
        ? []
        : baseDevices()
            .filter((d) =>
              d.capabilities.some(
                (capability) =>
                  !excludedDevices.includes(d.id) &&
                  !excludedFunctions.some(
                    (f) =>
                      (f.deviceId === null || f.deviceId === d.id) &&
                      f.capability === capability,
                  ) &&
                  selectedLevels.every((policy) =>
                    this.grantAllows(policy.principal, d.id, capability),
                  ),
              ),
            )
            .map((d) => d.id),
    };
  }
  async enrollment(p: Principal, kind: Manifest["kind"]) {
    this.owner(p);
    return this.issueEnrollment(kind, p.id);
  }
  private async issueEnrollment(kind: Manifest["kind"], principal: string) {
    deviceKind.parse(kind);
    const token = secret();
    this.state.enrollments = this.state.enrollments.filter(
      (e) => !e.used && e.expiresAt > this.now(),
    );
    if (this.state.enrollments.length >= 10)
      throw new Fault("limit", 429, "Too many pending enrollments");
    const expiresAt = this.now() + 600000;
    const enrollment = {
      hash: await hash(token),
      expiresAt,
      used: false,
      kind,
    };
    this.capacity({ enrollments: [...this.state.enrollments, enrollment] });
    this.state.enrollments.push(enrollment);
    this.audit("enrollment.created", kind, principal);
    return { token, expiresInSeconds: 600, expiresAt };
  }
  async enroll(token: string, input: unknown) {
    return this.consumeEnrollment(token, input);
  }
  private async consumeEnrollment(
    token: string,
    input: unknown,
    identity?: { deviceId: string; credential: string },
  ) {
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
    const credential = identity?.credential ?? secret();
    const d: Device = {
      ...m,
      id: identity?.deviceId ?? crypto.randomUUID(),
      tokenHash: await hash(credential),
      revoked: false,
      lastSeen: this.now(),
    };
    this.capacity({ devices: [...this.state.devices, d] });
    e.used = true;
    this.state.devices.push(d);
    this.audit("device.enrolled", d.id, "device");
    return { deviceId: d.id, token: credential };
  }
  async authenticateDevice(id: string, token: string) {
    const d = this.device(id);
    if (d.gatewayId || !token || (await hash(token)) !== d.tokenHash)
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
    this.capacity({
      devices: this.state.devices.map((d) =>
        d.id === id ? { ...d, ...manifest, functions: manifest.functions } : d,
      ),
    });
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
      .agentConnections!.filter((c) => connectionIsActive(c, this.now()))
      .map(({ tokenHash, ...connection }) => ({
        ...connection,
        attachedDeviceCount: this.state.devices.filter(
          (device) =>
            !device.revoked && device.attachedConnectionId === connection.id,
        ).length,
      }));
  }
  checkOAuthClientCapacity(p: Principal) {
    this.owner(p);
    // Reserve the largest bounded OAuth record before contacting the provider.
    this.capacity({
      agentConnections: [
        ...this.state.agentConnections!,
        {
          id: crypto.randomUUID(),
          principal: "x".repeat(128),
          name: "中".repeat(64),
          tokenHash: "",
          expiresAt: null,
          revoked: false,
          access: "read",
          purpose: "oauth",
          oauth: {
            applicationId: "x".repeat(128),
            clientId: "x".repeat(128),
            public: false,
            redirectUris: Array(8).fill("x".repeat(1024)),
          },
        },
      ],
    });
  }
  registerOAuthClient(
    p: Principal,
    config: import("./oauth-clients.ts").OAuthClientConfig,
    metadata: import("./oauth-clients.ts").OAuthClientMetadata,
    delegatedFrom?: string,
  ) {
    this.checkOAuthClientCapacity(p);
    // Newly registered OAuth connections default to all devices and functions
    // in the same commit. Pre-upgrade registrations and admitted built-in
    // clients keep their legacy grant-only behavior until the owner sets an
    // explicit policy.
    const delegation = p.owner ? delegatedFrom : p.id;
    if (delegation)
      this.validateDelegationChain(this.state.accessPolicies ?? [], delegation);
    if (
      !metadata.clientId ||
      metadata.clientId.length > 128 ||
      !metadata.applicationId ||
      metadata.applicationId.length > 128 ||
      this.state.agentConnections!.some(
        (c) => c.principal === metadata.clientId,
      )
    )
      throw new Fault("invalid", 400, "Invalid OAuth client registration");
    const connection: AgentConnection = {
      id: crypto.randomUUID(),
      principal: metadata.clientId,
      name: config.name,
      tokenHash: "",
      expiresAt: null,
      revoked: false,
      access: config.access,
      purpose: "oauth",
      canAttach: false,
      deviceLimit: 0,
      oauth: {
        applicationId: metadata.applicationId,
        clientId: metadata.clientId,
        redirectUris: [...config.redirectUris],
        public: config.public,
      },
    };
    const accessPolicy: AccessPolicy = {
      principal: connection.principal,
      mode: "all",
      excludedDevices: [],
      excludedFunctions: [],
      role: "operator",
      ...(delegation ? { delegatedFrom: delegation } : {}),
      expiresAt: null,
    };
    this.capacity({
      agentConnections: [...this.state.agentConnections!, connection],
      accessPolicies: [
        ...(this.state.accessPolicies ?? []).filter(
          (policy) => policy.principal !== connection.principal,
        ),
        accessPolicy,
      ],
    });
    this.state.agentConnections!.push(connection);
    this.state.accessPolicies ??= [];
    this.state.accessPolicies.push(accessPolicy);
    this.audit("oauth.client_registered", connection.id, p.id);
    const { tokenHash, ...safe } = connection;
    return safe;
  }
  admitOAuthClient(p: Principal, builtins: string[] = []): Principal {
    if (!p.oauthClient) return p;
    const connection = this.state.agentConnections!.find(
      (c) => c.purpose === "oauth" && c.principal === p.id,
    );
    if (connection) {
      if (!connectionIsActive(connection, this.now()))
        throw new Fault("unauthorized", 401, "OAuth client was revoked");
      return {
        ...p,
        owner: false,
        readOnly: p.readOnly || connection.access === "read",
      };
    }
    if (!builtins.includes(p.id))
      throw new Fault(
        "unauthorized",
        401,
        "OAuth client is not registered in this workspace",
      );
    // Genuinely new workspaces default built-in OAuth clients to every device
    // and function so direct MCP works after first device setup. Any stored
    // policy record — including an expired or restricting one — is preserved
    // untouched, and pre-upgrade workspaces keep legacy grants only.
    if (
      this.state.agentAccessDefault === "all" &&
      !this.storedPolicy(p.id)
    ) {
      const policies = [
        ...(this.state.accessPolicies ?? []),
        {
          principal: p.id,
          mode: "all",
          excludedDevices: [],
          excludedFunctions: [],
          role: "operator",
          expiresAt: null,
        } satisfies AccessPolicy,
      ];
      this.capacity({ accessPolicies: policies });
      this.state.accessPolicies = policies;
      this.audit("access_policy.default_installed", p.id, p.id);
    }
    return { ...p, owner: false };
  }
  deviceSetupTokens(p: Principal) {
    this.owner(p);
    return this.state
      .agentConnections!.filter(
        (c) =>
          !c.revoked &&
          connectionIsActive(c, this.now()) &&
          (c.purpose === "device-setup" || (!c.purpose && c.canAttach)),
      )
      .map(({ tokenHash, ...connection }) => ({
        ...connection,
        attachedDeviceCount: this.state.devices.filter(
          (device) =>
            !device.revoked && device.attachedConnectionId === connection.id,
        ).length,
      }));
  }
  async createConnection(
    p: Principal,
    workspace: string,
    name: string,
    ttlSeconds: number | null = 86400,
    access: "read" | "act" = "act",
    attachment: {
      canAttach: boolean;
      deviceLimit: number;
      gatewayDeviceLimit?: number;
    } = {
      canAttach: false,
      deviceLimit: 0,
    },
    purpose?: "agent" | "device-setup",
    delegatedFrom?: string,
  ) {
    this.owner(p);
    // Credentials minted by delegated administrators always delegate from the
    // minting principal so they inherit its live ceilings; only the owner may
    // choose an explicit parent for a new root credential.
    const delegation = p.owner ? delegatedFrom : p.id;
    if (delegation)
      this.validateDelegationChain(this.state.accessPolicies ?? [], delegation);
    if (
      !/^[a-f0-9]{64}$/.test(workspace) ||
      !name.trim() ||
      name.length > 64 ||
      (ttlSeconds === null
        ? purpose !== "agent"
        : !Number.isInteger(ttlSeconds) ||
          ttlSeconds < 60 ||
          ttlSeconds > 2592000) ||
      !["read", "act"].includes(access) ||
      typeof attachment.canAttach !== "boolean" ||
      !Number.isInteger(attachment.deviceLimit) ||
      attachment.deviceLimit < 0 ||
      !Number.isSafeInteger(attachment.deviceLimit) ||
      (attachment.canAttach
        ? attachment.deviceLimit < 1
        : attachment.deviceLimit !== 0) ||
      !Number.isInteger(attachment.gatewayDeviceLimit ?? 0) ||
      (attachment.gatewayDeviceLimit ?? 0) < 0 ||
      (attachment.gatewayDeviceLimit ?? 0) > 2000 ||
      ((attachment.gatewayDeviceLimit ?? 0) > 0 &&
        purpose !== "device-setup") ||
      (purpose === "agent" && attachment.canAttach) ||
      (purpose === "device-setup" && !attachment.canAttach)
    )
      throw new Fault("invalid", 400, "Invalid agent connection");
    this.state.agentConnections = this.state.agentConnections!.filter((c) =>
      connectionIsActive(c, this.now()),
    );
    const id = crypto.randomUUID();
    const token = `ol_${purpose === "agent" ? "agent" : "sdk"}_${workspace}_${secret()}`;
    const connection: AgentConnection = {
      id,
      principal: `connection:${id}`,
      name: name.trim(),
      tokenHash: await hash(token),
      expiresAt: ttlSeconds === null ? null : this.now() + ttlSeconds * 1000,
      revoked: false,
      access,
      ...(purpose ? { purpose } : {}),
      ...attachment,
    };
    // New agent API connections default to every device and function as an
    // operator, in the same capacity check and commit as the connection.
    // Device-setup tokens stay attach-only and legacy-purpose (unspecified)
    // connections keep the pre-upgrade grants-only behavior.
    const accessPolicy: AccessPolicy | undefined =
      purpose === "agent"
        ? {
            principal: connection.principal,
            mode: "all",
            excludedDevices: [],
            excludedFunctions: [],
            role: "operator",
            ...(delegation ? { delegatedFrom: delegation } : {}),
            expiresAt: connection.expiresAt,
          }
        : undefined;
    this.capacity({
      agentConnections: [...this.state.agentConnections, connection],
      ...(accessPolicy
        ? {
            accessPolicies: [
              ...(this.state.accessPolicies ?? []).filter(
                (policy) => policy.principal !== connection.principal,
              ),
              accessPolicy,
            ],
          }
        : {}),
    });
    this.state.agentConnections.push(connection);
    if (accessPolicy) (this.state.accessPolicies ??= []).push(accessPolicy);
    this.audit("connection.created", id, p.id);
    const { tokenHash, ...safe } = connection;
    return { ...safe, token };
  }
  async attachDevice(
    p: Principal,
    workspace: string,
    requestId: string,
    input: unknown,
    credentials: DeviceCredentialDeriver,
  ) {
    z.string().uuid().parse(requestId);
    if (!/^[a-f0-9]{64}$/.test(workspace))
      throw new Fault("invalid", 400, "Invalid workspace");
    const connection = this.state.agentConnections!.find(
      (c) => c.principal === p.id && connectionIsActive(c, this.now()),
    );
    if (
      p.owner ||
      !connection ||
      connection.purpose === "agent" ||
      !(connection.purpose === "device-setup" || connection.canAttach)
    )
      throw new Fault("forbidden", 403, "This SDK token cannot attach devices");
    const manifest = manifestSchema.parse(input);
    if (
      manifest.kind.startsWith("gateway.") &&
      !(connection.gatewayDeviceLimit && connection.purpose === "device-setup")
    )
      throw new Fault(
        "forbidden",
        403,
        "Create a gateway-enabled device setup token in the console",
      );
    const sortValue = (value: any): any =>
      Array.isArray(value)
        ? value.map(sortValue)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, sortValue(item)]),
            )
          : value;
    const fingerprint = JSON.stringify(sortValue(manifest));
    const existing = this.state.attachAttempts!.find(
      (a) => a.connectionId === connection.id && a.requestId === requestId,
    );
    if (existing && existing.fingerprint !== fingerprint)
      throw new Fault(
        "conflict",
        409,
        "Attachment request reused with a different manifest",
      );
    if (existing && existing.expiresAt <= this.now())
      throw new Fault(
        "attachment_expired",
        409,
        "Attachment retry expired; check device inventory before starting again",
      );
    const deviceId = existing?.deviceId ?? crypto.randomUUID();
    if (existing) this.device(deviceId);
    if (!existing) {
      if (
        this.state.devices.filter(
          (d) => !d.revoked && d.attachedConnectionId === connection.id,
        ).length >= (connection.deviceLimit ?? 0)
      )
        throw new Fault("limit", 429, "SDK token device limit reached");
      if (this.state.attachAttempts!.length >= 1000)
        throw new Fault("limit", 429, "Workspace attachment limit reached");
    }
    const keyVersion = existing?.keyVersion ?? credentials.keyVersion;
    let credential: string;
    try {
      credential = await credentials.derive(
        keyVersion,
        JSON.stringify([
          "openlaunch-device-credential-v1",
          workspace,
          connection.id,
          requestId,
          deviceId,
          fingerprint,
        ]),
      );
    } catch {
      throw new Fault(
        "setup_required",
        503,
        "Device credential key is unavailable",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(credential))
      throw new Fault(
        "setup_required",
        503,
        "Device credential service is unavailable",
      );
    if (existing) {
      if ((await hash(credential)) !== this.device(deviceId).tokenHash)
        throw new Fault(
          "setup_required",
          503,
          "Device credential key changed; restore its original version",
        );
      return { deviceId, token: credential };
    }
    // Admit the complete attachment before issuing its internal enrollment.
    // A failed quota check must not leave a consumed token or partial device.
    this.capacity({
      devices: [
        ...this.state.devices,
        {
          ...manifest,
          id: deviceId,
          tokenHash: await hash(credential),
          revoked: false,
          lastSeen: this.now(),
          attachedConnectionId: connection.id,
          ...(manifest.kind.startsWith("gateway.")
            ? {
                gatewayDeviceLimit: connection.gatewayDeviceLimit,
                gatewayConnected: false,
              }
            : {}),
        },
      ],
      attachAttempts: [
        ...this.state.attachAttempts!,
        {
          connectionId: connection.id,
          requestId,
          fingerprint,
          deviceId,
          keyVersion,
          expiresAt: this.now() + 600000,
        },
      ],
      enrollments: [
        ...this.state.enrollments.filter(
          (e) => !e.used && e.expiresAt > this.now(),
        ),
        {
          hash: "0".repeat(64),
          expiresAt: this.now() + 600000,
          used: false,
          kind: manifest.kind,
        },
      ],
    });
    const enrollment = await this.issueEnrollment(
      manifest.kind,
      connection.principal,
    );
    const result = await this.consumeEnrollment(enrollment.token, manifest, {
      deviceId,
      credential,
    });
    this.device(deviceId).attachedConnectionId = connection.id;
    if (manifest.kind.startsWith("gateway.")) {
      this.device(deviceId).gatewayDeviceLimit = connection.gatewayDeviceLimit;
      this.device(deviceId).gatewayConnected = false;
    }
    this.state.attachAttempts!.push({
      connectionId: connection.id,
      requestId,
      fingerprint,
      deviceId,
      keyVersion,
      expiresAt: enrollment.expiresAt,
    });
    this.audit("device.attached", deviceId, connection.principal);
    return result;
  }
  async authenticateConnection(
    token: string,
    workspace: string,
  ): Promise<Principal> {
    if (agentTokenWorkspace(token) !== workspace)
      throw new Fault("unauthorized", 401, "Invalid agent connection");
    const tokenHash = await hash(token);
    const connection = this.state.agentConnections!.find(
      (c) => c.tokenHash === tokenHash && connectionIsActive(c, this.now()),
    );
    if (!connection)
      throw new Fault(
        "unauthorized",
        401,
        "Agent connection expired or revoked",
      );
    const tokenPurpose = agentTokenPurpose(token);
    if (connection.purpose && connection.purpose !== tokenPurpose)
      throw new Fault("unauthorized", 401, "Invalid token purpose");
    return {
      id: connection.principal,
      owner: false,
      readOnly: connection.access === "read",
      connectionPurpose: connection.purpose ?? "legacy",
    };
  }
  revokeConnection(p: Principal, id: string) {
    this.owner(p);
    const connection = this.state.agentConnections!.find((c) => c.id === id);
    if (!connection)
      throw new Fault("not_found", 404, "Agent connection not found");
    if (!p.owner && this.administratorProtected(connection.principal))
      throw new Fault(
        "forbidden",
        403,
        "Only the owner can revoke administrator credentials",
      );
    connection.revoked = true;
    this.state.grants = this.state.grants.filter(
      (g) => g.principal !== connection.principal,
    );
    for (const action of this.state.actions)
      if (
        action.status === "queued" &&
        (action.principalId === connection.principal ||
          action.accessPolicy === connection.principal ||
          (action.accessConstraints ?? []).includes(connection.principal))
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
    ttlSeconds: number | null = 3600,
  ) {
    this.owner(p);
    if (!p.owner && this.callerAncestry(p).has(principal))
      throw new Fault(
        "forbidden",
        403,
        "Administrators cannot change their own or ancestor access policies",
      );
    if (!p.owner && this.administratorProtected(principal))
      throw new Fault(
        "forbidden",
        403,
        "Only the owner can manage administrator credentials",
      );
    const d = this.device(id);
    if (
      this.state.agentConnections!.some(
        (connection) =>
          connection.principal === principal &&
          connection.purpose === "device-setup",
      )
    )
      throw new Fault(
        "forbidden",
        403,
        "Device setup tokens cannot receive grants",
      );
    if (
      !principal ||
      principal.length > 128 ||
      capabilities.length < 1 ||
      capabilities.length > deviceFunctionLimit(d.kind) ||
      new Set(capabilities).size !== capabilities.length ||
      !capabilities.every((c) => d.capabilities.includes(c)) ||
      (ttlSeconds !== null &&
        (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400))
    )
      throw new Fault("invalid", 400, "Invalid grant");
    const grants = this.state.grants.filter(
      (g) => g.principal !== principal || g.deviceId !== id,
    );
    grants.push({
      principal,
      deviceId: id,
      capabilities,
      expiresAt: ttlSeconds === null ? null : this.now() + ttlSeconds * 1000,
    });
    // Granting keeps explicit all-mode exclusions unchanged: one capability
    // grant must never re-admit an owner's device or function opt-outs. The
    // grant record still matters if the policy later switches to selected.
    this.capacity({ grants });
    this.state.grants = grants;
    this.audit("grant.updated", id, p.id);
    return { ok: true };
  }
  revokeGrant(p: Principal, principal: string, id: string) {
    this.owner(p);
    if (!p.owner && this.callerAncestry(p).has(principal))
      throw new Fault(
        "forbidden",
        403,
        "Administrators cannot change their own or ancestor access policies",
      );
    if (!p.owner && this.administratorProtected(principal))
      throw new Fault(
        "forbidden",
        403,
        "Only the owner can manage administrator credentials",
      );
    this.state.grants = this.state.grants.filter(
      (g) => g.principal !== principal || g.deviceId !== id,
    );
    // Revocation stays meaningful for all-mode policies: exclude the device
    // rather than silently falling back to all-access.
    const policies = this.state.accessPolicies ?? [];
    const policy = policies.find(
      (candidate) =>
        candidate.principal === principal && this.policyLive(candidate),
    );
    if (policy && policy.mode === "all" && !policy.excludedDevices.includes(id)) {
      const updatedPolicies = policies.map((candidate) =>
        candidate.principal === principal
          ? { ...candidate, excludedDevices: [...candidate.excludedDevices, id] }
          : candidate,
      );
      this.capacity({ accessPolicies: updatedPolicies });
      this.state.accessPolicies = updatedPolicies;
    }
    for (const a of this.state.actions)
      if (
        a.deviceId === id &&
        a.status === "queued" &&
        (a.principalId === principal ||
          a.accessPolicy === principal ||
          (a.accessConstraints ?? []).includes(principal))
      )
        a.status = "cancelled";
    this.audit("grant.revoked", id, p.id);
    return { ok: true };
  }
  gatewayGrants(
    p: Principal,
    id: string,
    principal: string,
    mode: "read" | "control",
    includeServices = false,
    ttlSeconds: number | null = 3600,
  ) {
    this.owner(p);
    this.gateway(id);
    if (
      !principal ||
      principal.length > 128 ||
      !["read", "control"].includes(mode) ||
      (ttlSeconds !== null &&
        (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400))
    )
      throw new Fault("invalid", 400, "Invalid gateway grant");
    if (
      this.state.agentConnections!.some(
        (c) => c.principal === principal && c.purpose === "device-setup",
      )
    )
      throw new Fault(
        "forbidden",
        403,
        "Device setup tokens cannot receive grants",
      );
    const selected = this.state.devices.filter(
      (d) =>
        !d.revoked &&
        (d.id === id ||
          (d.gatewayId === id &&
            d.gatewayAvailable !== false &&
            (includeServices || d.kind !== "home-assistant.service"))),
    );
    const ids = new Set(
      this.state.devices
        .filter((d) => d.id === id || d.gatewayId === id)
        .map((d) => d.id),
    );
    const grants = this.state.grants.filter(
      (g) => g.principal !== principal || !ids.has(g.deviceId),
    );
    for (const d of selected) {
      const capabilities = d.capabilities.filter(
        (name) =>
          mode === "control" ||
          (
            d.functions?.find((f) => f.name === name) ??
            builtInFunctionDefinitions[name]
          )?.access === "read",
      );
      if (capabilities.length)
        grants.push({
          principal,
          deviceId: d.id,
          capabilities,
          expiresAt:
            ttlSeconds === null ? null : this.now() + ttlSeconds * 1000,
        });
    }
    this.capacity({ grants });
    this.state.grants = grants;
    for (const action of this.state.actions)
      if (
        action.status === "queued" &&
        action.principalId === principal &&
        ids.has(action.deviceId) &&
        !grants.some(
          (g) =>
            g.principal === principal &&
            g.deviceId === action.deviceId &&
            g.capabilities.includes(action.capability),
        ) &&
        !this.actionAllowed(action)
      )
        action.status = "cancelled";
    this.audit("gateway.grants_updated", id, p.id);
    return { ok: true, devices: selected.length };
  }
  revoke(p: Principal, id: string) {
    this.owner(p);
    const d = this.device(id);
    d.revoked = true;
    for (const child of this.state.devices.filter(
      (child) => child.gatewayId === id && !child.revoked,
    ))
      this.revoke(p, child.id);
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
    if (this.state.retiredActionKeys!.includes(clientKey))
      throw new Fault(
        "history_pruned",
        409,
        "This request was already accepted; its receipt is no longer retained. Use a new key only for an intentional new action.",
      );
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
    if (
      d.gatewayId
        ? d.gatewayAvailable === false || !this.gatewayOnline(d.gatewayId)
        : d.gatewayConnected === false || this.now() - d.lastSeen >= 45000
    )
      throw new Fault("offline", 409, "Device offline; no action queued");
    // Stamp the governing policy and any access constraints so dispatch can
    // re-check them against live state before delivery.
    const resolvedOwn = this.resolveOwn(p.id, p.identityId);
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
      ...(resolvedOwn.kind === "chain"
        ? { accessPolicy: resolvedOwn.chain[0]!.principal }
        : {}),
      ...(p.accessConstraints?.length
        ? { accessConstraints: [...p.accessConstraints] }
        : {}),
    };
    // Keep pending and uncertain work. Only settled receipts past their TTL
    // may be pruned; durable keys prevent a historical retry executing again.
    let actions = [...this.state.actions];
    const retiredActionKeys = [...this.state.retiredActionKeys!];
    const removable = actions.filter(
      (row) =>
        ["succeeded", "failed", "cancelled", "expired"].includes(row.status) &&
        row.expiresAt <= this.now(),
    );
    while (true) {
      try {
        if (actions.length >= 5000)
          throw new Fault(
            "limit",
            429,
            "Pending or unsettled action capacity reached; retry after work settles.",
          );
        this.capacity({ actions: [...actions, a], retiredActionKeys });
        break;
      } catch (error) {
        if (
          !(error instanceof Fault) ||
          !["limit", "storage_full"].includes(error.code) ||
          !removable.length
        )
          throw error;
        const row = removable.shift()!;
        actions = actions.filter((item) => item.id !== row.id);
        retiredActionKeys.push(row.clientKey);
      }
    }
    this.state.actions = [...actions, a];
    this.state.retiredActionKeys = retiredActionKeys;
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
  private gatewayOnline(id: string) {
    const parent = this.state.devices.find((device) => device.id === id);
    return (
      !!parent &&
      !parent.revoked &&
      parent.gatewayConnected !== false &&
      this.now() - parent.lastSeen < 45000
    );
  }
  private gateway(id: string) {
    const parent = this.device(id);
    if (
      parent.gatewayId ||
      !parent.kind.startsWith("gateway.") ||
      !parent.gatewayDeviceLimit
    )
      throw new Fault("forbidden", 403, "Device is not an approved gateway");
    return parent;
  }
  gatewayChildren(id: string, children: { key: string; manifest: unknown }[]) {
    const parent = this.gateway(id);
    return children.map(({ key, manifest: input }) => {
      try {
        const manifest = manifestSchema.parse(input);
        if (manifest.kind.startsWith("gateway."))
          throw new Fault("invalid", 400, "Nested gateways are not supported");
        const child = this.state.devices.find(
          (device) => device.gatewayId === id && device.gatewayKey === key,
        );
        if (child?.revoked)
          return {
            key,
            deviceId: child.id,
            revoked: true,
            grantsRevoked: false,
          };
        if (child) {
          this.capacity({
            devices: this.state.devices.map((d) =>
              d.id === child.id
                ? {
                    ...d,
                    ...manifest,
                    functions: manifest.functions,
                    gatewayAvailable: true,
                  }
                : d,
            ),
          });
          const receipt = this.publishManifest(child.id, manifest);
          child.gatewayAvailable = true;
          return {
            key,
            deviceId: child.id,
            revoked: false,
            grantsRevoked: receipt.grantsRevoked,
          };
        }
        // Revoked records still count, bounding permanent key tombstones.
        if (
          this.state.devices.filter((device) => device.gatewayId === id)
            .length >= parent.gatewayDeviceLimit!
        )
          throw new Fault("limit", 429, "Gateway device limit reached");
        const created: Device = {
          ...manifest,
          id: crypto.randomUUID(),
          tokenHash: "",
          revoked: false,
          lastSeen: this.now(),
          gatewayId: id,
          gatewayKey: key,
          gatewayAvailable: true,
        };
        this.capacity({ devices: [...this.state.devices, created] });
        this.state.devices.push(created);
        this.audit("gateway.child_discovered", created.id, "device");
        return {
          key,
          deviceId: created.id,
          revoked: false,
          grantsRevoked: false,
        };
      } catch (error) {
        return {
          key,
          error: {
            code: error instanceof Fault ? error.code : "invalid",
            message:
              error instanceof Fault ? error.message : "Invalid child manifest",
          },
        };
      }
    });
  }
  gatewayStatus(id: string, online: boolean, keys?: string[]) {
    const parent = this.gateway(id);
    z.boolean().parse(online);
    if (keys)
      z.array(
        z
          .string()
          .min(1)
          .max(192)
          .regex(/^[a-zA-Z0-9_.:-]+$/),
      )
        .max(2000)
        .parse(keys);
    const active = keys ? new Set(keys) : undefined;
    const removed = new Set(
      this.state.devices
        .filter(
          (d) =>
            d.gatewayId === id &&
            !d.revoked &&
            d.gatewayAvailable !== false &&
            active &&
            !active.has(d.gatewayKey!),
        )
        .map((d) => d.id),
    );
    const devices = this.state.devices.map((d) =>
      d.id === id
        ? { ...d, gatewayConnected: online, lastSeen: this.now() }
        : removed.has(d.id)
          ? { ...d, gatewayAvailable: false }
          : d,
    );
    const grants = this.state.grants.filter((g) => !removed.has(g.deviceId));
    const actions = this.state.actions.map((a) =>
      removed.has(a.deviceId) && ["queued", "received"].includes(a.status)
        ? {
            ...a,
            status: (a.dispatchedAt ? "unknown" : "cancelled") as ActionState,
          }
        : a,
    );
    this.capacity({ devices, grants, actions }, "drain");
    // Commit only after admitting the complete reconciliation; keep live object identities.
    for (let n = 0; n < devices.length; n++)
      Object.assign(this.state.devices[n]!, devices[n]);
    for (let n = 0; n < actions.length; n++)
      Object.assign(this.state.actions[n]!, actions[n]);
    this.state.grants = grants;
    for (const childId of removed)
      this.audit("gateway.child_removed", childId, "device");
    return { ok: true };
  }
  heartbeat(deviceId: string) {
    const device = this.device(deviceId);
    device.lastSeen = this.now();
    return { lastSeen: device.lastSeen };
  }
  next(deviceId: string) {
    this.expire();
    const d = this.device(deviceId);
    const a = this.state.actions.find(
      (a) =>
        (a.deviceId === deviceId ||
          this.state.devices.some(
            (child) =>
              child.id === a.deviceId &&
              child.gatewayId === deviceId &&
              !child.revoked &&
              child.gatewayAvailable !== false,
          )) &&
        a.status === "queued",
    );
    if (!a) {
      d.lastSeen = this.now();
      return null;
    }
    const principal = a.principalId;
    const connectionValid =
      !principal.startsWith("connection:") ||
      this.state.agentConnections!.some(
        (c) => c.principal === principal && connectionIsActive(c, this.now()),
      );
    if (!connectionValid || !this.actionAllowed(a)) {
      a.status = "cancelled";
      d.lastSeen = this.now();
      return null;
    }
    if (a.deviceId !== deviceId && d.gatewayConnected === false) {
      d.lastSeen = this.now();
      return null;
    }
    this.capacity({}, "dispatch");
    d.lastSeen = this.now();
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
    const device = this.device(deviceId);
    const a = this.state.actions.find(
      (a) =>
        a.id === id &&
        (a.deviceId === deviceId ||
          this.state.devices.some(
            (child) =>
              child.id === a.deviceId &&
              child.gatewayId === deviceId &&
              !child.revoked &&
              child.gatewayAvailable !== false,
          )),
    );
    if (!a) throw new Fault("not_found", 404, "Action not found");
    if (a.status === status && canonical(a.result) === canonical(result)) {
      device.lastSeen = this.now();
      return a;
    }
    if (a.status !== "received")
      throw new Fault(
        "conflict",
        409,
        "No dispatched action can accept this result",
      );
    const encoded = JSON.stringify(result);
    if (encoded === undefined)
      throw new Fault("invalid", 400, "JSON result required");
    if (
      isDesktopScreenshot(this.device(a.deviceId).kind, a.capability)
        ? new TextEncoder().encode(encoded).byteLength > DESKTOP_RESULT_BYTES
        : encoded.length > 4096
    )
      throw new Fault("too_large", 413, "Result too large");
    const resultReceivedAt = this.now();
    this.capacity(
      {
        actions: this.state.actions.map((action) =>
          action.id === id
            ? { ...action, status, result, resultReceivedAt }
            : action,
        ),
      },
      "drain",
    );
    device.lastSeen = this.now();
    a.status = status;
    a.result = result;
    a.resultReceivedAt = resultReceivedAt;
    this.audit("action." + status, a.id, "device");
    return a;
  }
}
