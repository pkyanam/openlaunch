import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  Hub,
  emptyState,
  hash,
  type Principal,
  type State,
} from "../../../packages/core/src/index.ts";
import { handle } from "../../../packages/http/src/index.ts";
interface Env {
  HUBS: DurableObjectNamespace;
  AUTH_ISSUER?: string;
  AUTH_JWKS_URL?: string;
  API_ORIGIN?: string;
}
export class WorkspaceHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<State>("state");
      const hub = new Hub(state ?? emptyState());
      const principal = request.headers.get("x-openlaunch-principal");
      const response = await handle(request, hub, async () => {
        if (!principal) throw new Error("Missing trusted principal");
        return JSON.parse(principal) as Principal;
      });
      const serialized = JSON.stringify(hub.state);
      if (serialized !== JSON.stringify(state ?? emptyState()))
        await this.ctx.storage.put("state", hub.state);
      return response;
    });
  }
}
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return Response.json({
        service: "openlaunch",
        protocolVersion: 1,
        authConfigured: !!(
          env.AUTH_ISSUER &&
          env.AUTH_JWKS_URL &&
          env.API_ORIGIN
        ),
      });
    // Deployment is deliberately fail-closed until the authorization server is configured.
    if (!env.AUTH_ISSUER || !env.AUTH_JWKS_URL || !env.API_ORIGIN)
      return Response.json(
        {
          error: {
            code: "setup_required",
            message:
              "Authorization provider must be configured before device enrollment or MCP access",
          },
        },
        { status: 503 },
      );
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return Response.json({
        resource: env.API_ORIGIN + "/mcp",
        authorization_servers: [env.AUTH_ISSUER],
        scopes_supported: ["openlaunch:read", "openlaunch:act"],
      });
    const headers = new Headers(request.headers);
    headers.delete("x-openlaunch-principal");
    let workspace: string;
    if (url.pathname.startsWith("/v1/device/")) {
      workspace = request.headers.get("x-openlaunch-workspace") ?? "";
      if (!/^[a-f0-9]{64}$/.test(workspace))
        return new Response("Invalid workspace", { status: 400 });
    } else {
      try {
        const token = /^Bearer ([^\s]+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        if (!token) throw Error();
        const jwksUrl = new URL(env.AUTH_JWKS_URL);
        if (jwksUrl.protocol !== "https:") throw Error();
        let keys = jwksCache.get(jwksUrl.href);
        if (!keys) {
          keys = createRemoteJWKSet(jwksUrl);
          jwksCache.set(jwksUrl.href, keys);
        }
        const { payload } = await jwtVerify(token, keys, {
          issuer: env.AUTH_ISSUER,
          audience: env.API_ORIGIN + "/mcp",
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["sub", "exp"],
        });
        if (!payload.sub) throw Error();
        const scopes =
          typeof payload.scope === "string" ? payload.scope.split(" ") : [];
        if (!scopes.includes("openlaunch:read")) throw Error();
        // The external authorization server must restrict this administrative scope to dashboard sessions.
        const owner = scopes.includes("openlaunch:owner");
        const client =
          typeof payload.client_id === "string"
            ? payload.client_id
            : payload.azp;
        if (!owner && (typeof client !== "string" || !client)) throw Error();
        workspace = await hash(env.AUTH_ISSUER + "|" + payload.sub);
        if (
          !owner &&
          !scopes.includes("openlaunch:act") &&
          request.method === "POST" &&
          url.pathname !== "/mcp"
        )
          return new Response("Write scope required", { status: 403 });
        const principal: Principal = {
          id: owner ? "owner" : String(client),
          owner,
          readOnly: !owner && !scopes.includes("openlaunch:act"),
        };
        headers.set("x-openlaunch-principal", JSON.stringify(principal));
        // MCP handlers still require a per-device grant, independent of OAuth scopes.
      } catch {
        return Response.json(
          {
            error: {
              code: "unauthorized",
              message: "Valid workspace OAuth access token required",
            },
          },
          {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${env.API_ORIGIN}/.well-known/oauth-protected-resource"`,
            },
          },
        );
      }
    }
    const response = await env.HUBS.get(env.HUBS.idFromName(workspace)).fetch(
      new Request(request, { headers }),
    );
    const output = new Response(response.body, response);
    output.headers.set("x-openlaunch-workspace", workspace);
    return output;
  },
};
