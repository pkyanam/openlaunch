import test from "node:test";
import assert from "node:assert/strict";
import { principalFromIdentity } from "../apps/cloud/src/clerk-auth.ts";
const env = {
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_AGENT_CLIENT_IDS: "approved-agent",
};
const identity = {
  isAuthenticated: true,
  tokenType: "oauth_token",
  userId: "owner-a",
  clientId: "approved-agent",
  scopes: ["openlaunch:read"],
};
test("Clerk agent scopes never confer ownership; action access is separate", async () => {
  const read = await principalFromIdentity(identity, env, "/mcp");
  assert.deepEqual(read.principal, {
    id: "approved-agent",
    owner: false,
    readOnly: true,
  });
  const act = await principalFromIdentity(
    {
      ...identity,
      scopes: ["openlaunch:read", "openlaunch:act", "openlaunch:owner"],
    },
    env,
    "/mcp",
  );
  assert.equal(act.principal.owner, false);
  assert.equal(act.principal.readOnly, false);
  assert.equal(read.workspace, act.workspace);
});
test("Clerk denies unauthenticated, unadmitted, and missing-scope identities", async () => {
  for (const change of [
    { isAuthenticated: false },
    { userId: null },
    { clientId: "stranger" },
    { scopes: [] },
    { tokenType: "api_key" },
  ])
    await assert.rejects(
      principalFromIdentity({ ...identity, ...change }, env, "/mcp"),
    );
  await assert.rejects(
    principalFromIdentity(
      identity,
      { ...env, CLERK_AGENT_CLIENT_IDS: "" },
      "/mcp",
    ),
  );
});
test("Clerk owner sessions and accounts remain separated", async () => {
  const session = { ...identity, tokenType: "session_token" };
  assert.equal(
    (await principalFromIdentity(session, env, "/v1/enrollments")).principal
      .owner,
    true,
  );
  await assert.rejects(principalFromIdentity(session, env, "/mcp"));
  const a = await principalFromIdentity(identity, env, "/mcp");
  const b = await principalFromIdentity(
    { ...identity, userId: "owner-b" },
    env,
    "/mcp",
  );
  const c = await principalFromIdentity(
    identity,
    { ...env, CLERK_ISSUER: "https://other.example.test" },
    "/mcp",
  );
  assert.notEqual(a.workspace, b.workspace);
  assert.notEqual(a.workspace, c.workspace);
});
