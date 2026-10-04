import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { createClerkClient } from "@clerk/backend";
import { authenticateClerk } from "../apps/cloud/src/clerk-auth.ts";
import { createServer } from "node:http";
test("actual Clerk verifier checks session signatures, expiry, issuer and browser party", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const env = {
    CLERK_ISSUER: "https://clerk.example.test",
    API_ORIGIN: "https://www.example.test",
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY:
      "pk_test_" + Buffer.from("clerk.example.test$").toString("base64"),
  };
  const verifier = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    jwtKey: await exportSPKI(publicKey),
    telemetry: { disabled: true },
  });
  const sign = async ({
    issuer = env.CLERK_ISSUER,
    party = env.API_ORIGIN,
    expires = "1m",
    key = privateKey,
  } = {}) =>
    new SignJWT({ sid: "sess_fixture", azp: party, v: 2 })
      .setProtectedHeader({ alg: "RS256", kid: "fixture", typ: "JWT" })
      .setSubject("user_fixture")
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(key);
  const request = (token, path = "/v1/devices") =>
    new Request(env.API_ORIGIN + path, {
      headers: { authorization: "Bearer " + token },
    });
  assert.equal(
    (await authenticateClerk(request(await sign()), env, verifier)).principal
      .owner,
    true,
  );
  for (const options of [
    { issuer: "https://foreign.example.test" },
    { party: "https://foreign.example.test" },
    { expires: Math.floor(Date.now() / 1000) - 60 },
    { key: (await generateKeyPair("RS256")).privateKey },
  ])
    await assert.rejects(
      authenticateClerk(request(await sign(options)), env, verifier),
    );
  await assert.rejects(
    authenticateClerk(request(await sign(), "/mcp"), env, verifier),
  );
  await assert.rejects(authenticateClerk(request("invalid"), env, verifier));
});
test("Clerk OAuth online verification enforces resource audience, revocation and expiry", async () => {
  const origin = "https://www.example.test";
  let access = {
    object: "clerk_idp_oauth_access_token",
    id: "oat_fixture",
    client_id: "approved-agent",
    type: "authorization_code",
    subject: "user_fixture",
    scopes: ["openlaunch:read"],
    revoked: false,
    revocation_reason: null,
    expired: false,
    expiration: Math.floor(Date.now() / 1000) + 60,
    created_at: Date.now(),
    updated_at: Date.now(),
    aud: [origin + "/mcp"],
  };
  let calls = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/oauth_applications/access_tokens/verify");
    assert.equal(req.method, "POST");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).access_token, "oat_fixture");
    calls++;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(access));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const env = {
    API_ORIGIN: origin,
    CLERK_ISSUER: "https://clerk.example.test",
    CLERK_AGENT_CLIENT_IDS: "approved-agent",
    CLERK_SECRET_KEY: "sk_test_fixture",
    CLERK_PUBLISHABLE_KEY:
      "pk_test_" + Buffer.from("clerk.example.test$").toString("base64"),
  };
  const verifier = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    telemetry: { disabled: true },
  });
  const request = () =>
    new Request(origin + "/mcp", {
      headers: { authorization: "Bearer oat_fixture" },
    });
  try {
    const accepted = await authenticateClerk(request(), env, verifier);
    assert.deepEqual(accepted.principal, {
      id: "approved-agent",
      owner: false,
      readOnly: true,
    });
    const base = { ...access };
    for (const change of [
      { aud: ["https://foreign.example.test/mcp"] },
      { aud: undefined },
      { revoked: true },
      { expired: true },
      { expiration: 1 },
      { scopes: [] },
      { client_id: "foreign-agent" },
    ]) {
      access = { ...base, ...change };
      await assert.rejects(authenticateClerk(request(), env, verifier));
    }
    assert.equal(calls, 8);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});
