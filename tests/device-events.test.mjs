import test from "node:test";
import assert from "node:assert/strict";
import {
  DeviceEvents,
  DEVICE_EVENTS_MAX_FRAME_BYTES,
  DEVICE_EVENTS_PING,
  DEVICE_EVENTS_PONG,
  DEVICE_EVENTS_PROTOCOL,
  DEVICE_EVENTS_TICKET_TTL_MS,
} from "../apps/cloud/src/device-events.ts";

globalThis.WebSocketRequestResponsePair ??= class {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

const workspace = "a".repeat(64);
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const deviceToken = "device-credential-never-in-url";

class MemoryStorage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
}

class Socket {
  readyState = 1;
  sent = [];
  closed = [];
  attachment = null;
  send(value) {
    this.sent.push(value);
  }
  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

function fixture(options = {}) {
  const storage = new MemoryStorage();
  const accepted = [];
  const ctx = {
    storage,
    accepted,
    autoResponse: null,
    setWebSocketAutoResponse(pair) {
      this.autoResponse = pair;
    },
    acceptWebSocket(socket, tags = []) {
      accepted.push({ socket, tags });
    },
    getWebSockets(tag) {
      return accepted
        .filter((entry) => !tag || entry.tags.includes(tag))
        .map((entry) => entry.socket);
    },
  };
  const pairs = [];
  const events = new DeviceEvents(
    ctx,
    options.authenticate ?? (async () => {}),
    {
      now: options.now ?? (() => 1_000),
      createTicket: options.createTicket ?? (() => "b".repeat(64)),
      createPair: () => {
        const client = {};
        const server = new Socket();
        pairs.push({ client, server });
        return [client, server];
      },
      upgradeResponse: (webSocket, protocol) => ({
        status: 101,
        webSocket,
        headers: new Headers({ "sec-websocket-protocol": protocol }),
      }),
    },
  );
  return { ctx, storage, accepted, pairs, events };
}

function ticketRequest(deviceId, token = deviceToken, body = "{}") {
  return new Request(
    `https://openlaunch.test/v1/device/${deviceId}/events-ticket`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-openlaunch-workspace": workspace,
      },
      body,
    },
  );
}

function upgradeRequest(deviceId, ticket, query = workspace) {
  return new Request(
    `https://openlaunch.test/v1/device/${deviceId}/events?workspace=${query}`,
    {
      headers: {
        upgrade: "websocket",
        "x-openlaunch-workspace": query,
        "sec-websocket-protocol": `${DEVICE_EVENTS_PROTOCOL}, ticket.${ticket}`,
      },
    },
  );
}

test("ticket issuance authenticates the device, stores only a hash, and upgrades once", async () => {
  const authenticated = [];
  const f = fixture({
    authenticate: async (...args) => authenticated.push(args),
  });
  const invalidBody = await f.events.handleTicket(
    ticketRequest(firstId, deviceToken, '{"extra":true}'),
    firstId,
  );
  assert.equal(invalidBody.status, 400);
  assert.equal(
    authenticated.length,
    1,
    "authenticate before parsing the request body",
  );

  const issued = await f.events.handleTicket(ticketRequest(firstId), firstId);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const { data } = await issued.json();
  assert.equal(data.ticket, "b".repeat(64));
  assert.equal(data.expiresAt, 1_000 + DEVICE_EVENTS_TICKET_TTL_MS);
  assert.deepEqual(authenticated, [
    [firstId, deviceToken, workspace],
    [firstId, deviceToken, workspace],
  ]);
  assert.equal(
    JSON.stringify([...f.storage.values.values()]).includes(data.ticket),
    false,
  );
  assert.equal(issued.url.includes(data.ticket), false);

  const wrongDevice = await f.events.handleUpgrade(
    upgradeRequest(secondId, data.ticket),
    secondId,
  );
  assert.equal(wrongDevice.status, 401);
  assert.equal(f.accepted.length, 0);

  const upgrade = await f.events.handleUpgrade(
    upgradeRequest(firstId, data.ticket),
    firstId,
  );
  assert.equal(upgrade.status, 101);
  assert.equal(
    upgrade.headers.get("sec-websocket-protocol"),
    DEVICE_EVENTS_PROTOCOL,
  );
  assert.equal(f.accepted.length, 1);
  assert.deepEqual(f.pairs[0].server.attachment, { deviceId: firstId });
  assert.deepEqual(Object.keys(f.pairs[0].server.attachment), ["deviceId"]);
  assert.equal(f.ctx.autoResponse.request, DEVICE_EVENTS_PING);
  assert.equal(f.ctx.autoResponse.response, DEVICE_EVENTS_PONG);
  const replay = await f.events.handleUpgrade(
    upgradeRequest(firstId, data.ticket),
    firstId,
  );
  assert.equal(replay.status, 401);
});

test("tickets expire, are replaced per device, and reject secret-bearing URLs", async () => {
  let now = 5_000;
  const generated = ["c".repeat(64), "d".repeat(64)];
  const f = fixture({ now: () => now, createTicket: () => generated.shift() });
  const first = await (
    await f.events.handleTicket(ticketRequest(firstId), firstId)
  ).json();
  const second = await (
    await f.events.handleTicket(ticketRequest(firstId), firstId)
  ).json();
  assert.equal(
    (
      await f.events.handleUpgrade(
        upgradeRequest(firstId, first.data.ticket),
        firstId,
      )
    ).status,
    401,
  );

  const withExtraQuery = await f.events.handleUpgrade(
    new Request(
      `https://openlaunch.test/v1/device/${firstId}/events?workspace=${workspace}&token=${second.data.ticket}`,
      {
        headers: {
          upgrade: "websocket",
          "x-openlaunch-workspace": workspace,
          "sec-websocket-protocol": `${DEVICE_EVENTS_PROTOCOL}, ticket.${second.data.ticket}`,
        },
      },
    ),
    firstId,
  );
  assert.equal(withExtraQuery.status, 400);

  now += DEVICE_EVENTS_TICKET_TTL_MS + 1;
  const expired = await f.events.handleUpgrade(
    upgradeRequest(firstId, second.data.ticket),
    firstId,
  );
  assert.equal(expired.status, 401);
  assert.equal(f.accepted.length, 0);
});

