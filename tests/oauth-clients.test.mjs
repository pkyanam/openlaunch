import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../packages/core/src/index.ts";
import { oauthClientConfig } from "../packages/core/src/oauth-clients.ts";
import { handle } from "../packages/http/src/index.ts";
import {
  authenticateClerk,
  principalFromIdentity,
} from "../apps/cloud/src/clerk-auth.ts";
import { clerkOAuthClients } from "../apps/cloud/src/oauth-clients.ts";
const owner = { id: "owner", owner: true };
const config = {
  name: "Executor",
  redirectUris: ["https://v2.executor.sh/api/oauth/callback"],
  public: false,
  access: "act",
};
function fixture(hub = new Hub()) {
  let creates = 0,
    deletes = [],
    failDelete = false;
  const context = {
    workspace: "a".repeat(64),
    oauthBuiltinClients: ["builtin-client"],
    oauthClients: {
      async create(input) {
        creates++;
        return {
          applicationId: `oapp_fixture_${creates}`,
          clientId: `client-fixture-${creates}`,
          redirectUris: input.redirectUris,
          public: input.public,
          ...(input.public
            ? {}
            : { clientSecret: "fixture-secret-not-a-real-token" }),
        };
      },
      async delete(id) {
        deletes.push(id);
        if (failDelete) throw Error("unavailable");
      },
    },
  };
  const api = (path, method = "GET", data, p = owner) =>
    handle(
      new Request("https://bridge.test" + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      hub,
      async () => p,
      context,
    );
  return {
    hub,
    api,
    context,
    creates: () => creates,
    deletes,
    failDelete: () => {
      failDelete = true;
    },
  };
}
test("owner-managed OAuth registration returns the secret once, admits only its workspace, and keeps function grants separate", async () => {
  const f = fixture();
  const response = await f.api("/v1/oauth-clients", "POST", config);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const client = (await response.json()).data;
  assert.equal(client.clientSecret, "fixture-secret-not-a-real-token");
  assert.equal(client.principal, client.oauth.clientId);
  assert.equal(client.canAttach, false);
  assert.equal(f.hub.state.grants.length, 0);
  const saved = JSON.stringify(f.hub.state);
  assert(!saved.includes(client.clientSecret));
  assert(!saved.includes("clientSecret"));
  const listed = await f.api("/v1/oauth-clients");
  assert(!(await listed.text()).includes(client.clientSecret));
  assert.deepEqual(
    (await (await f.api("/v1/agent-connections")).json()).data,
    [],
  );
  const authenticated = await principalFromIdentity(
    {
      isAuthenticated: true,
      tokenType: "oauth_token",
      userId: "a",
      clientId: client.principal,
      scopes: ["openlaunch:read", "openlaunch:act", "openlaunch:owner"],
    },
    { CLERK_ISSUER: "https://issuer.test" },
    "/mcp",
    true,
  );
  assert.equal(authenticated.principal.owner, false);
  const restored = new Hub(JSON.parse(saved));
  const p = restored.admitOAuthClient(authenticated.principal);
  assert.equal(p.owner, false);
  assert.throws(
    () => new Hub().admitOAuthClient(p),
    (error) => error.status === 401,
  );
  const enrollment = await restored.enrollment(owner, "custom.device");
  const { deviceId } = await restored.enroll(enrollment.token, {
    name: "fixture",
    kind: "custom.device",
    capabilities: ["device.health", "led.set"],
  });
  assert.throws(
    () => restored.request(p, deviceId, "led.set", { on: true }, "ungranted"),
    (error) => error.status === 403,
  );
  restored.grant(owner, p.id, deviceId, ["led.set"], null);
  assert.equal(
    restored.request(p, deviceId, "led.set", { on: true }, "granted").status,
    "queued",
  );
  await assert.rejects(
    restored.authenticateConnection(
      "ol_agent_" + f.context.workspace + "_" + "b".repeat(64),
      f.context.workspace,
    ),
  );
});
test("OAuth management is owner-only, denied clients have no side effects, and scope ceilings cannot confer attachment or ownership", async () => {
  const f = fixture();
  for (const p of [
    { id: "agent", owner: false },
    { id: "setup", owner: false, connectionPurpose: "device-setup" },
  ]) {
    for (const [method, data] of [
      ["GET", undefined],
      ["POST", config],
    ])
      assert.equal(
        (await f.api("/v1/oauth-clients", method, data, p)).status,
        403,
      );
  }
  assert.equal(f.creates(), 0);
  const client = (
    await (
      await f.api("/v1/oauth-clients", "POST", {
        ...config,
        public: true,
        access: "read",
      })
    ).json()
  ).data;
  const p = f.hub.admitOAuthClient({
    id: client.principal,
    owner: false,
    readOnly: false,
    oauthClient: true,
  });
  assert.equal(p.readOnly, true);
  assert.equal(
    (
      await f.api(
        "/v1/grants",
        "POST",
        {
          principal: p.id,
          deviceId: crypto.randomUUID(),
          capabilities: ["device.health"],
        },
        p,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("/v1/oauth-clients", "GET", undefined, {
        id: "unregistered",
        owner: false,
        oauthClient: true,
      })
    ).status,
    401,
  );
  assert.equal(
    f.hub.admitOAuthClient(
      { id: "builtin-client", owner: false, oauthClient: true },
      f.context.oauthBuiltinClients,
    ).owner,
    false,
  );
  await assert.rejects(
    f.hub.attachDevice(
      p,
      f.context.workspace,
      crypto.randomUUID(),
      {},
      {
        keyVersion: "fixture",
        async derive() {
          throw Error("must not derive");
        },
      },
    ),
    (error) => error.status === 403,
  );
});
test("online-verified custom OAuth identity reaches workspace admission only after audience, expiry and scopes are checked", async () => {
  const f = fixture();
  const client = (
    await (await f.api("/v1/oauth-clients", "POST", config)).json()
  ).data;
  const env = {
    CLERK_ISSUER: "https://issuer.test",
    API_ORIGIN: "https://bridge.test",
  };
  const verifier = {
    idPOAuthAccessToken: {
      async verify(token, options) {
        assert.equal(token, "oat_fixture");
        assert.equal(options.audience, "https://bridge.test/mcp");
        return {
          revoked: false,
          expired: false,
          expiration: Date.now() / 1000 + 60,
          subject: "fixture-user",
          clientId: client.principal,
          scopes: ["openlaunch:read", "openlaunch:act"],
        };
      },
    },
  };
  const request = new Request("https://bridge.test/mcp", {
    headers: { authorization: "Bearer oat_fixture" },
  });
  await assert.rejects(
    authenticateClerk(request, env, verifier),
    /not admitted/,
  );
  const verified = await authenticateClerk(request, env, verifier, true);
  assert.equal(verified.principal.oauthClient, true);
  assert.equal(f.hub.admitOAuthClient(verified.principal).owner, false);
  assert.throws(
    () => new Hub().admitOAuthClient(verified.principal),
    (error) => error.status === 401,
  );
});
test("revocation is immediate and durable even when provider cleanup fails, removing grants and cancelling queued actions", async () => {
  const f = fixture();
  const client = (
    await (await f.api("/v1/oauth-clients", "POST", config)).json()
  ).data;
  const p = { id: client.principal, owner: false, oauthClient: true };
  const enrollment = await f.hub.enrollment(owner, "custom.device");
  const { deviceId } = await f.hub.enroll(enrollment.token, {
    name: "fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  f.hub.grant(owner, p.id, deviceId, ["device.health"], null);
  const action = f.hub.request(p, deviceId, "device.health", {}, "queued");
  f.failDelete();
  assert.equal(
    (await f.api(`/v1/oauth-clients/${client.id}/revoke`, "POST", undefined, p))
      .status,
    403,
  );
  const response = await f.api(`/v1/oauth-clients/${client.id}/revoke`, "POST");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.providerCleanupPending, true);
  assert.equal(f.hub.state.grants.length, 0);
  assert.equal(
    f.hub.state.actions.find((row) => row.id === action.id).status,
    "cancelled",
  );
  assert.equal(f.hub.next(deviceId), null);
  const restored = new Hub(structuredClone(f.hub.state));
  assert.throws(
    () => restored.admitOAuthClient(p, [p.id]),
    (error) => error.status === 401,
  );
  const stranger = fixture();
  assert.equal(
    (await stranger.api(`/v1/oauth-clients/${client.id}/revoke`, "POST"))
      .status,
    404,
  );
  assert.equal(stranger.deletes.length, 0);
});
test("callback validation, strict configuration and shared connection limits run before provider calls", async () => {
  const f = fixture();
  for (const redirectUris of [
    ["http://public.test/callback"],
    ["https://u:p@host.test/callback"],
    ["https://host.test/callback#secret"],
    ["https://host.test/*"],
    ["javascript:alert(1)"],
    ["https://host.test/callback", "https://host.test/callback"],
    [],
  ])
    assert.equal(
      (await f.api("/v1/oauth-clients", "POST", { ...config, redirectUris }))
        .status,
      400,
    );
  assert.equal(
    (
      await f.api("/v1/oauth-clients", "POST", {
        ...config,
        scopes: ["openlaunch:owner"],
      })
    ).status,
    400,
  );
  assert.equal(f.creates(), 0);
  for (const uri of [
    "http://127.0.0.1:3000/callback",
    "http://[::1]:3000/callback",
    "https://host.test/callback",
  ])
    assert(
      oauthClientConfig.safeParse({ ...config, redirectUris: [uri] }).success,
    );
  for (let i = 0; i < 20; i++)
    await f.hub.createConnection(
      owner,
      f.context.workspace,
      `fixture-${i}`,
      600,
      "read",
      { canAttach: false, deviceLimit: 0 },
      "agent",
    );
  assert.equal((await f.api("/v1/oauth-clients", "POST", config)).status, 429);
  assert.equal(f.creates(), 0);
});
test("Clerk registration fixes consent/PKCE, bounds scopes, and never forwards callbacks or reflects provider secrets", async () => {
  const calls = [];
  const provider = clerkOAuthClients(
    "fixture-backend-key",
    async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        id: "oapp_fixture",
        client_id: "fixture",
        public: false,
        pkce_required: true,
        consent_screen_enabled: true,
        scopes:
          "openid profile email offline_access openlaunch:read openlaunch:act",
        client_secret: "fixture-private",
      });
    },
  );
  assert.equal((await provider.create(config)).clientSecret, "fixture-private");
  assert.equal(calls[0].url, "https://api.clerk.com/v1/oauth_applications");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.pkce_required, true);
  assert.equal(sent.consent_screen_enabled, true);
  assert(sent.scopes.includes("openlaunch:act"));
  assert(!sent.scopes.includes("openlaunch:owner"));
  const unsafe = clerkOAuthClients("fixture", async () =>
    Response.json({ client_secret: "do-not-reflect" }, { status: 422 }),
  );
  await assert.rejects(
    unsafe.create(config),
    (error) =>
      error.status === 502 && !error.message.includes("do-not-reflect"),
  );
  const invalidPolicy = clerkOAuthClients("fixture", async (_, init) =>
    init.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          id: "oapp_fixture",
          client_id: "bad",
          pkce_required: false,
        }),
  );
  await assert.rejects(invalidPolicy.create(config), /invalid client policy/);
});
