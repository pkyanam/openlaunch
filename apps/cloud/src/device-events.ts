/** Hibernatable, notification-only WebSocket support for a device Durable Object. */

export const DEVICE_EVENTS_PROTOCOL = "openlaunch.device.v1";
export const DEVICE_EVENTS_PING = "openlaunch.ping";
export const DEVICE_EVENTS_PONG = "openlaunch.pong";
export const DEVICE_EVENTS_TICKET_TTL_MS = 30_000;
export const DEVICE_EVENTS_MAX_FRAME_BYTES = 256;
const DEVICE_EVENTS_TAG_PREFIX = "openlaunch-device:";
const TICKET_KEY_PREFIX = "openlaunch:device-events:ticket:";
const DEVICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^[a-f0-9]{64}$/;
const HEX_TICKET = /^[a-f0-9]{64}$/;

export interface DeviceEventsStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface DeviceEventsSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DeviceEventsContext {
  storage: DeviceEventsStorage;
  acceptWebSocket(socket: DeviceEventsSocket, tags?: string[]): void;
  getWebSockets(tag?: string): DeviceEventsSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
}

export type DeviceEventsAuthenticator = (
  deviceId: string,
  bearerCredential: string,
  workspace: string,
) => Promise<unknown>;

export interface DeviceEventsOptions {
  now?: () => number;
  createTicket?: () => string;
  createPair?: () => [WebSocket, DeviceEventsSocket];
  upgradeResponse?: (client: WebSocket, protocol: string) => Response;
}

interface TicketRecord {
  hash: string;
  expiresAt: number;
}

interface Attachment {
  deviceId: string;
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function expectedError(error: unknown): Response {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    Number.isInteger(error.status) &&
    Number(error.status) >= 400 &&
    Number(error.status) < 500
  ) {
    const status = Number(error.status);
    const code =
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : "unauthorized";
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message.slice(0, 160)
        : "Device authentication failed";
    return errorResponse(status, code, message);
  }
  return errorResponse(500, "internal", "Device event request failed");
}

function bearer(request: Request): string {
  return (
    /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ??
    ""
  );
}

function pathMatches(request: Request, deviceId: string, suffix: string) {
  return (
    new URL(request.url).pathname === `/v1/device/${deviceId}/events${suffix}`
  );
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function ticketKey(deviceId: string) {
  return `${TICKET_KEY_PREFIX}${deviceId}`;
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await request.body?.cancel().catch(() => {});
    return null;
  }
  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function randomHexTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function defaultPair(): [WebSocket, DeviceEventsSocket] {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [
    WebSocket,
    DeviceEventsSocket,
  ];
  return [client, server];
}

function defaultUpgradeResponse(client: WebSocket, protocol: string): Response {
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "sec-websocket-protocol": protocol,
      "cache-control": "no-store",
    },
  } as ResponseInit & { webSocket: WebSocket });
}

/**
 * Device event channel for one workspace Durable Object. Construct it once in
 * the DO and call request handlers while inside its concurrency boundary.
 * The supplied authenticator should call Hub.authenticateDevice().
 */
export class DeviceEvents {
  private readonly now: () => number;
  private readonly createTicket: () => string;
  private readonly createPair: () => [WebSocket, DeviceEventsSocket];
  private readonly upgradeResponse: (
    client: WebSocket,
    protocol: string,
  ) => Response;

