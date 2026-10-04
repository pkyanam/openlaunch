import { DurableObject } from "cloudflare:workers";
import { authenticateClerk, type ClerkEnv } from "./clerk-auth.ts";
import {
  Hub,
  emptyState,
  hash,
  type Principal,
  type State,
} from "../../../packages/core/src/index.ts";
import { handle } from "../../../packages/http/src/index.ts";
interface Env extends ClerkEnv {
  HUBS: DurableObjectNamespace;
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
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return Response.json({
        service: "openlaunch",
        protocolVersion: 1,
        authConfigured: !!(
          env.CLERK_ISSUER &&
          env.CLERK_SECRET_KEY &&
          env.API_ORIGIN
        ),
      });
    // Deployment is deliberately fail-closed until the authorization server is configured.
    if (
      !env.CLERK_ISSUER ||
      !env.CLERK_SECRET_KEY ||
      !env.CLERK_PUBLISHABLE_KEY ||
      !env.API_ORIGIN
    )
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
    if (
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(url.pathname)
    )
      return Response.json({
        resource: env.API_ORIGIN + "/mcp",
        authorization_servers: [env.CLERK_ISSUER],
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
        const authenticated = await authenticateClerk(request, env);
        workspace = authenticated.workspace;
        const principal = authenticated.principal;
        headers.set("x-openlaunch-principal", JSON.stringify(principal));
        // MCP handlers still require a per-device grant, independent of OAuth scopes.
      } catch {
        return Response.json(
          {
            error: {
              code: "unauthorized",
              message: "Sign in or connect an approved agent",
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
