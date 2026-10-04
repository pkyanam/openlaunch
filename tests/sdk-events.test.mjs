import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceEvents } from "../packages/sdk/src/events.ts";
import { runDevice } from "../packages/sdk/src/cli.ts";

const workspace = "a".repeat(64);
const deviceId = "11111111-1111-4111-8111-111111111111";
const credential = "device-child-secret";

class MockSocket {
  listeners = new Map();
  sent = [];
  closeCount = 0;
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closeCount++;
    this.emit("close", {});
  }
}

async function until(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for event state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runnerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-events-"));
  const manifest = {
    name: "event fixture",
    kind: "custom.device",
    capabilities: ["custom.echo"],
  };
  await writeFile(
    join(directory, "identity.json"),
    JSON.stringify({
      url: "https://bridge.example",
      workspace,
      deviceId,
      credential,
      manifest,
    }),
  );
  await writeFile(
    join(directory, "adapter.mjs"),
    `export const manifest = ${JSON.stringify(manifest)}; export const handlers = { "custom.echo": async () => ({ ok: true }) };`,
  );
  return directory;
}

test("event tickets stay out of URLs; work wakes and protocol pong is ignored safely", async () => {
  let ticketCalls = 0;
  let wakeCount = 0;
  const sockets = [];
  let socketUrl = "";
  let socketProtocols = [];
  const events = createDeviceEvents({
    url: "https://bridge.example",
    workspace,
    deviceId,
    credential,
    random: () => 0,
    fetch: async (url, init) => {
      ticketCalls++;
      assert.equal(
        String(url),
        `https://bridge.example/v1/device/${deviceId}/events-ticket`,
      );
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, `Bearer ${credential}`);
      assert.equal(init.headers["x-openlaunch-workspace"], workspace);
      assert.equal(init.body, "{}");
      return Response.json({
        data: { ticket: "1".repeat(64), expiresAt: Date.now() + 10_000 },
      });
    },
    webSocketFactory: (url, protocols) => {
      socketUrl = url;
      socketProtocols = protocols;
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    onWake: () => wakeCount++,
  });
  events.start();
  await until(() => sockets.length === 1);
  assert.equal(ticketCalls, 1);
  assert.equal(new URL(socketUrl).protocol, "wss:");
  assert.equal(new URL(socketUrl).searchParams.get("workspace"), workspace);
  assert.equal(socketUrl.includes(credential), false);
  assert.equal(socketUrl.includes("1".repeat(64)), false);
  assert.deepEqual(socketProtocols, [
    "openlaunch.device.v1",
    `ticket.${"1".repeat(64)}`,
  ]);
  sockets[0].emit("open");
  sockets[0].emit("message", { data: "openlaunch.pong" });
  sockets[0].emit("message", { data: JSON.stringify({ type: "work" }) });
  sockets[0].emit("message", {
    data: JSON.stringify({ type: "work", action: { id: "ignored" } }),
  });
  assert.deepEqual(sockets[0].sent, []);
  assert.equal(wakeCount, 3);
  events.close();
  assert.equal(sockets[0].closeCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ticketCalls, 1, "close must clear reconnect and expiry timers");
});