  constructor(
    private readonly ctx: DeviceEventsContext,
    private readonly authenticate: DeviceEventsAuthenticator,
    options: DeviceEventsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createTicket = options.createTicket ?? randomHexTicket;
    this.createPair = options.createPair ?? defaultPair;
    this.upgradeResponse = options.upgradeResponse ?? defaultUpgradeResponse;
    // Cloudflare's auto-response runs while hibernated without waking the DO.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(DEVICE_EVENTS_PING, DEVICE_EVENTS_PONG),
    );
  }

  /** Authenticated, single-use ticket issuance. Ticket is returned once and only its hash is stored. */
  async handleTicket(request: Request, deviceId: string): Promise<Response> {
    if (!DEVICE_ID.test(deviceId) || !pathMatches(request, deviceId, "-ticket"))
      return errorResponse(404, "not_found", "Route not found");
    if (request.method !== "POST")
      return errorResponse(405, "method", "Method not allowed");
    if (!sameOrigin(request))
      return errorResponse(403, "origin", "Cross-origin request rejected");
    const url = new URL(request.url);
    if (url.search || request.headers.get("upgrade"))
      return errorResponse(400, "invalid", "Invalid ticket request");
    const workspace = request.headers.get("x-openlaunch-workspace") ?? "";
    const credential = bearer(request);
    if (!WORKSPACE_ID.test(workspace) || !credential)
      return errorResponse(
        401,
        "unauthorized",
        "Device authentication required",
      );
    try {
      await this.authenticate(deviceId, credential, workspace);
    } catch (error) {
      return expectedError(error);
    }
    const text = await readBoundedBody(request, 128);
    if (text === null)
      return errorResponse(413, "too_large", "Ticket request body too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(
        400,
        "invalid_json",
        "Expected an empty JSON object",
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    )
      return errorResponse(400, "invalid", "Expected an empty JSON object");
    const ticket = this.createTicket();
    if (!HEX_TICKET.test(ticket))
      return errorResponse(500, "internal", "Could not issue event ticket");
    const record: TicketRecord = {
      hash: await digest(ticket),
      expiresAt: this.now() + DEVICE_EVENTS_TICKET_TTL_MS,
    };
    await this.ctx.storage.put(ticketKey(deviceId), record);
    return Response.json(
      { data: { ticket, expiresAt: record.expiresAt } },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  /**
   * Upgrade a socket using the one-use ticket offered as a WebSocket
   * subprotocol. The URL may contain only the public workspace ID.
   */
  async handleUpgrade(request: Request, deviceId: string): Promise<Response> {
    if (!DEVICE_ID.test(deviceId) || !pathMatches(request, deviceId, ""))
      return errorResponse(404, "not_found", "Route not found");
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return errorResponse(
        400,
        "upgrade_required",
        "WebSocket upgrade required",
      );
    if (!sameOrigin(request))
      return errorResponse(403, "origin", "Cross-origin request rejected");
    const url = new URL(request.url);
    const workspace = url.searchParams.get("workspace") ?? "";
    if (
      !WORKSPACE_ID.test(workspace) ||
      url.searchParams.size !== 1 ||
      request.headers.get("x-openlaunch-workspace") !== workspace ||
      request.headers.get("authorization")
    )
      return errorResponse(400, "invalid", "Invalid event connection request");
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((item) => item.trim());
    if (
      offered.length !== 2 ||
      offered[0] !== DEVICE_EVENTS_PROTOCOL ||
      !offered[1]?.startsWith("ticket.") ||
      !HEX_TICKET.test(offered[1].slice("ticket.".length))
    )
      return errorResponse(401, "unauthorized", "Valid event ticket required");
    const offeredTicket = offered[1].slice("ticket.".length);
    const stored = await this.ctx.storage.get<TicketRecord>(
      ticketKey(deviceId),
    );
    if (
      !stored ||
      stored.expiresAt <= this.now() ||
      !sameDigest(await digest(offeredTicket), stored.hash)
    ) {
      if (stored?.expiresAt !== undefined && stored.expiresAt <= this.now())
        await this.ctx.storage.delete(ticketKey(deviceId));
      return errorResponse(
        401,
        "unauthorized",
        "Event ticket is invalid or expired",
      );
    }
    // The WorkspaceHub calls this under blockConcurrencyWhile, making ticket
    // check-and-delete one-use across concurrent upgrade requests.
    await this.ctx.storage.delete(ticketKey(deviceId));
    const [client, server] = this.createPair();
    this.ctx.acceptWebSocket(server, [this.tag(deviceId)]);
    server.serializeAttachment({ deviceId } satisfies Attachment);
    for (const old of this.ctx.getWebSockets(this.tag(deviceId))) {
      if (old !== server) {
        try {
          old.close(4001, "replaced");
        } catch {
          // A stale close is harmless; targeted notifications use the live set.
        }
      }
    }
    return this.upgradeResponse(client, DEVICE_EVENTS_PROTOCOL);
  }

  /** Send a payload-free wake hint only to the specified device sockets. */
  notify(deviceIds: string[]): number {
    if (deviceIds.length > 20 || !deviceIds.every((id) => DEVICE_ID.test(id)))
      throw new TypeError("deviceIds must contain at most 20 device IDs");
    const message = JSON.stringify({ type: "work" });
    let sent = 0;
    for (const id of new Set(deviceIds)) {
      for (const socket of this.ctx.getWebSockets(this.tag(id))) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.send(message);
          sent++;
        } catch {
          // Notifications are hints; HTTP polling recovers a missed wake-up.
        }
      }
    }
    return sent;
  }

  /** Close every notification socket for a device after owner revocation. */
  async closeDevice(deviceId: string): Promise<number> {
    if (!DEVICE_ID.test(deviceId)) throw new TypeError("Invalid device ID");
    await this.ctx.storage.delete(ticketKey(deviceId));
    const sockets = this.ctx.getWebSockets(this.tag(deviceId));
    let closed = 0;
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.close(4003, "device_revoked");
        closed++;
      } catch {
        // Revocation already blocks canonical HTTP next/result requests.
      }
    }
    return closed;
  }

  /** Only a small fixed ping message is accepted from a connected device. */
  webSocketMessage(socket: DeviceEventsSocket, message: string | ArrayBuffer) {
    const size =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > DEVICE_EVENTS_MAX_FRAME_BYTES) {
      socket.close(1009, "message_too_large");
      return;
    }
    const attachment =
      socket.deserializeAttachment() as Partial<Attachment> | null;
    if (
      !attachment ||
      typeof attachment.deviceId !== "string" ||
      !DEVICE_ID.test(attachment.deviceId)
    ) {
      socket.close(1008, "invalid_socket");
      return;
    }
    if (message === DEVICE_EVENTS_PING) {
      socket.send(DEVICE_EVENTS_PONG);
      return;
    }
    socket.close(1008, "unsupported_message");
  }

  private tag(deviceId: string) {
    return `${DEVICE_EVENTS_TAG_PREFIX}${deviceId}`;
  }
}

/** Configure fixed ping/pong replies without waking an idle hibernated DO. */
export function configureDeviceEventsAutoResponse(
  ctx: Pick<DeviceEventsContext, "setWebSocketAutoResponse">,
) {
  ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair(DEVICE_EVENTS_PING, DEVICE_EVENTS_PONG),
  );
}
