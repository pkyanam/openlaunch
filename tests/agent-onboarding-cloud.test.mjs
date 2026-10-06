import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentOnboarding,
  invitationWorkspace,
  loginWorkspace,
  pkceChallenge,
  validateCliCallback,
  identityDirectory,
  DeferredIdentityStore,
} from "../apps/cloud/src/agent-onboarding.ts";
import { Hub, emptyState } from "../packages/core/src/index.ts";
class Store {
  rows = new Map();
  async get(key) {
    return structuredClone(this.rows.get(key));
  }
  async put(key, value) {
    this.rows.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.rows.delete(key);
  }
  async list({ prefix, limit = 1000 }) {
    return new Map(
      [...this.rows]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([k, v]) => [k, structuredClone(v)]),
    );
  }
}
const owner = { id: "owner", owner: true },
  workspace = "a".repeat(64),
  identity = "b".repeat(64),
  second = "c".repeat(64);
function fixture() {
  let now = 100000;
  const store = new Store(),
    hub = new Hub(emptyState(), () => now),
    service = new AgentOnboarding(store, workspace, () => now);
  return { store, hub, service, advance: (n) => (now += n) };
}
test("invitations bind exact identities, store only hashes, and retry without broadening access", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.invite(f.hub, { id: "rogue", owner: false }, { name: "rogue" }),
  );
  const issued = await f.service.invite(f.hub, owner, { name: "Test agent" });
  assert.equal(invitationWorkspace(issued.invitation), workspace);
  assert.equal(
    JSON.stringify([...f.store.rows]).includes(issued.invitation),
    false,
  );
  const joined = await f.service.accept(f.hub, identity, issued.invitation);
  assert.equal(joined.principalId, `agent:${identity}`);
  assert.equal(joined.role, "operator");
  assert.deepEqual(
    await f.service.accept(f.hub, identity, issued.invitation),
    joined,
  );
  await assert.rejects(f.service.accept(f.hub, second, issued.invitation));
  assert.equal(
    f.hub.state.accessPolicies.find((p) => p.principal === joined.principalId)
      .mode,
    "all",
  );
});
test("expired invitations and revoked members cannot reuse admission", async () => {
  const f = fixture(),
    old = await f.service.invite(f.hub, owner, { name: "old", ttlSeconds: 60 });
  f.advance(60000);
  await assert.rejects(f.service.accept(f.hub, identity, old.invitation));
  const fresh = await f.service.invite(f.hub, owner, { name: "new" }),
    joined = await f.service.accept(f.hub, identity, fresh.invitation);
  await f.service.revoke(f.hub, owner, joined.principalId);
  await assert.rejects(f.service.accept(f.hub, identity, fresh.invitation));
  assert.equal((await f.service.member(identity)).revoked, true);
});
test("CLI callback and PKCE validate before single-use exchange; browser receives no bearer credential", async () => {
  const f = fixture(),
    verifier = "v".repeat(64),
    challenge = await pkceChallenge(verifier);
  for (const callback of [
    "https://evil.test/callback",
    "http://localhost:4321/callback",
    "http://127.0.0.1:4321/callback?x=1",
    "http://127.0.0.1:4321/else",
    "http://name@127.0.0.1:4321/callback",
    "http://127.0.0.1/callback",
  ])
    assert.throws(() => validateCliCallback(callback));
  const authorized = await f.service.authorize(f.hub, owner, identity, {
    callbackUrl: "http://127.0.0.1:4321/callback",
    state: "s".repeat(43),
    challenge,
  });
  assert.equal(loginWorkspace(authorized.code), workspace);
  assert.equal(authorized.token, undefined);
  assert.equal(
    JSON.stringify([...f.store.rows]).includes(authorized.code),
    false,
  );
  await assert.rejects(
    f.service.exchange(f.hub, {
      code: authorized.code,
      verifier: "x".repeat(64),
    }),
  );
  const credential = await f.service.exchange(f.hub, {
    code: authorized.code,
    verifier,
  });
  assert.match(credential.token, /^ol_agent_/);
  assert.equal(credential.role, "administrator");
  const p = await f.hub.authenticateConnection(credential.token, workspace);
  assert.equal((await f.service.credentialIdentity(p.id)).identityId, identity);
  await assert.rejects(
    f.service.exchange(f.hub, { code: authorized.code, verifier }),
  );
});
test("CLI credential inherits operator exclusions and live membership revocation", async () => {
  const f = fixture(),
    invite = await f.service.invite(f.hub, owner, { name: "operator" }),
    joined = await f.service.accept(f.hub, identity, invite.invitation);
  f.hub.setAccessPolicy(owner, {
    principal: joined.principalId,
    mode: "all",
    excludedDevices: [],
    excludedFunctions: [{ deviceId: null, capability: "led.set" }],
    role: "operator",
    expiresAt: null,
  });
  const verifier = "z".repeat(64),
    args = {
      callbackUrl: "http://127.0.0.1:4322/callback",
      state: "s".repeat(43),
      challenge: await pkceChallenge(verifier),
    };
  const pending = await f.service.authorize(
      f.hub,
      { id: joined.principalId, owner: false },
      identity,
      args,
    ),
    credential = await f.service.exchange(f.hub, {
      code: pending.code,
      verifier,
    });
  const p = await f.hub.authenticateConnection(credential.token, workspace),
    policy = f.hub.state.accessPolicies.find((x) => x.principal === p.id);
  assert.equal(policy.delegatedFrom, joined.principalId);
  assert.deepEqual(f.hub.effectiveAccess(p).excludedFunctions, [
    { deviceId: null, capability: "led.set" },
  ]);
  assert.equal(credential.role, "operator");
  const another = await f.service.authorize(
    f.hub,
    { id: joined.principalId, owner: false },
    identity,
    args,
  );
  await f.service.revoke(f.hub, owner, joined.principalId);
  await assert.rejects(
    f.service.exchange(f.hub, { code: another.code, verifier }),
  );
  await assert.rejects(
    f.hub.authenticateConnection(credential.token, workspace),
  );
});
test("CLI login expiry and identity checks fail closed", async () => {
  const f = fixture(),
    verifier = "v".repeat(64),
    args = {
      callbackUrl: "http://127.0.0.1:4321/callback",
      state: "s".repeat(43),
      challenge: await pkceChallenge(verifier),
    };
  await assert.rejects(
    f.service.authorize(f.hub, owner, "email@example.test", args),
  );
  const authorized = await f.service.authorize(f.hub, owner, identity, args);
  f.advance(60000);
  await assert.rejects(
    f.service.exchange(f.hub, { code: authorized.code, verifier }),
  );
});
test("identity directory indexes exact memberships and selection", async () => {
  const store = new Store(),
    req = (path, method = "GET", data) =>
      new Request("https://internal.test" + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
  const entry = {
    workspace,
    principalId: `agent:${identity}`,
    name: "one",
    role: "operator",
  };
  await identityDirectory(store, req("/__identity/link", "POST", entry));
  await identityDirectory(
    store,
    req("/__identity/link", "POST", {
      ...entry,
      workspace: second,
      name: "two",
    }),
  );
  const data = (
    await (await identityDirectory(store, req("/__identity/list"))).json()
  ).data;
  assert.equal(data.memberships.length, 2);
  assert.equal(data.selected, undefined);
  await identityDirectory(
    store,
    req("/__identity/select", "POST", { workspace: second }),
  );
  assert.equal(await store.get("identity:selected"), second);
});
test("metadata is not consumed before the canonical state commits", async () => {
  const f = fixture(),
    deferred = new DeferredIdentityStore(f.store),
    service = new AgentOnboarding(deferred, workspace, () => 100000);
  const invitation = await service.invite(f.hub, owner, { name: "pending" });
  assert.equal(f.store.rows.size, 0);
  await assert.rejects(
    f.service.accept(f.hub, identity, invitation.invitation),
  );
  await deferred.commit();
  await f.service.accept(f.hub, identity, invitation.invitation);
  const fresh = await f.service.invite(f.hub, owner, {
    name: "upgrade",
    role: "administrator",
  });
  await assert.rejects(
    f.service.accept(f.hub, identity, fresh.invitation),
    (e) => e.status === 409,
  );
  assert.equal(
    f.hub.applyAccessPolicy({ id: `agent:${identity}`, owner: false })
      .administrator,
    false,
  );
});
test("administrators can revoke delegated operators without detaching their policy chain", async () => {
  const f = fixture();
  f.hub.setAccessPolicy(owner, {
    principal: "admin",
    mode: "all",
    excludedDevices: [],
    excludedFunctions: [],
    role: "administrator",
    expiresAt: null,
  });
  const admin = { id: "admin", owner: false };
  const invitation = await f.service.invite(f.hub, admin, {
    name: "delegated",
  });
  const joined = await f.service.accept(f.hub, identity, invitation.invitation);
  assert.equal(
    f.hub.state.accessPolicies.find((p) => p.principal === joined.principalId)
      .delegatedFrom,
    "admin",
  );
  await f.service.revoke(f.hub, admin, joined.principalId);
  assert.equal((await f.service.member(identity)).revoked, true);
});
