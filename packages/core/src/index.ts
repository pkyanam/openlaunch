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
    capabilities: z.array(capabilityName).min(1).max(24),
    functions: z.array(functionDefinition).max(24).optional(),
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
}
export interface Action extends ActionEnvelope {
  dispatchedAt?: number;
  resultReceivedAt?: number;
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
  expiresAt: number | null;
}

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
  enrollments: Enrollment[];
  grants: Grant[];
  agentConnections?: AgentConnection[];
  attachAttempts?: AttachAttempt[];
  audit: { at: number; event: string; target: string; principal: string }[];
}
export interface Principal {
  id: string;
  owner: boolean;
  readOnly?: boolean;
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
    enrollments: [],
    grants: [],
    agentConnections: [],
    attachAttempts: [],
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
    if (isDeviceSetupPrincipal(p))
      throw new Fault(
        "forbidden",
        403,
        "Device setup tokens cannot access functions",
      );
    if (
      !this.state.grants.some(
        (g) =>
          g.principal === p.id &&
          g.deviceId === d &&
          g.capabilities.includes(c) &&
          grantIsActive(g, this.now()),
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
              (p.owner ||
                this.state.grants.some(
                  (grant) =>
                    grant.principal === p.id &&
                    grant.deviceId === device.id &&
                    grant.capabilities.includes(definition.name) &&
                    grantIsActive(grant, this.now()),
                )),
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
    if (this.state.devices.filter((d) => !d.revoked).length >= 20)
      throw new Fault("limit", 429, "Device limit reached");
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
    if (
      this.state.agentConnections!.filter((c) =>
        connectionIsActive(c, this.now()),
      ).length >= 20
    )
      throw new Fault("limit", 429, "Agent connection limit reached");
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
  ) {
    this.checkOAuthClientCapacity(p);
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
    this.capacity({
      agentConnections: [...this.state.agentConnections!, connection],
    });
    this.state.agentConnections!.push(connection);
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
    attachment: { canAttach: boolean; deviceLimit: number } = {
      canAttach: false,
      deviceLimit: 0,
    },
    purpose?: "agent" | "device-setup",
  ) {
    this.owner(p);
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
      attachment.deviceLimit > 20 ||
      (attachment.canAttach
        ? attachment.deviceLimit < 1
        : attachment.deviceLimit !== 0) ||
      (purpose === "agent" && attachment.canAttach) ||
      (purpose === "device-setup" && !attachment.canAttach)
    )
      throw new Fault("invalid", 400, "Invalid agent connection");
    this.state.agentConnections = this.state.agentConnections!.filter((c) =>
      connectionIsActive(c, this.now()),
    );
    if (this.state.agentConnections.length >= 20)
      throw new Fault("limit", 429, "Agent connection limit reached");
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
    this.capacity({
      agentConnections: [...this.state.agentConnections, connection],
    });
    this.state.agentConnections.push(connection);
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
      if (
        this.state.devices.filter((d) => !d.revoked).length >= 20 ||
        this.state.attachAttempts!.length >= 1000
      )
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
    ttlSeconds: number | null = 3600,
  ) {
    this.owner(p);
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
    this.capacity({ grants });
    this.state.grants = grants;
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
        "Workspace limit reached: 5,000 retained actions. New actions are paused; downloading history does not free capacity.",
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
    this.capacity({ actions: [...this.state.actions, a] });
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
  heartbeat(deviceId: string) {
    const device = this.device(deviceId);
    device.lastSeen = this.now();
    return { lastSeen: device.lastSeen };
  }
  next(deviceId: string) {
    this.expire();
    const d = this.device(deviceId);
    const a = this.state.actions.find(
      (a) => a.deviceId === deviceId && a.status === "queued",
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
    if (
      (!connectionValid ||
        !this.state.grants.some(
          (g) =>
            g.principal === principal &&
            g.deviceId === deviceId &&
            g.capabilities.includes(a.capability) &&
            grantIsActive(g, this.now()),
        )) &&
      !a.ownerAuthorized
    ) {
      a.status = "cancelled";
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
      (a) => a.id === id && a.deviceId === deviceId,
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
      isDesktopScreenshot(device.kind, a.capability)
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
