import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, emptyState, manifestSchema } from "../packages/core/src/index.ts";
import { createDeviceCredentialDeriver } from "../packages/core/src/device-credentials.ts";
import { handle } from "../packages/http/src/index.ts";
import { createToolCatalog } from "../packages/mcp/src/index.ts";
import {
  HomeAssistant,
  discoverHA,
  gatewayManifest,
  normalizeHAUrl,
  validServiceData,
} from "../packages/sdk/src/home-assistant.ts";
import {
  setupHomeAssistant,
  runHomeAssistant,
  publishHAInventory,
} from "../packages/sdk/src/home-assistant-cli.ts";
import { createDevice } from "../packages/sdk/src/index.ts";
import { loadJournal } from "../packages/sdk/src/cli.ts";
const owner = { id: "owner", owner: true },
  agent = { id: "agent", owner: false },
  workspace = "a".repeat(64);
const snapshot = {
  name: "Test home",
  version: "2026.10.0",
  observedAt: Date.now(),
  states: [
    {
      entity_id: "input_boolean.test",
      state: "off",
      attributes: { friendly_name: "Test toggle" },
    },
  ],
  services: {
    input_boolean: {
      turn_on: {
        name: "Turn on",
        target: { entity: [{ domain: ["input_boolean"] }] },
        fields: {},
      },
      turn_off: {
        name: "Turn off",
        target: { entity: [{ domain: ["input_boolean"] }] },
        fields: {},
      },
      toggle: { name: "Toggle", target: {}, fields: {} },
    },
    system_log: { write: { fields: { message: { required: true } } } },
  },
};
async function fixture(limit = 50, attach = true) {
  let now = Date.now();
  const hub = new Hub(emptyState(), () => now);
  const credentials = createDeviceCredentialDeriver(
    JSON.stringify({ v1: "b".repeat(64) }),
  );
  const setup = await hub.createConnection(
    owner,
    workspace,
    "HA setup",
    600,
    "act",
    { canAttach: true, deviceLimit: 1, gatewayDeviceLimit: limit },
    "device-setup",
  );
  const fetch = async (input, init) =>
    handle(new Request(input, init), hub, async () => owner, {
      workspace,
      deviceCredentials: credentials,
    });
  const device = createDevice({
    url: "https://bridge.test",
    token: setup.token,
    workspace,
    fetch,
  });
  const identity = attach
    ? await device.attach(gatewayManifest, crypto.randomUUID())
    : undefined;
  return { hub, device, identity, setup, fetch, setTime: (t) => (now = t) };
}
const envelope = (capability, args = {}) => ({
  id: crypto.randomUUID(),
  deviceId: "any",
  capability,
  args,
  status: "received",
  createdAt: Date.now(),
  expiresAt: Date.now() + 30000,
});
test("HA app recovery acknowledges one interrupted action and never authorizes a future action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-ha-recovery-"));
  const actionId = crypto.randomUUID(),
    futureId = crypto.randomUUID();
  const journalPath = join(directory, ".actions.json");
  const pending = () => ({
    state: "pending",
    expiresAt: Date.now() + 30000,
    acknowledged: false,
  });
  try {
    await writeFile(
      join(directory, "identity.json"),
      JSON.stringify({
        url: "https://bridge.test",
        workspace,
        deviceId: crypto.randomUUID(),
        credential: "local-test-credential",
        haUrl: "http://supervisor",
        supervisor: true,
        manifest: gatewayManifest,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      journalPath,
      JSON.stringify({ [actionId]: pending(), [futureId]: pending() }),
      { mode: 0o600 },
    );
    const recover = () =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/sdk/src/home-assistant-cli.ts",
          "recover",
          "--directory",
          directory,
        ],
        {
          env: { ...process.env, OPENLAUNCH_RECOVERY_ACTION_ID: actionId },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    recover();
    let journal = await loadJournal(journalPath);
    assert.equal(
      journal[actionId].outcome.result.code,
      "outcome_unknown_owner_reviewed",
    );
    assert.equal(journal[actionId].outcome.result.outcomeUnknown, true);
    assert.equal(journal[actionId].recoveryRequired, false);
    assert.equal(journal[futureId].state, "pending");
    // Leaving the exact old ID in app configuration must not acknowledge new work.
    recover();
    journal = await loadJournal(journalPath);
    assert.equal(journal[futureId].state, "pending");
    assert.equal(journal[futureId].terminal, undefined);
    assert.equal(journal[actionId].outcome.result.physicalVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("HA discovery is real catalog-driven, bounded, stable and valid with an empty installation", () => {
  const children = discoverHA(snapshot);
  assert.equal(children.length, 5);
  for (const child of children) manifestSchema.parse(child.manifest);
  assert.deepEqual(discoverHA({ ...snapshot, states: [], services: {} }), []);
  const entity = children.find((c) => c.entityId);
  assert.ok(entity.manifest.capabilities.includes("ha.input_boolean.turn_on"));
  assert.equal(entity.manifest.kind, "home-assistant.entity");
  assert.equal(
    discoverHA({ ...snapshot, states: [...snapshot.states].reverse() })[0].key,
    entity.key,
  );
  const wide = structuredClone(snapshot);
  wide.services.input_boolean = Object.fromEntries(
    Array.from({ length: 130 }, (_, i) => ["action_" + i, { target: {} }]),
  );
  const split = discoverHA(wide).filter((c) => c.entityId);
  assert.equal(split.length, 3);
  assert.equal(
    split.reduce((n, c) => n + Object.keys(c.actions).length, 0),
    130,
  );
  split.forEach((c) => manifestSchema.parse(c.manifest));
});
test("gateway credentials dispatch own children only; discovery grants nothing and root revocation propagates", async () => {
  const { hub, device, identity, setup } = await fixture();
  const published = await publishHAInventory(device, snapshot);
  const child = [...published.byId].find(([, c]) => c.entityId)[0];
  assert.equal(hub.list(agent).length, 0);
  assert.throws(() =>
    hub.grant(owner, setup.principal, child, ["ha.entity.read"]),
  );
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control", false, null);
  assert.equal(hub.list(agent).length, 2);
  assert.throws(() =>
    hub.gatewayGrants(agent, identity.deviceId, agent.id, "control", true),
  );
  const action = hub.request(
    agent,
    child,
    "ha.input_boolean.turn_on",
    {},
    "one",
  );
  const delivered = await device.nextAction();
  assert.equal(delivered.deviceId, child);
  assert.equal(delivered.id, action.id);
  const other = await hub.enrollment(owner, "custom.other");
  const foreign = await hub.enroll(other.token, {
    name: "other",
    kind: "custom.other",
    capabilities: ["device.health"],
  });
  assert.throws(() => hub.result(foreign.deviceId, action.id, "succeeded", {}));
  await assert.rejects(hub.authenticateDevice(child, identity.token));
  await device.submitResult(action.id, {
    status: "succeeded",
    result: { acceptedBy: "home-assistant", physicalVerified: false },
  });
  assert.equal(hub.get(agent, action.id).status, "succeeded");
  const pending = hub.request(agent, child, "ha.entity.read", {}, "two");
  hub.revoke(owner, identity.deviceId);
  assert.equal(pending.status, "cancelled");
  assert.equal(hub.list(agent).length, 0);
  await assert.rejects(device.nextAction());
});
test("gateway offline/reconnect, expiry, narrowed grants, removal and tombstones retain their boundaries", async () => {
  const { hub, device, identity, setTime } = await fixture();
  const p = await publishHAInventory(device, snapshot);
  const id = [...p.byId].find(([, c]) => c.entityId)[0];
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control");
  const action = hub.request(agent, id, "ha.entity.read", {}, "expiry", 1);
  await device.gatewayStatus(false);
  assert.equal(hub.list(agent).find((d) => d.id === id).online, false);
  assert.equal(await device.nextAction(), null);
  setTime(Date.now() + 2000);
  await device.gatewayStatus(true);
  assert.equal(await device.nextAction(), null);
  assert.equal(action.status, "expired");
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "read");
  assert.throws(() =>
    hub.request(agent, id, "ha.input_boolean.turn_on", {}, "denied"),
  );
  await device.gatewayStatus(false);
  await device.gatewayStatus(true);
  assert.ok(hub.list(agent).some((d) => d.id === id));
  await device.gatewayStatus(true, []);
  assert.ok(!hub.list(agent).some((d) => d.id === id));
  const child = p.byId.get(id);
  const again = await device.gatewayChildren([
    { key: child.key, manifest: child.manifest },
  ]);
  assert.equal(again[0].deviceId, id);
  assert.equal(
    hub.list(agent).some((d) => d.id === id),
    false,
  );
  hub.revoke(owner, id);
  const revoked = await device.gatewayChildren([
    { key: child.key, manifest: child.manifest },
  ]);
  assert.equal(revoked[0].revoked, true);
});
test("HA nested data is bounded at the core and local adapter; entity targets cannot be overridden", async () => {
  assert.equal(validServiceData({ nested: { values: [1, "x", null] } }), true);
  assert.equal(validServiceData({ x: "x".repeat(2049) }), false);
  assert.equal(validServiceData(JSON.parse('{"constructor":{}}')), false);
  assert.throws(() => normalizeHAUrl("https://user:secret@ha.test"));
  assert.throws(() => normalizeHAUrl("http://[2001:db8::1]"));
  assert.equal(
    normalizeHAUrl("http://homeassistant.local:8123"),
    "http://homeassistant.local:8123",
  );
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return Response.json(url.includes("/states/") ? snapshot.states[0] : []);
  };
  const ha = new HomeAssistant("http://127.0.0.1:8123", "private-test", fetch);
  const child = discoverHA(snapshot).find((c) => c.entityId);
  await assert.rejects(
    ha.execute(
      envelope("ha.input_boolean.turn_on", {
        data: { nested: { entity_id: "other" } },
      }),
      child,
      snapshot,
    ),
    /fixed_target/,
  );
  assert.equal(seen.length, 0);
  const result = await ha.execute(
    envelope("ha.input_boolean.turn_on", { data: {} }),
    child,
    snapshot,
  );
  assert.deepEqual(seen[0].body, { entity_id: "input_boolean.test" });
  assert.equal(result.physicalVerified, false);
  assert.equal(result.stateObserved, true);
  const global = discoverHA(snapshot).find(
    (c) => c.service === "input_boolean.turn_on",
  );
  await assert.rejects(
    ha.execute(envelope("ha.input_boolean.turn_on", {}), global, snapshot),
    /explicit_target/,
  );
  await ha.execute(
    envelope("ha.input_boolean.turn_on", {
      target: { entity_id: ["input_boolean.test"] },
    }),
    global,
    snapshot,
  );
  assert.deepEqual(seen.at(-1).body, { entity_id: ["input_boolean.test"] });
  await assert.rejects(
    ha.execute(
      { ...envelope("ha.input_boolean.turn_on"), expiresAt: Date.now() - 1 },
      child,
      snapshot,
    ),
    /expired/,
  );
});
test("MCP generic invocation accepts HA objects, enforces the grant and keeps large catalogs out of tools/list", async () => {
  const { hub, device, identity } = await fixture();
  await publishHAInventory(device, snapshot);
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control", true);
  const child = hub.list(agent).find((d) => d.kind === "home-assistant.entity");
  const tools = createToolCatalog(hub, agent);
  assert.ok(tools.length < 15);
  const invoke = tools.find((t) => t.name === "invoke_device_function");
  const input = {
    deviceId: child.id,
    capability: "ha.input_boolean.turn_on",
    arguments: { data: { nested: [1, true] } },
    idempotencyKey: "mcp-ha",
  };
  const parsed = invoke.schema.parse(input);
  assert.equal(invoke.fn(parsed).status, "queued");
  assert.throws(() =>
    invoke.fn({
      ...parsed,
      arguments: { data: { bad: "x".repeat(2049) } },
      idempotencyKey: "oversize",
    }),
  );
  const readOnly = createToolCatalog(hub, { ...agent, readOnly: true }).find(
    (t) => t.name === "invoke_device_function",
  );
  assert.throws(() => readOnly.fn(parsed));
});
test("gateway limit requires owner opt-in and does not corrupt prior children", async () => {
  const { hub, device, identity, fetch } = await fixture(1);
  const children = discoverHA(snapshot);
  const outcomes = await device.gatewayChildren(
    children.slice(0, 2).map(({ key, manifest }) => ({ key, manifest })),
  );
  assert.ok(outcomes[0].deviceId);
  assert.equal(outcomes[1].error.code, "limit");
  assert.equal(
    hub.state.devices.filter((d) => d.gatewayId === identity.deviceId).length,
    1,
  );
  const ordinary = await hub.createConnection(
    owner,
    workspace,
    "regular setup",
    600,
    "act",
    { canAttach: true, deviceLimit: 1 },
    "device-setup",
  );
  const denied = createDevice({
    url: "https://bridge.test",
    token: ordinary.token,
    fetch,
  });
  await assert.rejects(
    denied.attach(gatewayManifest, crypto.randomUUID()),
    (e) => e.status === 403,
  );
});
test("HA runner survives lost result response without repeating a service; setup updates preserve private identity", async () => {
  const f = await fixture(50, false);
  let serviceCalls = 0,
    state = "off",
    lost = false;
  const seen = [];
  const fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1:8123")) {
      const path = new URL(url).pathname;
      seen.push(path);
      if (path === "/api/config")
        return Response.json({ location_name: "Test", version: "test" });
      if (path === "/api/services")
        return Response.json(
          Object.entries(snapshot.services).map(([domain, services]) => ({
            domain,
            services,
          })),
        );
      if (path === "/api/states")
        return Response.json([{ ...snapshot.states[0], state }]);
      if (path.startsWith("/api/states/"))
        return Response.json({ ...snapshot.states[0], state });
      if (path.includes("/services/")) {
        serviceCalls++;
        state = "on";
        return Response.json([]);
      }
      throw Error("unexpected HA endpoint");
    }
    const response = await f.fetch(url, init);
    if (String(url).endsWith("/result") && !lost) {
      lost = true;
      throw Error("lost saved receipt");
    }
    return response;
  };
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-ha-test-"));
  const controller = new AbortController();
  let running;
  try {
    const i = await setupHomeAssistant({
      directory,
      url: "https://bridge.test",
      haUrl: "http://127.0.0.1:8123",
      haToken: "private-local-test",
      sdkToken: f.setup.token,
      fetch,
    });
    const saved = await readFile(join(directory, "identity.json"), "utf8");
    assert.equal(
      (await stat(join(directory, "identity.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const unchanged = await setupHomeAssistant({ directory });
    assert.equal(unchanged.deviceId, i.deviceId);
    assert.equal(
      await readFile(join(directory, "identity.json"), "utf8"),
      saved,
    );
    running = runHomeAssistant({
      directory,
      fetch,
      signal: controller.signal,
      events: false,
      pollMs: 5,
      output: { write() {} },
    });
    for (
      let n = 0;
      n < 100 &&
      !f.hub.list(owner).some((d) => d.gatewayId === i.deviceId && d.online);
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      f.hub.list(owner).some((d) => d.gatewayId === i.deviceId && d.online),
      "Wait for completed inventory publication and gateway readiness",
    );
    f.hub.gatewayGrants(owner, i.deviceId, agent.id, "control");
    const child = f.hub
      .list(agent)
      .find(
        (d) => d.gatewayId === i.deviceId && d.kind === "home-assistant.entity",
      );
    const action = f.hub.request(
      agent,
      child.id,
      "ha.input_boolean.turn_on",
      {},
      "runner-on",
    );
    for (
      let n = 0;
      n < 400 &&
      !Object.values(
        JSON.parse(
          await readFile(join(directory, ".actions.json"), "utf8").catch(
            () => "{}",
          ),
        ),
      ).some((e) => e.acknowledged);
      n++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(serviceCalls, 1);
    assert.equal(action.status, "succeeded");
    assert.equal(action.result.observedState.state, "on");
    assert.equal(lost, true);
    assert.ok(
      Object.values(
        JSON.parse(await readFile(join(directory, ".actions.json"), "utf8")),
      ).some((e) => e.acknowledged),
    );
  } finally {
    controller.abort();
    if (running) await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test("HA native device metadata is scoped to its registry record; unknown writes are not retried", async () => {
  const catalog = {
    ...snapshot,
    registryAvailable: true,
    devices: [
      {
        id: "native-id",
        name: "Kitchen sensor",
        manufacturer: "Example",
        model: "Sensor",
        area_id: "kitchen",
      },
    ],
    entityRegistry: [
      { entity_id: "input_boolean.test", device_id: "native-id" },
    ],
    areas: [{ area_id: "kitchen", name: "Kitchen" }],
  };
  const children = discoverHA(catalog);
  const device = children.find((c) => c.homeAssistantDeviceId);
  manifestSchema.parse(device.manifest);
  const ha = new HomeAssistant(
    "http://127.0.0.1:8123",
    "private-test",
    async () => Response.json([]),
  );
  const info = await ha.execute(envelope("ha.device.info"), device, catalog);
  assert.equal(info.homeAssistantDeviceId, "native-id");
  assert.equal(info.model, "Sensor");
  assert.equal(info.area, "Kitchen");
  assert.deepEqual(info.entities, ["input_boolean.test"]);
  assert.equal(info.cached, true);
  assert.equal(info.physicalVerified, false);
  let calls = 0;
  const uncertain = new HomeAssistant(
    "http://127.0.0.1:8123",
    "private-test",
    async () => {
      calls++;
      throw Error("network lost after acceptance");
    },
  );
  await assert.rejects(
    uncertain.execute(
      envelope("ha.input_boolean.turn_on"),
      children.find((c) => c.entityId),
      catalog,
    ),
    /ha_write_outcome_unknown/,
  );
  assert.equal(calls, 1);
  const data = await ha.execute(
    envelope("ha.inventory", { kind: "devices" }),
    undefined,
    catalog,
  );
  assert.equal(data.items[0].homeAssistantDeviceId, "native-id");
  assert.equal(data.registryAvailable, true);
  const empty = await ha.execute(
    envelope("ha.inventory", { kind: "devices" }),
    undefined,
    snapshot,
  );
  assert.equal(empty.registryAvailable, false);
  assert.equal(Object.hasOwn(empty, "total"), false);
  assert.throws(() => normalizeHAUrl("http://192.168.public.example"));
  assert.throws(() => normalizeHAUrl("http://10.evil.example"));
  assert.throws(() => normalizeHAUrl("http://[2001:db8::1]"));
  assert.equal(
    normalizeHAUrl("http://192.168.1.2:8123"),
    "http://192.168.1.2:8123",
  );
});

test("changed child catalogs invalidate only their own grants and outstanding commands", async () => {
  const { hub, device, identity } = await fixture();
  const p = await publishHAInventory(device, snapshot);
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control");
  const [id, child] = [...p.byId].find(([, c]) => c.entityId);
  const pending = hub.request(agent, id, "ha.entity.read", {}, "before-change");
  const changed = { ...child.manifest, name: "Changed toggle" };
  const outcome = await device.gatewayChildren([
    { key: child.key, manifest: changed },
  ]);
  assert.equal(outcome[0].grantsRevoked, true);
  assert.equal(pending.status, "cancelled");
  assert.ok(!hub.list(agent).some((d) => d.id === id));
  assert.ok(hub.list(agent).some((d) => d.id === identity.deviceId));
  const clone = new Hub(JSON.parse(JSON.stringify(hub.state)));
  assert.equal(
    clone.state.devices.find((d) => d.id === id).gatewayId,
    identity.deviceId,
  );
  assert.equal(
    clone.list(agent).some((d) => d.id === id),
    false,
  );
});

test("bulk access narrowing removes omitted global-service grants and cancels their queued work", async () => {
  const { hub, device, identity } = await fixture();
  await publishHAInventory(device, snapshot);
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control", true);
  const service = hub
    .list(agent)
    .find((d) => d.name === "HA · input_boolean.turn_on");
  const action = hub.request(
    agent,
    service.id,
    "ha.input_boolean.turn_on",
    { target: { entity_id: "input_boolean.test" } },
    "global-before-read",
  );
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "read", false);
  assert.equal(action.status, "cancelled");
  assert.ok(!hub.list(agent).some((d) => d.id === service.id));
  assert.throws(() =>
    hub.request(
      agent,
      service.id,
      "ha.input_boolean.turn_on",
      { target: { entity_id: "input_boolean.test" } },
      "global-after-read",
    ),
  );
});

test("HA entity discovery respects native target domains, integrations and feature groups", () => {
  const catalog = {
    ...snapshot,
    states: [
      {
        entity_id: "media_player.kitchen",
        state: "on",
        attributes: { supported_features: 6 },
      },
    ],
    entityRegistry: [{ entity_id: "media_player.kitchen", platform: "sonos" }],
    services: {
      sonos: {
        join: {
          target: {
            entity: {
              domain: "media_player",
              integration: "sonos",
              supported_features: [[2, 4]],
            },
          },
        },
        unsupported: {
          target: {
            entity: { domain: "media_player", supported_features: [8] },
          },
        },
      },
      homeassistant: {
        reload_config_entry: { target: {} },
        turn_on: { target: {} },
      },
    },
  };
  const entity = discoverHA(catalog).find((c) => c.entityId);
  assert.ok(entity.manifest.capabilities.includes("ha.sonos.join"));
  assert.ok(!entity.manifest.capabilities.includes("ha.sonos.unsupported"));
  assert.ok(
    !entity.manifest.capabilities.includes(
      "ha.homeassistant.reload_config_entry",
    ),
  );
  assert.ok(entity.manifest.capabilities.includes("ha.homeassistant.turn_on"));
  assert.ok(
    discoverHA(catalog).some(
      (c) => c.service === "homeassistant.reload_config_entry",
    ),
  );
});

test("HA direct script services keep their native payload and response-supporting services request a response", async () => {
  const catalog = {
    ...snapshot,
    states: [
      {
        entity_id: "script.test",
        state: "off",
        attributes: { friendly_name: "Test script" },
      },
    ],
    services: {
      script: { test: { fields: {}, response: { optional: true } } },
    },
  };
  const script = discoverHA(catalog).find((c) => c.entityId);
  const seen = [];
  const ha = new HomeAssistant(
    "http://127.0.0.1:8123",
    "private-test",
    async (url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return Response.json(
        url.includes("/services/")
          ? { service_response: { answer: 42 } }
          : catalog.states[0],
      );
    },
  );
  const result = await ha.execute(
    envelope("ha.script.test", { data: { value: 1 } }),
    script,
    catalog,
  );
  assert.ok(seen[0].url.endsWith("?return_response"));
  assert.deepEqual(seen[0].body, { value: 1 });
  assert.deepEqual(result.response, { answer: 42 });
  await assert.rejects(
    ha.execute(
      envelope("ha.script.test", { data: { entry_id: "other-integration" } }),
      script,
      catalog,
    ),
    /fixed_target/,
  );
});

test("July 2026 MCP invokes HA nested service data through the same live grant checks", async () => {
  const { hub, device, identity } = await fixture();
  await publishHAInventory(device, snapshot);
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control");
  const child = hub.list(agent).find((d) => d.kind === "home-assistant.entity");
  const request = new Request("https://bridge.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "invoke_device_function",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "invoke_device_function",
        arguments: {
          deviceId: child.id,
          capability: "ha.input_boolean.turn_on",
          arguments: { data: {} },
          idempotencyKey: "ha-2026",
        },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const response = await handle(request, hub, async () => agent);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, undefined);
  assert.equal(payload.result.structuredContent.data.status, "queued");
  assert.equal((await device.nextAction()).deviceId, child.id);
});

test("equivalent HA object key ordering reuses the same action while different nested data conflicts", async () => {
  const { hub, device, identity } = await fixture();
  await publishHAInventory(device, snapshot);
  hub.gatewayGrants(owner, identity.deviceId, agent.id, "control");
  const child = hub.list(agent).find((d) => d.kind === "home-assistant.entity");
  const first = hub.request(
    agent,
    child.id,
    "ha.input_boolean.turn_on",
    { data: { a: 1, nested: { b: 2, c: [3, 4] } } },
    "ha-order",
  );
  const retry = hub.request(
    agent,
    child.id,
    "ha.input_boolean.turn_on",
    { data: { nested: { c: [3, 4], b: 2 }, a: 1 } },
    "ha-order",
  );
  assert.equal(retry.id, first.id);
  assert.throws(
    () =>
      hub.request(
        agent,
        child.id,
        "ha.input_boolean.turn_on",
        { data: { a: 1, nested: { b: 2, c: [4, 3] } } },
        "ha-order",
      ),
    /Idempotency/,
  );
});
