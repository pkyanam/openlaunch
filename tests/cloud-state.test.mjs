import test from "node:test";
import assert from "node:assert/strict";
import { withWorkspaceState } from "../apps/cloud/src/state.ts";
const owner = { id: "owner", owner: true };
const agent = { id: "agent", owner: false };
function storage() {
  let saved;
  return {
    writes: 0,
    async get() { return structuredClone(saved); },
    async put(_, state) { saved = structuredClone(state); this.writes++; },
  };
}
test("separate hosted requests persist enrollment consumption, grants, outcomes and revocation", async () => {
  const state = storage();
  const run = fn => withWorkspaceState(state, fn);
  const enrollment = await run(h => h.enrollment(owner, "raspberry-pi-4"));
  const manifest = { name: "storage fixture", kind: "raspberry-pi-4", capabilities: ["device.health"] };
  const device = await run(h => h.enroll(enrollment.token, manifest));
  await assert.rejects(run(h => h.enroll(enrollment.token, manifest)));
  await run(async h => h.grant(owner, agent.id, device.deviceId, ["device.health"]));
  assert.equal((await run(async h => h.list(agent))).length, 1);
  const action = await run(async h => h.request(agent, device.deviceId, "device.health", {}, "storage-1"));
  assert.equal((await run(async h => h.next(device.deviceId))).id, action.id);
  await run(async h => h.result(device.deviceId, action.id, "succeeded", { simulated: true }));
  assert.equal((await run(async h => h.get(agent, action.id))).status, "succeeded");
  assert.equal((await run(async h => h.request(agent, device.deviceId, "device.health", {}, "storage-1"))).id, action.id);
  await run(async h => h.revokeGrant(owner, agent.id, device.deviceId));
  assert.equal((await run(async h => h.list(agent))).length, 0);
  await run(async h => h.revoke(owner, device.deviceId));
  await assert.rejects(run(h => h.authenticateDevice(device.deviceId, device.token)));
});
test("hosted read-only requests do not rewrite unchanged storage", async () => {
  const state = storage();
  await withWorkspaceState(state, async h => h.list(owner));
  assert.equal(state.writes, 0);
  await withWorkspaceState(state, h => h.enrollment(owner, "raspberry-pi-4"));
  const writes = state.writes;
  await withWorkspaceState(state, async h => h.list(owner));
  assert.equal(state.writes, writes);
});
