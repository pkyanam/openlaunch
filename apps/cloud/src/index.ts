import { createDeviceCredentialDeriver } from "../../../packages/core/src/device-credentials.ts";
import { DurableObject } from "cloudflare:workers";
import { authenticateClerk, type ClerkEnv } from "./clerk-auth.ts";
import { clerkOAuthClients } from "./oauth-clients.ts";
import {
  agentTokenWorkspace,
  Fault,
  type Principal,
} from "../../../packages/core/src/index.ts";
import { handle } from "../../../packages/http/src/index.ts";
import { WorkspaceSQLiteStateCache } from "./sqlite-state.ts";
import { DeviceEvents, type DeviceEventsSocket } from "./device-events.ts";
interface Env extends ClerkEnv {
  HUBS: DurableObjectNamespace;
  API_ORIGIN?: string;
  CONTROLS_ENABLED?: string;
  BUILD_COMMIT?: string;
  REQUEST_LIMITER: RateLimit;
  DEVICE_CREDENTIAL_KEYS?: string;
  DEVICE_CREDENTIAL_KEY_VERSION?: string;
}
export class WorkspaceHub extends DurableObject<Env> {
  private readonly events: DeviceEvents;
  private readonly workspaceState: WorkspaceSQLiteStateCache;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspaceState = new WorkspaceSQLiteStateCache(
      ctx.storage,
      ctx.storage.sql,
    );
    this.events = new DeviceEvents(ctx, async (id, credential) =>
      this.workspaceState.withState((hub) =>
        hub.authenticateDevice(id, credential),
      ),
    );
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.events.webSocketMessage(socket as DeviceEventsSocket, message);
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      const eventRoute =
        /^\/v1\/device\/([a-f0-9-]{36})\/events(-ticket)?$/.exec(path);
      if (eventRoute) {
        if (eventRoute[2])
          return this.events.handleTicket(request, eventRoute[1]!);
        // Ticket possession must not outlive canonical device revocation, even
        // if clearing the ticket store previously failed after the state commit.
        const active = await this.workspaceState.withState(async (hub) =>
          hub.state.devices.some(
            (device) => device.id === eventRoute[1] && !device.revoked,
          ),
        );
        if (!active)
          return Response.json(
            {
              error: {
                code: "unauthorized",
                message: "Device access is no longer valid",
              },
            },
            { status: 401 },
          );
        return this.events.handleUpgrade(request, eventRoute[1]!);
      }
      const principal = request.headers.get("x-openlaunch-principal");
      let wake: string[] = [];
      const oauthClients = this.env.CLERK_SECRET_KEY
        ? clerkOAuthClients(this.env.CLERK_SECRET_KEY)
        : undefined;
      const newOAuthApplications: string[] = [];
      const response = await this.workspaceState
        .withState(async (hub) => {
          const knownApplications = new Set(
            hub.state.agentConnections?.map((c) => c.oauth?.applicationId),
          );
          const queued = new Set(
            hub.state.actions
              .filter((a) => a.status === "queued")
              .map((a) => a.id),
          );
          const response = await handle(
            request,
            hub,
            async () => {
              if (!principal) throw new Error("Missing trusted principal");
              return JSON.parse(principal) as Principal;
            },
            {
              workspace: request.headers.get("x-openlaunch-workspace") ?? "",
              deviceCredentials: createDeviceCredentialDeriver(
                this.env.DEVICE_CREDENTIAL_KEYS,
                this.env.DEVICE_CREDENTIAL_KEY_VERSION ?? "v1",
              ),
              oauthClients,
              oauthBuiltinClients: (this.env.CLERK_AGENT_CLIENT_IDS ?? "")
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
              resourceMetadata:
                this.env.API_ORIGIN +
                "/.well-known/oauth-protected-resource/mcp",
            },
          );
          for (const connection of hub.state.agentConnections ?? [])
            if (
              connection.oauth &&
              !knownApplications.has(connection.oauth.applicationId)
            )
              newOAuthApplications.push(connection.oauth.applicationId);
          wake = [
            ...new Set(
              hub.state.actions
                .filter((a) => a.status === "queued" && !queued.has(a.id))
                .map((a) => a.deviceId),
            ),
          ];
          return response;
        })
        .catch(async (error) => {
          // Provider registration precedes the SQLite commit. If that commit
          // fails, remove the new provider app and never return its credentials.
          if (oauthClients)
            await Promise.allSettled(
              newOAuthApplications.map((id) => oauthClients.delete(id)),
            );
          throw error;
        });
      // Notify only after the canonical action state has been durably committed.
      if (wake.length) this.events.notify(wake);
      const revoked = /^\/v1\/devices\/([a-f0-9-]{36})\/revoke$/.exec(path);
      if (revoked && request.method === "POST" && response.ok)
        await this.events.closeDevice(revoked[1]!);
      return response;
    });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:")
      return Response.json(
        {
          error: { code: "https_required", message: "Use the HTTPS endpoint" },
        },
        { status: 426, headers: { "cache-control": "no-store" } },
      );
    if (url.pathname === "/healthz")
      return Response.json({
        service: "openlaunch",
        protocolVersion: 1,
        commit: env.BUILD_COMMIT ?? "development",
        authConfigured: !!(
          env.CLERK_ISSUER &&
          env.CLERK_SECRET_KEY &&
          env.API_ORIGIN
        ),
        deviceControlsEnabled: env.CONTROLS_ENABLED === "true",
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
    headers.delete("x-openlaunch-workspace");
    if (
      !(
        await env.REQUEST_LIMITER.limit({
          key: request.headers.get("cf-connecting-ip") ?? "unknown",
        })
      ).success
    )
      return Response.json(
        { error: { code: "rate_limit", message: "Try again shortly" } },
        {
          status: 429,
          headers: { "retry-after": "60", "cache-control": "no-store" },
        },
      );
    const origin = request.headers.get("origin");
    if (origin && origin !== env.API_ORIGIN)
      return Response.json(
        { error: { code: "origin", message: "Cross-origin request rejected" } },
        { status: 403 },
      );
    if (Number(request.headers.get("content-length") ?? "0") > 16384)
      return Response.json(
        { error: { code: "too_large", message: "Request too large" } },
        { status: 413 },
      );
    let workspace: string;
    if (url.pathname.startsWith("/v1/device/")) {
      workspace = /\/events$/.test(url.pathname)
        ? (url.searchParams.get("workspace") ?? "")
        : (request.headers.get("x-openlaunch-workspace") ?? "");
      if (!/^[a-f0-9]{64}$/.test(workspace))
        return new Response("Invalid workspace", { status: 400 });
    } else if (
      agentTokenWorkspace(
        /^Bearer ([^\s]+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1] ?? "",
      )
    ) {
      workspace = agentTokenWorkspace(
        /^Bearer ([^\s]+)$/.exec(
          request.headers.get("authorization") ?? "",
        )?.[1] ?? "",
      )!;
    } else {
      try {
        const authenticated = await authenticateClerk(
          request,
          env,
          undefined,
          true,
        );
        workspace = authenticated.workspace;
        const principal = authenticated.principal;
        headers.set("x-openlaunch-principal", JSON.stringify(principal));
        if (url.pathname === "/v1/account" && principal.owner)
          return Response.json(
            {
              data: {
                workspace,
                principal,
                deviceControlsEnabled: env.CONTROLS_ENABLED === "true",
                agentClients: (env.CLERK_AGENT_CLIENT_IDS ?? "")
                  .split(",")
                  .filter(Boolean),
                oauthClientRegistration: true,
              },
            },
            { headers: { "cache-control": "no-store" } },
          );
        // MCP handlers still require a per-device grant, independent of OAuth scopes.
      } catch (error) {
        const insufficient =
          error instanceof Fault && error.code === "insufficient_scope";
        return Response.json(
          {
            error: {
              code: insufficient ? "insufficient_scope" : "unauthorized",
              message: insufficient
                ? "Read scope required"
                : "Sign in or connect an approved agent",
            },
          },
          {
            status: insufficient ? 403 : 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${env.API_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="openlaunch:read"${insufficient ? ', error="insufficient_scope"' : ""}`,
              "cache-control": "no-store",
            },
          },
        );
      }
    }
    if (env.CONTROLS_ENABLED !== "true")
      return Response.json(
        {
          error: {
            code: "setup_required",
            message: "Device linking is not enabled for this deployment",
          },
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    headers.set("x-openlaunch-workspace", workspace);
    const response = await env.HUBS.get(env.HUBS.idFromName(workspace)).fetch(
      new Request(request, { headers }),
    );
    // Preserve Cloudflare's WebSocket response extension across the service boundary.
    if (response.status === 101) return response;
    const output = new Response(response.body, response);
    output.headers.set("x-openlaunch-workspace", workspace);
    return output;
  },
};