test("revocation removes an unconsumed ticket so it cannot upgrade afterward", async () => {
  const f = fixture();
  const issued = await f.events.handleTicket(ticketRequest(firstId), firstId);
  const { data } = await issued.json();
  const closed = await f.events.closeDevice(firstId);
  assert.equal(closed, 0);
  assert.equal(f.storage.values.size, 0);
  const afterRevoke = await f.events.handleUpgrade(
    upgradeRequest(firstId, data.ticket),
    firstId,
  );
  assert.equal(afterRevoke.status, 401);
  assert.equal(f.accepted.length, 0);
});

test("authenticated ticket body reader stops at 128 streamed bytes", async () => {
  let authenticated = false;
  let firstReadAfterAuthentication = false;
  let cancelled = false;
  let chunks = 0;
  const f = fixture({
    authenticate: async () => {
      authenticated = true;
    },
  });
  const body = new ReadableStream(
    {
      pull(controller) {
        firstReadAfterAuthentication ||= authenticated;
        chunks++;
        controller.enqueue(new Uint8Array(chunks === 1 ? 100 : 40));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(
    `https://openlaunch.test/v1/device/${firstId}/events-ticket`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-openlaunch-workspace": workspace,
      },
      body,
      duplex: "half",
    },
  );
  const response = await f.events.handleTicket(request, firstId);
  assert.equal(response.status, 413);
  assert.equal(authenticated, true);
  assert.equal(firstReadAfterAuthentication, true);
  assert.equal(chunks, 2);
  assert.equal(cancelled, true);
  assert.equal(f.storage.values.size, 0);
});

test("work hints are bounded, targeted, payload-free, and device revocation closes sockets", async () => {
  const f = fixture({
    createTicket: (() => {
      let n = 0;
      return () => String(++n).padStart(64, "0");
    })(),
  });
  async function connect(id) {
    const { data } = await (
      await f.events.handleTicket(ticketRequest(id), id)
    ).json();
    const response = await f.events.handleUpgrade(
      upgradeRequest(id, data.ticket),
      id,
    );
    assert.equal(response.status, 101);
    return f.pairs.at(-1).server;
  }
  const first = await connect(firstId);
  const second = await connect(secondId);
  assert.equal(f.events.notify([firstId, firstId]), 1);
  assert.deepEqual(first.sent, ['{"type":"work"}']);
  assert.deepEqual(second.sent, []);
  assert.equal(f.events.notify([firstId, secondId]), 2);
  assert.equal(
    first.sent.every((message) => message === '{"type":"work"}'),
    true,
  );
  assert.equal(
    second.sent.every((message) => message === '{"type":"work"}'),
    true,
  );

  f.events.webSocketMessage(first, DEVICE_EVENTS_PING);
  assert.equal(first.sent.at(-1), DEVICE_EVENTS_PONG);
  f.events.webSocketMessage(
    first,
    "x".repeat(DEVICE_EVENTS_MAX_FRAME_BYTES + 1),
  );
  assert.deepEqual(first.closed.at(-1), {
    code: 1009,
    reason: "message_too_large",
  });
  f.events.webSocketMessage(second, "not-a-ping");
  assert.deepEqual(second.closed.at(-1), {
    code: 1008,
    reason: "unsupported_message",
  });

  const active = await connect(firstId);
  assert.equal(first.closed.at(-1).code, 4001);
  assert.equal(await f.events.closeDevice(firstId), 1);
  assert.deepEqual(active.closed.at(-1), {
    code: 4003,
    reason: "device_revoked",
  });
  assert.equal(second.readyState, 3);
});

test("invalid bearer, workspace, origin, or protocol cannot create a socket", async () => {
  let authCalls = 0;
  const f = fixture({
    authenticate: async () => {
      authCalls++;
      throw Object.assign(new Error("bad credential"), {
        status: 401,
        code: "unauthorized",
      });
    },
  });
  const badToken = await f.events.handleTicket(
    ticketRequest(firstId, "wrong"),
    firstId,
  );
  assert.equal(badToken.status, 401);
  assert.equal(authCalls, 1);
  assert.equal(f.storage.values.size, 0);

  const malformedWorkspace = await f.events.handleTicket(
    new Request(`https://openlaunch.test/v1/device/${firstId}/events-ticket`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-openlaunch-workspace": "bad",
      },
      body: "{}",
    }),
    firstId,
  );
  assert.equal(malformedWorkspace.status, 401);
  assert.equal(authCalls, 1);

  const badOrigin = await f.events.handleTicket(
    new Request(`https://openlaunch.test/v1/device/${firstId}/events-ticket`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-openlaunch-workspace": workspace,
        origin: "https://attacker.test",
      },
      body: "{}",
    }),
    firstId,
  );
  assert.equal(badOrigin.status, 403);
  assert.equal(f.accepted.length, 0);
});
