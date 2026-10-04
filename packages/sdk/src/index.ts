/** Small, provider-neutral SDK for openlaunch agent and device integrations. */

export interface ClientOptions {
  /** openlaunch API origin, for example https://www.openlaunch.dev. */
  url: string;
  /** Owner-issued agent connection token. Keep it server-side and private. */
  token: string;
  /** Optional workspace routing ID for self-hosted/local bridges. */
  workspace?: string;
  /** Inject fetch for tests, runtimes, or a custom transport. */
  fetch?: typeof fetch;
}

export interface DeviceOptions {
  /** openlaunch API origin. */
  url: string;
  /** Workspace routing ID shown by the openlaunch console. */
  workspace: string;
  /** Existing device credential, for a previously enrolled device process. */
  credential?: string;
  /** Existing device ID, required when resuming with credential. */
  deviceId?: string;
  fetch?: typeof fetch;
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

/** Create a client authenticated as an owner-issued openlaunch agent connection. */
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
 * Create an outbound-polling device bridge. Enrollment credentials are held in
 * memory by this instance and returned once so the caller can persist them in
 * its own secret store. No credentials are written to disk or logged.
 */
export function createDevice(options: DeviceOptions) {
  if (!options.workspace || !/^[a-f0-9]{64}$/.test(options.workspace))
    throw new TypeError(
      "workspace must be the 64-character ID from the openlaunch console",
    );
  if (options.credential && !options.deviceId)
    throw new TypeError("deviceId is required when resuming with a credential");
  const base = normalizeUrl(options.url);
  let deviceId = options.deviceId;
  let credential = options.credential;
  const publicRequest = transport(base, options.fetch ?? globalThis.fetch, {
    "x-openlaunch-workspace": options.workspace,
  });
  const deviceRequest = <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    if (!deviceId || !credential)
      throw new TypeError(
        "Enroll this device before polling or reporting results",
      );
    return transport(base, options.fetch ?? globalThis.fetch, {
      "x-openlaunch-workspace": options.workspace,
      authorization: `Bearer ${credential}`,
    })<T>(path, init);
  };
  return {
    get deviceId() {
      return deviceId;
    },
    /** Publish implemented functions. Changed manifests revoke previous device grants. */
    publishManifest: (manifest: DeviceManifest) =>
      deviceRequest<{ ok: true; grantsRevoked: boolean }>(
        `/v1/device/${encodeURIComponent(deviceId ?? "")}/manifest`,
        json("POST", { manifest }),
      ),
    /** Exchange a one-use enrollment token for this device's private credential. */
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
