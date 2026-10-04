/** Optional authenticated WebSocket wake channel for device polling. */

export interface DeviceEventSocket {
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
  ): void;
  removeEventListener?(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export type DeviceEventSocketFactory = (
  url: string,
  protocols: string[],
) => DeviceEventSocket;

export interface DeviceEventOptions {
  url: string;
  workspace: string;
  deviceId: string;
  credential: string;
  fetch?: typeof fetch;
  webSocketFactory?: DeviceEventSocketFactory;
  onWake: () => void;
  random?: () => number;
}

const MAX_RECONNECT_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 256;

/**
 * Open a revocable-ticket WebSocket and notify the poller when a work hint
 * arrives. It never receives action data and can be safely closed at shutdown.
 */
export function createDeviceEvents(options: DeviceEventOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const webSocketFactory =
    options.webSocketFactory ??
    ((url, protocols) =>
      new WebSocket(url, protocols) as unknown as DeviceEventSocket);
  let stopped = false;
  let socket: DeviceEventSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let ticketAbort: AbortController | undefined;
  let reconnectAttempt = 0;
  let listenerCleanup: (() => void) | undefined;
  let started = false;
  let connecting = false;

  const wake = () => {
    try {
      options.onWake();
    } catch {
      // Notification delivery is advisory and cannot break HTTP polling.
    }
  };

  const eventUrl = () => {
    const target = new URL(
      `/v1/device/${encodeURIComponent(options.deviceId)}/events`,
      options.url,
    );
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("workspace", options.workspace);
    return target.href;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const ceiling = Math.min(
      1_000 * 2 ** Math.min(reconnectAttempt, 10),
      MAX_RECONNECT_MS,
    );
    reconnectAttempt++;
    const jitter =
      0.75 +
      Math.max(0, Math.min(1, options.random?.() ?? Math.random())) * 0.5;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined;
        void connect();
      },
      Math.floor(ceiling * jitter),
    );
  };

  const connect = async () => {
    if (stopped || connecting || socket) return;
    connecting = true;
    ticketAbort = new AbortController();
    let ticket: string;
    let expiresAt: number;
    try {
      const response = await fetchImpl(
        `${options.url}/v1/device/${encodeURIComponent(options.deviceId)}/events-ticket`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.credential}`,
            "x-openlaunch-workspace": options.workspace,
            "content-type": "application/json",
          },
          body: "{}",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([
            ticketAbort.signal,
            AbortSignal.timeout(10_000),
          ]),
        },
      );
      if (!response.ok) throw new Error("ticket request failed");
      const payload = (await response.json()) as {
        data?: { ticket?: unknown; expiresAt?: unknown };
      };
      if (
        typeof payload?.data?.ticket !== "string" ||
        !/^[a-f0-9]{64}$/.test(payload.data.ticket) ||
        typeof payload.data.expiresAt !== "number" ||
        payload.data.expiresAt <= Date.now()
      )
        throw new Error("invalid ticket response");
      ticket = payload.data.ticket;
      expiresAt = payload.data.expiresAt;
    } catch {
      ticketAbort = undefined;
      connecting = false;
      scheduleReconnect();
      return;
    }
    ticketAbort = undefined;
    connecting = false;
    if (stopped || expiresAt <= Date.now()) {
      scheduleReconnect();
      return;
    }

    let current: DeviceEventSocket;
    try {
      current = webSocketFactory(eventUrl(), [
        "openlaunch.device.v1",
        `ticket.${ticket}`,
      ]);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    let cleaned = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let awaitingPong = false;
    let schedulePing = () => {};
    const clearHandshake = () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    };
    const cleanupListeners = () => {
      if (cleaned) return;
      cleaned = true;
      current.removeEventListener?.("open", onOpen);
      current.removeEventListener?.("close", onClose);
      current.removeEventListener?.("error", onError);
      current.removeEventListener?.("message", onMessage);
      clearHandshake();
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = undefined;
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = undefined;
      awaitingPong = false;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = undefined;
      if (socket === current) socket = undefined;
      if (listenerCleanup === cleanupListeners) listenerCleanup = undefined;
    };
    const onOpen = () => {
      if (stopped) {
        current.close();
        return;
      }
      stableTimer = setTimeout(() => {
        reconnectAttempt = 0;
        stableTimer = undefined;
      }, 30_000);
      clearHandshake();
      wake(); // Catch up immediately; hints may have arrived before subscription.
      schedulePing = () => {
        if (stopped || cleaned) return;
        if (pingTimer) clearTimeout(pingTimer);
        pingTimer = setTimeout(() => {
          pingTimer = undefined;
          if (stopped || cleaned || awaitingPong) return;
          awaitingPong = true;
          try {
            current.send("openlaunch.ping");
          } catch {
            onError();
            return;
          }
          pongTimer = setTimeout(() => {
            pongTimer = undefined;
            if (!awaitingPong) return;
            onError();
            try {
              current.close();
            } catch {
              /* Ignore close errors. */
            }
          }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      };
      schedulePing();
    };
    const onClose = () => {
      cleanupListeners();
      if (!stopped) scheduleReconnect();
    };
    const onError = () => {
      cleanupListeners();
      if (!stopped) scheduleReconnect();
      try {
        current.close();
      } catch {
        // A failed optional socket is ignored.
      }
    };
    const onMessage = (event: { data?: unknown }) => {
      if (typeof event.data !== "string") return;
      if (new TextEncoder().encode(event.data).byteLength > MAX_FRAME_BYTES)
        return;
      if (event.data === "openlaunch.pong") {
        if (!awaitingPong) return;
        awaitingPong = false;
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = undefined;
        schedulePing();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      const type = (message as { type?: unknown }).type;
      if (type === "work") wake();
      // Server pings are answered by Cloudflare's hibernation-safe auto-response.
    };
    current.addEventListener("open", onOpen);
    current.addEventListener("close", onClose);
    current.addEventListener("error", onError);
    current.addEventListener("message", onMessage);
    listenerCleanup = cleanupListeners;

    // A ticket authorizes only the handshake, never the established socket lifetime.
    handshakeTimer = setTimeout(
      () => {
        if (cleaned) return;
        onError();
        try {
          current.close();
        } catch {
          /* Ignore close errors. */
        }
      },
      Math.max(0, Math.min(10_000, expiresAt - Date.now())),
    );
  };

  const start = () => {
    if (stopped || started) return;
    started = true;
    void connect();
  };

  const close = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    ticketAbort?.abort();
    ticketAbort = undefined;
    const current = socket;
    listenerCleanup?.();
    try {
      current?.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    socket = undefined;
  };

  return { start, close };
}
