import { createClerkClient } from "@clerk/backend";
import {
  hash,
  Fault,
  type Principal,
} from "../../../packages/core/src/index.ts";
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
  workspaceAdmission = false,
) {
  if (!identity.isAuthenticated || !identity.userId || !env.CLERK_ISSUER)
    throw Error("Unauthorized");
  const workspace = await hash(env.CLERK_ISSUER + "|" + identity.userId);
  if (identity.tokenType === "session_token") {
    if (path === "/mcp") throw Error("Agent OAuth token required");
    return {
      workspace,
      identityId: workspace,
      tokenType: "session_token" as const,
      principal: { id: "owner", owner: true } satisfies Principal,
    };
  }
  if (identity.tokenType !== "oauth_token" || !identity.clientId)
    throw Error("OAuth token required");
  const allowed = (env.CLERK_AGENT_CLIENT_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!workspaceAdmission && !allowed.includes(identity.clientId))
    throw Error("Agent client is not admitted");
  const scopes = identity.scopes ?? [];
  if (!scopes.includes("openlaunch:read"))
    throw new Fault("insufficient_scope", 403, "Read scope required");
  return {
    workspace,
    identityId: workspace,
    tokenType: "oauth_token" as const,
    principal: {
      id: identity.clientId,
      owner: false,
      readOnly: !scopes.includes("openlaunch:act"),
      ...(workspaceAdmission ? { oauthClient: true } : {}),
    } satisfies Principal,
  };
}
export async function authenticateClerk(
  request: Request,
  env: ClerkEnv,
  verifier?: ReturnType<typeof createClerkClient>,
  workspaceAdmission = false,
) {
  const path = new URL(request.url).pathname;
  const token = /^Bearer ([^\s]+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  // Agent tokens are opaque and checked online, including revocation and the resource audience.
  const agentToken = token?.startsWith("oat_") ?? false;
  if (path === "/mcp" && !agentToken) throw Error("Agent OAuth token required");
  const client =
    verifier ??
    createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
  if (agentToken) {
    const access = await client.idPOAuthAccessToken.verify(token!, {
      audience: env.API_ORIGIN + "/mcp",
    });
    if (
      access.revoked ||
      access.expired ||
      !access.expiration ||
      access.expiration <= Date.now() / 1000
    )
      throw Error("OAuth access expired or revoked");
    return principalFromIdentity(
      {
        isAuthenticated: true,
        tokenType: "oauth_token",
        userId: access.subject,
        clientId: access.clientId,
        scopes: access.scopes,
      },
      env,
      path,
      workspaceAdmission,
    );
  }
  const state = await client.authenticateRequest(request, {
    acceptsToken: "session_token",
    authorizedParties: [env.API_ORIGIN!],
  });
  const identity = state.toAuth();
  if (!identity?.isAuthenticated) throw Error("Unauthorized");
  if (
    identity.tokenType === "session_token" &&
    identity.sessionClaims?.iss !== env.CLERK_ISSUER
  )
    throw Error("Unexpected session issuer");
  return principalFromIdentity(identity, env, path);
}
