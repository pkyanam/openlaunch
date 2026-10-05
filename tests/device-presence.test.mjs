import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import { buildOpenApi } from "../packages/http/src/contracts.ts";
import Ajv2020 from "ajv/dist/2020.js";

test("presence authenticates device-only, preserves pending work and expiry, and cannot revive revoked devices", async () => {
  let now = 1000;
  const hub = new Hub(emptyState(), () => now);
  const owner = { id: "owner", owner: true },
    agent = { id: "agent", owner: false };
  const e = await hub.enrollment(owner, "raspberry-pi-4");
  const d = await hub.enroll(e.token, {
    name: "presence fixture",
    kind: "raspberry-pi-4",
    capabilities: ["device.health"],
  });
  hub.grant(owner, agent.id, d.deviceId, ["device.health"], 3600);
  const a = hub.request(agent, d.deviceId, "device.health", {}, "running", 180);
  hub.next(d.deviceId);
  const expires = a.expiresAt;
  const request = (
    token,
    body = {},
    method = "POST",
    id = d.deviceId,
    origin,
  ) =>
    handle(
      new Request(`https://presence.test/v1/device/${id}/heartbeat`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      hub,
      async () => {
        throw Error("presence cannot resolve an agent");
      },
    );
  now += 109000;
  assert.equal(hub.list(agent)[0].online, false);
  assert.equal((await request("wrong")).status, 401);
  assert.equal(hub.list(agent)[0].online, false);
  assert.equal((await request(d.token, { actionId: a.id })).status, 400);
  assert.equal((await request(d.token, {}, "GET")).status, 405);
  assert.equal(
    (await request(d.token, {}, "POST", d.deviceId, "https://other.test"))
      .status,
    403,
  );
  const r = await request(d.token);
  assert.equal(r.status, 200);
  const data = await r.json();
  const doc = buildOpenApi();
  const schema =
    doc.paths["/v1/device/{deviceId}/heartbeat"].post.responses["200"].content[
      "application/json"
    ].schema;
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile({ ...schema, components: doc.components });
  assert(validate(data), JSON.stringify(validate.errors));
  assert.equal(data.data.lastSeen, now);
  assert.equal(hub.list(agent)[0].online, true);
  assert.equal(a.status, "received");
  assert.equal(a.expiresAt, expires);
  const b = hub.request(agent, d.deviceId, "device.health", {}, "waiting");
  assert.equal(b.status, "queued");
  hub.revokeGrant(owner, agent.id, d.deviceId);
  assert.equal((await request(d.token)).status, 200);
  assert.throws(() =>
    hub.request(agent, d.deviceId, "device.health", {}, "no-grant"),
  );
  assert.equal(b.status, "cancelled");
  now = expires + 1000;
  await request(d.token);
  assert.equal(
    hub.get(owner, a.id).status,
    "unknown",
    "presence must not extend expiry",
  );
  hub.revoke(owner, d.deviceId);
  assert.equal((await request(d.token)).status, 404);
});
