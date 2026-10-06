import { createDeviceEvents, type DeviceEventSocketFactory } from "./events.js";
export { createDeviceEvents } from "./events.js";
export type {
  DeviceEventOptions,
  DeviceEventSocket,
  DeviceEventSocketFactory,
} from "./events.js";

/** Small, provider-neutral SDK for openlaunch agent and device integrations. */

export interface ClientOptions {
  /** openlaunch API origin, for example https://www.openlaunch.dev. */
  url: string;
  /** Agent OAuth bearer or owner-issued agent API token. Keep it private. */
  token: string;
  /** Optional workspace routing ID for self-hosted/local bridges. */
  workspace?: string;
  /** Inject fetch for tests, runtimes, or a custom transport. */
  fetch?: typeof fetch;
}

export interface DeviceOptions {
  /** openlaunch API origin. */
  url: string;
  /** Owner-issued device setup token, used only to attach this device. */
  token?: string;
  /** Workspace routing ID for legacy enrollment or local device credentials. */
  workspace?: string;
  /** Existing device credential, for a previously enrolled device process. */
  credential?: string;
  /** Existing device ID, required when resuming with credential. */
  deviceId?: string;
  fetch?: typeof fetch;
  /** Optional WebSocket factory for runtimes or tests without global WebSocket. */
  webSocketFactory?: DeviceEventSocketFactory;
}

/** Return the workspace encoded in an device setup or agent API token. */
export function sdkTokenWorkspace(token: string): string | undefined {
  return /^ol_(?:sdk|agent)_([a-f0-9]{64})_[a-f0-9]{64}$/.exec(token)?.[1];
}

export interface DeviceManifest {
  name: string;
  /** Built-in kinds or a custom identifier such as `custom.my-board`. */
  kind: string;
  capabilities: string[];
  functions?: Array<{
    name: string;
    title: string;
    description: string;
    access: "read" | "write";
    inputSchema: {
      type: "object";
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: false;
    };
  }>;
}

export type AdapterHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface AdapterTool {
  title: string;
  description: string;
  access: "read" | "write";
  /** The exact JSON Schema accepted by the function. */
  inputSchema: NonNullable<DeviceManifest["functions"]>[number]["inputSchema"];
  handler: AdapterHandler;
}

/**
 * Derive an adapter manifest and its handler map from one tool declaration.
 * This keeps advertised function names and executable handlers in sync; it
 * does not infer schemas or implement device operations.
 */
export function createAdapter(input: {
  name: string;
  kind: string;
  tools: Record<string, AdapterTool>;
}): {
  manifest: DeviceManifest;
  handlers: Record<string, AdapterHandler>;
} {
  const entries = Object.entries(input.tools);
  const limit = input.kind.startsWith("home-assistant.")
    ? 64
    : input.kind === "linux"
      ? 24
      : 16;
  if (entries.length < 1 || entries.length > limit)
    throw new TypeError(
      `tools must contain 1–${limit} explicit function definitions`,
    );
  if (
    !input.name ||
    input.name.length > 64 ||
    !input.kind ||
    input.kind.length > 64
  )
    throw new TypeError("adapter name and kind must be 1–64 characters");
  const functions = entries.map(([name, tool]) => {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(name))
      throw new TypeError(`Invalid function name: ${name}`);
    if (
      !tool.title ||
      tool.title.length > 64 ||
      !tool.description ||
      tool.description.length > 240
    )
      throw new TypeError(`Invalid title or description for ${name}`);
    if (typeof tool.handler !== "function")
      throw new TypeError(`Function ${name} requires a handler`);
    if (
      !tool.inputSchema ||
      tool.inputSchema.type !== "object" ||
      tool.inputSchema.additionalProperties !== false ||
      !tool.inputSchema.properties ||
      !Array.isArray(tool.inputSchema.required)
    )
      throw new TypeError(
        `Function ${name} requires an explicit closed object input schema`,
      );
    return {
      name,
      title: tool.title,
      description: tool.description,
      access: tool.access,
      inputSchema: tool.inputSchema,
    };
  });
  return {
    manifest: {
      name: input.name,
      kind: input.kind,
      capabilities: entries.map(([name]) => name),
      functions,
    },
    handlers: Object.fromEntries(
      entries.map(([name, tool]) => [name, tool.handler]),
    ),
  };
}

export interface Device {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  online: boolean;
  [key: string]: unknown;
}

