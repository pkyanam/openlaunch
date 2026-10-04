import { createClerkClient } from "@clerk/backend";
import { hash, type Principal } from "../../../packages/core/src/index.ts";
export interface ClerkEnv {
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_ISSUER?: string;
  API_ORIGIN?: string;
  CLERK_AGENT_CLIENT_IDS?: string;
}
export type VerifiedIdentity = {
  isAuthenticated: boolean;
  tokenType: string;
  userId?: string | null;
  clientId?: string | null;
  scopes?: string[] | null;
};
export async function principalFromIdentity(
  identity: VerifiedIdentity,
  env: ClerkEnv,
  path: string,
) {
  if (!identity.isAuthenticated || !identity.userId || !env.CLERK_ISSUER)
    throw Error("Unauthorized");
  const workspace = await hash(env.CLERK_ISSUER + "|" + identity.userId);
  if (identity.tokenType === "session_token") {
    if (path === "/mcp") throw Error("Agent OAuth token required");
    return {
      workspace,
      principal: { id: "owner", owner: true } satisfies Principal,
    };
  }
  if (identity.tokenType !== "oauth_token" || !identity.clientId)
    throw Error("OAuth token required");
  const allowed = (env.CLERK_AGENT_CLIENT_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!allowed.includes(identity.clientId))
    throw Error("Agent client is not admitted");
  const scopes = identity.scopes ?? [];
  if (!scopes.includes("openlaunch:read")) throw Error("Read scope required");
  return {
    workspace,
    principal: {
      id: identity.clientId,
      owner: false,
      readOnly: !scopes.includes("openlaunch:act"),
    } satisfies Principal,
  };
}
export async function authenticateClerk(request: Request, env: ClerkEnv) {
  const path = new URL(request.url).pathname;
  const token = /^Bearer ([^\s]+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  // Agent tokens are opaque and checked online, including revocation and the resource audience.
  const agentToken = token?.startsWith("oat_") ?? false;
  if (path === "/mcp" && !agentToken) throw Error("Agent OAuth token required");
  const client = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
  const state = await client.authenticateRequest(request, {
    acceptsToken: agentToken ? "oauth_token" : "session_token",
    authorizedParties: [env.API_ORIGIN!],
    ...(agentToken ? { audience: env.API_ORIGIN + "/mcp" } : {}),
  });
  const identity = state.toAuth();
  if (!identity) throw Error("Unauthorized");
  if (
    identity.tokenType === "session_token" &&
    identity.sessionClaims?.iss !== env.CLERK_ISSUER
  )
    throw Error("Unexpected session issuer");
  return principalFromIdentity(identity, env, path);
}