test("runner catches up over HTTP on socket open and closes the channel on stop", async () => {
  const directory = await runnerFixture();
  try {
    const sockets = [];
    let nextCalls = 0;
    let resultCalls = 0;
    const action = {
      id: "22222222-2222-4222-8222-222222222222",
      deviceId,
      capability: "custom.echo",
      args: {},
      status: "queued",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    const running = runDevice({
      directory,
      pollMs: 60_000,
      input: { isTTY: false },
      output: { write() {} },
      fetch: async (url, init) => {
        if (String(url).endsWith("/events-ticket"))
          return Response.json({
            data: { ticket: "2".repeat(64), expiresAt: Date.now() + 10_000 },
          });
        if (String(url).endsWith("/next"))
          return Response.json({ data: nextCalls++ === 0 ? null : action });
        if (String(url).endsWith("/result")) {
          resultCalls++;
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({
            data: {
              ...action,
              status: "succeeded",
              result: JSON.parse(init.body).result,
            },
          });
        }
        throw new Error(`Unexpected request ${url} ${init?.method ?? ""}`);
      },
      webSocketFactory: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await until(() => sockets.length === 1 && nextCalls >= 1);
    sockets[0].emit("open");
    await running;
    assert(nextCalls >= 2);
    assert.equal(resultCalls, 1);
    assert.equal(sockets[0].closeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("work hints interrupt the poll wait without starting parallel handlers", async () => {
  const directory = await runnerFixture();
  try {
    const sockets = [];
    let nextCalls = 0;
    let resolveResultStarted;
    const resultStarted = new Promise((resolve) => {
      resolveResultStarted = resolve;
    });
    let finishResult;
    const resultGate = new Promise((resolve) => {
      finishResult = resolve;
    });
    const action = {
      id: "44444444-4444-4444-8444-444444444444",
      deviceId,
      capability: "custom.echo",
      args: {},
      status: "queued",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    const running = runDevice({
      directory,
      pollMs: 60_000,
      input: { isTTY: false },
      output: { write() {} },
      fetch: async (url, init) => {
        if (String(url).endsWith("/events-ticket"))
          return Response.json({
            data: { ticket: "3".repeat(64), expiresAt: Date.now() + 10_000 },
          });
        if (String(url).endsWith("/next")) {
          nextCalls++;
          return Response.json({ data: nextCalls === 3 ? action : null });
        }
        if (String(url).endsWith("/result")) {
          resolveResultStarted();
          await resultGate;
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({
            data: {
              ...action,
              status: "succeeded",
              result: JSON.parse(init.body).result,
            },
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      webSocketFactory: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await until(() => sockets.length === 1 && nextCalls === 1);
    sockets[0].emit("open");
    await until(() => nextCalls === 2);
    sockets[0].emit("message", { data: JSON.stringify({ type: "work" }) });
    await resultStarted;
    for (let i = 0; i < 5; i++)
      sockets[0].emit("message", { data: JSON.stringify({ type: "work" }) });
    assert.equal(
      nextCalls,
      3,
      "work hints cannot start another poll while a handler result is pending",
    );
    finishResult();
    await running;
    assert.equal(sockets[0].closeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("socket reconnect obtains a fresh ticket; a failed event channel leaves polling available", async () => {
  let ticketCalls = 0;
  const sockets = [];
  const events = createDeviceEvents({
    url: "https://bridge.example",
    workspace,
    deviceId,
    credential,
    random: () => 0,
    fetch: async () => {
      ticketCalls++;
      return Response.json({
        data: {
          ticket: String(ticketCalls).repeat(64),
          expiresAt: Date.now() + 10_000,
        },
      });
    },
    webSocketFactory: (_url, protocols) => {
      assert.equal(
        protocols[1],
        `ticket.${String(sockets.length + 1).repeat(64)}`,
      );
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    onWake() {},
  });
  events.start();
  await until(() => sockets.length === 1);
  sockets[0].emit("open");
  sockets[0].emit("close");
  await until(() => sockets.length === 2, 2_000);
  assert.equal(ticketCalls, 2);
  events.close();
  assert.equal(sockets[1].closeCount, 1);

  const directory = await runnerFixture();
  try {
    let nextCalls = 0;
    let resultCalls = 0;
    const action = {
      id: "33333333-3333-4333-8333-333333333333",
      deviceId,
      capability: "custom.echo",
      args: {},
      status: "queued",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    await runDevice({
      directory,
      pollMs: 10,
      input: { isTTY: false },
      output: { write() {} },
      fetch: async (url, init) => {
        if (String(url).endsWith("/events-ticket"))
          throw new Error("offline notifications");
        if (String(url).endsWith("/next"))
          return Response.json({ data: nextCalls++ === 0 ? null : action });
        if (String(url).endsWith("/result")) {
          resultCalls++;
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({
            data: {
              ...action,
              status: "succeeded",
              result: JSON.parse(init.body).result,
            },
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      webSocketFactory: () => {
        throw new Error("should not open a socket without a ticket");
      },
    });
    assert(nextCalls >= 2);
    assert.equal(resultCalls, 1);
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.equal(journal[action.id].acknowledged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ticket expiry limits the handshake only; startup is idempotent and frames are bounded", async () => {
  let ticketCalls = 0;
  let wakeCount = 0;
  const sockets = [];
  const events = createDeviceEvents({
    url: "https://bridge.example",
    workspace,
    deviceId,
    credential,
    fetch: async () => {
      ticketCalls++;
      return Response.json({
        data: { ticket: "a".repeat(64), expiresAt: Date.now() + 30 },
      });
    },
    webSocketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    onWake: () => wakeCount++,
  });
  events.start();
  events.start();
  await until(() => sockets.length === 1);
  sockets[0].emit("open");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(
    sockets[0].closeCount,
    0,
    "ticket expiry must not close an open socket",
  );
  assert.equal(
    ticketCalls,
    1,
    "repeated start must not open duplicate sockets",
  );
  sockets[0].emit("message", { data: "x".repeat(257) });
  sockets[0].emit("message", { data: "openlaunch.pong" });
  sockets[0].emit("message", { data: JSON.stringify({ type: "work" }) });
  assert.equal(
    wakeCount,
    2,
    "oversized input is ignored and pong is handled safely",
  );
  events.close();
});

test("ping/pong keeps the socket alive and unsolicited pong cannot leave shutdown timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new MockSocket();
  let tickets = 0;
  const events = createDeviceEvents({
    url: "https://bridge.example",
    workspace,
    deviceId,
    credential,
    fetch: async () => {
      tickets++;
      return Response.json({
        data: { ticket: "b".repeat(64), expiresAt: Date.now() + 30000 },
      });
    },
    webSocketFactory: () => socket,
    onWake() {},
  });
  events.start();
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("open");
  socket.emit("message", { data: "openlaunch.pong" }); // No ping outstanding.
  t.mock.timers.tick(25000);
  assert.deepEqual(socket.sent, ["openlaunch.ping"]);
  socket.emit("message", { data: "openlaunch.pong" });
  t.mock.timers.tick(25000);
  assert.deepEqual(socket.sent, ["openlaunch.ping", "openlaunch.ping"]);
  assert.equal(socket.closeCount, 0);
  events.close();
  t.mock.timers.tick(120000);
  assert.equal(tickets, 1);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.closeCount, 1);
});