export interface Action {
  id: string;
  deviceId: string;
  capability: string;
  args: Record<string, unknown>;
  status:
    | "queued"
    | "received"
    | "succeeded"
    | "failed"
    | "expired"
    | "cancelled"
    | "unknown";
  createdAt: number;
  expiresAt: number;
  dispatchedAt?: number;
  resultReceivedAt?: number;
  result?: unknown;
  [key: string]: unknown;
}

export interface ActionRequest {
  capability: string;
  arguments?: Record<string, unknown>;
  /** Required to make retries safe. Reuse only for an identical request. */
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface FunctionDefinition {
  name: string;
  title: string;
  description: string;
  access: "read" | "write";
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}

export interface DeviceFunction {
  deviceId: string;
  deviceName: string;
  kind: string;
  definition: FunctionDefinition;
  guide: string;
}

export class OpenLaunchError extends Error {
  readonly name = "OpenLaunchError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

function normalizeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("url must be an absolute HTTPS URL");
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))
    throw new TypeError("url must use HTTPS (HTTP is allowed for localhost)");
  if (parsed.username || parsed.password)
    throw new TypeError("url must not contain embedded credentials");
  if (parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname))
    throw new TypeError(
      "url must be a bare origin without path, query or fragment",
    );
  return parsed.href.replace(/\/+$/, "");
}

const safeCode = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9_]{1,40}$/.test(value)
    ? value
    : "request_failed";

function transport(
  baseUrl: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
) {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...headers,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        cache: "no-store",
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new OpenLaunchError(
        "openlaunch request could not be completed",
        0,
        "network",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenLaunchError(
        "openlaunch returned an invalid response",
        response.status,
        "invalid_response",
      );
    }
    if (!response.ok) {
      const error =
        payload && typeof payload === "object" && "error" in payload
          ? (payload as { error?: { code?: unknown } }).error
          : undefined;
      const code = safeCode(error?.code);
      throw new OpenLaunchError(
        `openlaunch request failed (${response.status}, ${code})`,
        response.status,
        code,
      );
    }
    if (!payload || typeof payload !== "object" || !("data" in payload))
      throw new OpenLaunchError(
        "openlaunch returned an invalid response",
        response.status,
        "invalid_response",
      );
    return (payload as { data: T }).data;
  };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length > 128)
    throw new TypeError("idempotencyKey must be 1–128 characters");
}

/** Create an agent client authenticated with OAuth or an agent API connection. */
export function createClient(options: ClientOptions) {
  if (!options.token || /\s/.test(options.token))
    throw new TypeError("token must be a non-empty bearer credential");
  const base = normalizeUrl(options.url);
  const request = transport(base, options.fetch ?? globalThis.fetch, {
    authorization: `Bearer ${options.token}`,
    ...(options.workspace
      ? { "x-openlaunch-workspace": options.workspace }
      : {}),
  });
  return {
    listDevices: () => request<Device[]>("/v1/devices"),
    /** List only functions that this credential may currently use. */
    listFunctions: () => request<DeviceFunction[]>("/v1/functions"),
    requestAction: (deviceId: string, action: ActionRequest) => {
      validateIdempotencyKey(action.idempotencyKey);
      return request<Action>(
        `/v1/devices/${encodeURIComponent(deviceId)}/actions`,
        json("POST", {
          capability: action.capability,
          arguments: action.arguments ?? {},
          idempotencyKey: action.idempotencyKey,
          ...(action.ttlSeconds === undefined
            ? {}
            : { ttlSeconds: action.ttlSeconds }),
        }),
      );
    },
    getAction: (actionId: string) =>
      request<Action>(`/v1/actions/${encodeURIComponent(actionId)}`),
    cancelAction: (actionId: string) =>
      request<Action>(
        `/v1/actions/${encodeURIComponent(actionId)}/cancel`,
        json("POST"),
      ),
    broadcast: (input: {
      deviceIds: string[];
      capability: string;
      arguments?: Record<string, unknown>;
      idempotencyKey: string;
      ttlSeconds?: number;
    }) => {
      validateIdempotencyKey(input.idempotencyKey);
      return request<
        Array<{
          deviceId: string;
          action?: Action;
          error?: { code: string; message: string };
        }>
      >(
        "/v1/broadcasts",
        json("POST", {
          ...input,
          arguments: input.arguments ?? {},
        }),
      );
    },
  };
}

/**
 * Create an outbound-polling device bridge. The issued per-device credential
 * remains in memory and is returned so callers can persist it securely.
 * The device setup token is used only for attach and is never returned.
 */
export function createDevice(options: DeviceOptions) {
  const tokenWorkspace = options.token
    ? sdkTokenWorkspace(options.token)
    : undefined;
  if (
    options.token &&
    (!tokenWorkspace || !options.token.startsWith("ol_sdk_"))
  )
    throw new TypeError(
      "Use a device setup token (ol_sdk_); agent tokens cannot pair devices",
    );
  const workspace = tokenWorkspace ?? options.workspace;
  if (!workspace || !/^[a-f0-9]{64}$/.test(workspace))
    throw new TypeError(
      "workspace must be the 64-character ID from the openlaunch console",
    );
  if (
    tokenWorkspace &&
    options.workspace &&
    options.workspace !== tokenWorkspace
  )
    throw new TypeError("workspace does not match the SDK token");
  if (options.credential && !options.deviceId)
    throw new TypeError("deviceId is required when resuming with a credential");
  const base = normalizeUrl(options.url);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let deviceId = options.deviceId;
  let credential = options.credential;
  const publicRequest = transport(base, fetchImpl, {
    "x-openlaunch-workspace": workspace,
  });
  const attachRequest = transport(base, fetchImpl, {
    "x-openlaunch-workspace": workspace,
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });
  const deviceRequest = <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    if (!deviceId || !credential)
      throw new TypeError(
        "Attach or enroll this device before polling or reporting results",
      );
    return transport(base, fetchImpl, {
      "x-openlaunch-workspace": workspace,
      authorization: `Bearer ${credential}`,
    })<T>(path, init);
  };
  return {
    get deviceId() {
      return deviceId;
    },
    /** Start optional event wakeups; callers must still poll over HTTP. */
    openEvents(onWake: () => void) {
      if (!deviceId || !credential)
        throw new TypeError(
          "Attach or enroll this device before opening events",
        );
      return createDeviceEvents({
        url: base,
        workspace,
        deviceId,
        credential,
        fetch: fetchImpl,
        webSocketFactory: options.webSocketFactory,
        onWake,
      });
    },
    /** Publish implemented functions. Changed manifests revoke previous device grants. */
    publishManifest: (manifest: DeviceManifest) =>
      deviceRequest<{ ok: true; grantsRevoked: boolean }>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/manifest`,
        json("POST", { manifest }),
      ),
    /** A gateway uses its private credential to discover linked devices, never grants. */
    gatewayChildren: (children: { key: string; manifest: DeviceManifest }[]) =>
      deviceRequest<
        Array<{
          key: string;
          deviceId?: string;
          revoked?: boolean;
          grantsRevoked?: boolean;
          error?: { code: string; message: string };
        }>
      >(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/children`,
        json("POST", { children }),
      ),
    gatewayStatus: (online: boolean, keys?: string[]) =>
      deviceRequest<{ ok: true }>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/children/status`,
        json("POST", { online, ...(keys ? { keys } : {}) }),
      ),
    heartbeat: () =>
      deviceRequest<{ lastSeen: number }>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/heartbeat`,
        json("POST", {}),
      ),
    /** Legacy: exchange a one-use enrollment token for a device credential. */
    async enroll(input: { token: string; manifest: DeviceManifest }) {
      if (!input.token || !input.manifest)
        throw new TypeError("token and manifest are required");
      const enrolled = await publicRequest<{ deviceId: string; token: string }>(
        "/v1/device/enroll",
        json("POST", { token: input.token, manifest: input.manifest }),
      );
      deviceId = enrolled.deviceId;
      credential = enrolled.token;
      return { deviceId, token: enrolled.token };
    },
    /** Attach with a device setup token; retries must reuse requestId and manifest. */
    async attach(manifest: DeviceManifest, requestId: string) {
      if (!options.token)
        throw new TypeError(
          "A device setup token is required to attach this device",
        );
      if (deviceId && credential)
        throw new TypeError(
          "This device client already has an identity; create a new client to attach another device",
        );
      if (!manifest) throw new TypeError("manifest is required");
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))
        throw new TypeError("requestId must be a UUID");
      const attached = await attachRequest<{ deviceId: string; token: string }>(
        "/v1/sdk/devices",
        json("POST", { requestId, manifest }),
      );
      deviceId = attached.deviceId;
      credential = attached.token;
      return { deviceId, token: attached.token };
    },
    /** Poll once. `null` means no work is queued; queued does not mean completed. */
    nextAction: () =>
      deviceRequest<Action | null>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/next`,
        json("POST", {}),
      ),
    /** Report the actual device execution result for a dispatched action. */
    submitResult: (
      actionId: string,
      result: { status: "succeeded" | "failed"; result: unknown },
    ) =>
      deviceRequest<Action>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/result`,
        json("POST", {
          actionId,
          status: result.status,
          result: result.result,
        }),
      ),
  };
}
