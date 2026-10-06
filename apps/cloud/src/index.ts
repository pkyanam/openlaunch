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
import {
  AgentOnboarding,
  DeferredIdentityStore,
  identityDirectory,
  boundedJson,
  dataResponse,
  onboardingError,
  invitationWorkspace,
  loginWorkspace,
  type WorkspaceMembership,
  type CredentialIdentity,
} from "./agent-onboarding.ts";
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
      if (path.startsWith("/__identity/")) {
        try {
          return await identityDirectory(this.ctx.storage, request);
        } catch (error) {
          return onboardingError(error);
        }
      }
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
      const workspace = request.headers.get("x-openlaunch-workspace") ?? "";
      const identityId = request.headers.get("x-openlaunch-identity");
      const metadata = new DeferredIdentityStore(this.ctx.storage);
      const onboarding = new AgentOnboarding(metadata, workspace);
      let wake: string[] = [];
      const oauthClients = this.env.CLERK_SECRET_KEY
        ? clerkOAuthClients(this.env.CLERK_SECRET_KEY)
        : undefined;
      const newOAuthApplications: string[] = [];
      const response = await this.workspaceState
        .withState(async (hub) => {
          // Long-running commands pause HTTPS polling, while authenticated
          // event pings continue. Refresh before inventory and action admission.
          this.events.refreshPresence(hub.state.devices);
          let trusted = principal
            ? (JSON.parse(principal) as Principal)
            : undefined;
          const token =
            /^Bearer ([^\s]+)$/.exec(
              request.headers.get("authorization") ?? "",
            )?.[1] ?? "";
          if (agentTokenWorkspace(token)) {
            trusted = await hub.authenticateConnection(token, workspace);
            const binding = await onboarding.credentialIdentity(trusted.id);
            if (binding) {
              if (!binding.owner) {
                const member = await onboarding.member(binding.identityId);
                if (
                  !member ||
                  member.revoked ||
                  member.id !== binding.principalId
                )
                  return onboardingError(
                    new Fault("unauthorized", 401, "Agent membership revoked"),
                  );
              }
              trusted = { ...trusted, identityId: binding.identityId };
            }
          }
          if (
            identityId &&
            request.headers.get("x-openlaunch-member") === "true"
          ) {
            const member = await onboarding.member(identityId);
            if (!member || member.revoked)
              return onboardingError(
                new Fault(
                  "forbidden",
                  403,
                  "Workspace membership no longer active",
                ),
              );
            if (!trusted)
              return onboardingError(
                new Fault("unauthorized", 401, "Sign-in required"),
              );
            const admitted = hub.admitOAuthClient(
              trusted,
              (this.env.CLERK_AGENT_CLIENT_IDS ?? "")
                .split(",")
                .filter(Boolean),
            );
            trusted = {
              ...admitted,
              id: member.id,
              owner: false,
              oauthClient: false,
              identityId,
              ...(admitted.oauthClient
                ? { accessConstraints: [admitted.id] }
                : {}),
            };
          } else if (trusted && identityId)
            trusted = { ...trusted, identityId };
          if (trusted)
            trusted = hub.applyAccessPolicy(
              hub.admitOAuthClient(
                trusted,
                (this.env.CLERK_AGENT_CLIENT_IDS ?? "")
                  .split(",")
                  .filter(Boolean),
              ),
            );
          try {
            if (path === "/__workspace/accept" && request.method === "POST") {
              if (!identityId)
                throw new Fault(
                  "unauthorized",
                  401,
                  "Verified identity required",
                );
              const input = await boundedJson(request);
              return dataResponse(
                await onboarding.accept(hub, identityId, input.invitation),
              );
            }
            if (path === "/__credential/identity" && request.method === "GET") {
              if (!trusted || !agentTokenWorkspace(token))
                throw new Fault(
                  "unauthorized",
                  401,
                  "Identity-bound CLI credential required",
                );
              const binding = await onboarding.credentialIdentity(trusted.id);
              if (!binding)
                throw new Fault(
                  "forbidden",
                  403,
                  "Use ol login --agentid to establish an agent identity",
                );
              return dataResponse(binding);
            }
            if (path === "/v1/cli-login/exchange" && request.method === "POST")
              return dataResponse(
                await onboarding.exchange(hub, await boundedJson(request)),
              );
            if (
              path === "/v1/cli-login/authorize" &&
              request.method === "POST"
            ) {
              if (
                !trusted ||
                !identityId ||
                request.headers.get("x-openlaunch-session") !== "true"
              )
                throw new Fault(
                  "forbidden",
                  403,
                  "Sign in through the browser to connect ol",
                );
              return dataResponse(
                await onboarding.authorize(
                  hub,
                  trusted,
                  identityId,
                  await boundedJson(request),
                ),
              );
            }
            if (path === "/v1/account" && request.method === "GET") {
              if (!trusted)
                throw new Fault("unauthorized", 401, "Sign-in required");
              return dataResponse({
                workspace,
                principal: trusted,
                deviceControlsEnabled: this.env.CONTROLS_ENABLED === "true",
                agentClients: (this.env.CLERK_AGENT_CLIENT_IDS ?? "")
                  .split(",")
                  .filter(Boolean),
                oauthClientRegistration: !!oauthClients,
              });
            }
            if (path === "/v1/workspace/agents" && request.method === "GET") {
              if (!trusted || (!trusted.owner && !trusted.administrator))
                throw new Fault(
                  "forbidden",
                  403,
                  "Workspace administrator required",
                );
              return dataResponse(await onboarding.members(hub));
            }
            if (
              path === "/v1/workspace/invitations" &&
              request.method === "POST"
            ) {
              if (!trusted)
                throw new Fault("unauthorized", 401, "Sign-in required");
              return dataResponse(
                await onboarding.invite(
                  hub,
                  trusted,
                  await boundedJson(request),
                ),
                201,
              );
            }
            const memberRevoke =
              /^\/v1\/workspace\/agents\/(agent:[a-f0-9]{64})\/revoke$/.exec(
                path,
              );
            if (memberRevoke && request.method === "POST") {
              if (!trusted)
                throw new Fault("unauthorized", 401, "Sign-in required");
              return dataResponse(
                await onboarding.revoke(hub, trusted, memberRevoke[1]!),
              );
            }
          } catch (error) {
            return onboardingError(error);
          }
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
              return trusted!;
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
              cloud: async (
                method: string,
                route: string,
                payload?: unknown,
              ) => {
                if (!trusted)
                  throw new Fault("unauthorized", 401, "Sign-in required");
                const actorIdentity = trusted.identityId;
                if (route === "/v1/workspace/invitations" && method === "POST")
                  return onboarding.invite(hub, trusted, payload);
                if (route === "/v1/workspace/agents" && method === "GET") {
                  if (!trusted.owner && !trusted.administrator)
                    throw new Fault(
                      "forbidden",
                      403,
                      "Workspace administrator required",
                    );
                  return onboarding.members(hub);
                }
                const revoke =
                  /^\/v1\/workspace\/agents\/(agent:[a-f0-9]{64})\/revoke$/.exec(
                    route,
                  );
                if (revoke && method === "POST")
                  return onboarding.revoke(hub, trusted, revoke[1]!);
                if (!actorIdentity) {
                  if (route === "/v1/workspaces" && method === "GET")
                    return [
                      {
                        workspace,
                        name: "Connected workspace",
                        role: trusted.administrator
                          ? "administrator"
                          : "operator",
                        principalId: trusted.id,
                      },
                    ];
                  throw new Fault(
                    "forbidden",
                    403,
                    "Sign in with AgentID to join or select workspaces",
                  );
                }
                const directory = this.env.HUBS.get(
                  this.env.HUBS.idFromName(
                    "identity-directory:" + actorIdentity,
                  ),
                );
                const callDirectory = async (
                  path: string,
                  verb = "GET",
                  body?: unknown,
                ) => {
                  const response = await directory.fetch(
                    new Request(this.env.API_ORIGIN + path, {
                      method: verb,
                      headers: { "content-type": "application/json" },
                      ...(body === undefined
                        ? {}
                        : { body: JSON.stringify(body) }),
                    }),
                  );
                  if (!response.ok)
                    throw new Fault(
                      "unavailable",
                      503,
                      "Workspace index unavailable",
                    );
                  return ((await response.json()) as { data: any }).data;
                };
                const indexed = await callDirectory("/__identity/list");
                if (route === "/v1/workspaces" && method === "GET")
                  return [
                    {
                      workspace: actorIdentity,
                      name: "My workspace",
                      role: "owner",
                      principalId: "owner",
                    },
                    ...indexed.memberships,
                  ];
                if (route === "/v1/workspaces/select" && method === "POST") {
                  const target = (payload as { workspace?: unknown })
                    ?.workspace;
                  if (
                    typeof target !== "string" ||
                    !(
                      target === actorIdentity ||
                      indexed.memberships.some(
                        (m: WorkspaceMembership) => m.workspace === target,
                      )
                    )
                  )
                    throw new Fault(
                      "forbidden",
                      403,
                      "Workspace membership required",
                    );
                  // Scoped credentials select a target for their next login;
                  // only a browser session changes the identity's default.
                  if (request.headers.get("x-openlaunch-session") === "true")
                    await callDirectory("/__identity/select", "POST", {
                      workspace: target,
                    });
                  return { workspace: target };
                }
                if (route === "/v1/workspaces/accept" && method === "POST") {
                  const invitation = (payload as { invitation?: unknown })
                    ?.invitation;
                  const target =
                    typeof invitation === "string"
                      ? invitationWorkspace(invitation)
                      : undefined;
                  if (
                    !target ||
                    target === actorIdentity ||
                    target === workspace
                  )
                    throw new Fault(
                      "invalid",
                      400,
                      "Invalid workspace invitation",
                    );
                  const response = await this.env.HUBS.get(
                    this.env.HUBS.idFromName(target),
                  ).fetch(
                    new Request(this.env.API_ORIGIN + "/__workspace/accept", {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                        "x-openlaunch-workspace": target,
                        "x-openlaunch-identity": actorIdentity,
                      },
                      body: JSON.stringify({ invitation }),
                    }),
                  );
                  if (!response.ok) {
                    const error = (
                      (await response.json()) as {
                        error: { code: string; message: string };
                      }
                    ).error;
                    throw new Fault(error.code, response.status, error.message);
                  }
                  const membership = (
                    (await response.json()) as { data: WorkspaceMembership }
                  ).data;
                  await callDirectory("/__identity/link", "POST", membership);
                  return membership;
                }
                throw new Fault(
                  "not_found",
                  404,
                  "Workspace operation not found",
                );
              },
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
                .map(
                  (a) =>
                    hub.state.devices.find((device) => device.id === a.deviceId)
                      ?.gatewayId ?? a.deviceId,
                ),
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
          if (error instanceof Fault) return onboardingError(error);
          throw error;
        });
      if (response.ok) {
        try {
          await metadata.commit();
        } catch {
          return onboardingError(
            new Fault(
              "unavailable",
              503,
              "Onboarding metadata could not be saved; retry the request",
            ),
          );
        }
      }
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
    if (url.pathname.startsWith("/__"))
      return new Response("Not found", { status: 404 });
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
    headers.delete("x-openlaunch-identity");
    headers.delete("x-openlaunch-member");
    headers.delete("x-openlaunch-session");
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
    // The authenticated device handler checks kind/action before admitting a
    // screenshot. Never widen agent requests or embedded result envelopes.
    const requestLimit = /^\/v1\/device\/[a-f0-9-]{36}\/children\/status$/.test(
      url.pathname,
    )
      ? 524288
      : /^\/v1\/device\/[a-f0-9-]{36}\/(?:result|children(?:\/status)?)$/.test(
            url.pathname,
          )
        ? 65536
        : 16384;
    if (Number(request.headers.get("content-length") ?? "0") > requestLimit)
      return Response.json(
        { error: { code: "too_large", message: "Request too large" } },
        { status: 413 },
      );
    const directory = async (
      identityId: string,
      path: string,
      method = "GET",
      body?: unknown,
    ) => {
      const response = await env.HUBS.get(
        env.HUBS.idFromName("identity-directory:" + identityId),
      ).fetch(
        new Request(env.API_ORIGIN + path, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      if (!response.ok)
        throw new Fault(
          "unavailable",
          503,
          "Workspace identity index unavailable",
        );
      return ((await response.json()) as { data: any }).data;
    };
    let workspace: string;
    let verifiedIdentity: string | undefined;
    let homeWorkspace: string | undefined;
    let basePrincipal: Principal | undefined;
    let indexed:
      { memberships: WorkspaceMembership[]; selected?: string } | undefined;
    if (
      url.pathname === "/v1/cli-login/exchange" &&
      request.method === "POST"
    ) {
      try {
        const input = await boundedJson(request.clone());
        workspace = loginWorkspace(input.code ?? "") ?? "";
        if (!workspace)
          throw new Fault("unauthorized", 401, "Invalid login code");
      } catch (error) {
        return onboardingError(error);
      }
    } else if (url.pathname.startsWith("/v1/device/")) {
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
      if (
        request.headers.get("x-openlaunch-target-workspace") &&
        request.headers.get("x-openlaunch-target-workspace") !== workspace
      )
        return onboardingError(
          new Fault(
            "forbidden",
            403,
            "API credentials are bound to one workspace; sign in to switch",
          ),
        );
      if (
        [
          "/v1/workspaces",
          "/v1/workspaces/accept",
          "/v1/workspaces/select",
        ].includes(url.pathname)
      ) {
        try {
          const identityResponse = await env.HUBS.get(
            env.HUBS.idFromName(workspace),
          ).fetch(
            new Request(env.API_ORIGIN + "/__credential/identity", {
              headers: {
                authorization: request.headers.get("authorization") ?? "",
                "x-openlaunch-workspace": workspace,
              },
            }),
          );
          if (!identityResponse.ok) {
            if (
              identityResponse.status === 403 &&
              url.pathname === "/v1/workspaces" &&
              request.method === "GET"
            )
              return dataResponse([
                {
                  workspace,
                  name: "Connected workspace",
                  role: "operator",
                  principalId: "connection",
                },
              ]);
            return identityResponse;
          }
          const binding = (
            (await identityResponse.json()) as { data: CredentialIdentity }
          ).data;
          verifiedIdentity = binding.identityId;
          homeWorkspace = verifiedIdentity;
          indexed = await directory(verifiedIdentity, "/__identity/list");
        } catch (error) {
          return onboardingError(error);
        }
      }
    } else {
      try {
        const authenticated = await authenticateClerk(
          request,
          env,
          undefined,
          true,
        );
        verifiedIdentity = authenticated.identityId;
        homeWorkspace = authenticated.workspace;
        indexed = await directory(verifiedIdentity, "/__identity/list");
        const target =
          request.headers.get("x-openlaunch-target-workspace") ??
          url.searchParams.get("workspace");
        workspace = target ?? indexed!.selected ?? homeWorkspace;
        if (!/^[a-f0-9]{64}$/.test(workspace))
          throw new Fault("forbidden", 403, "Invalid workspace selection");
        if (
          workspace !== homeWorkspace &&
          !indexed!.memberships.some((m) => m.workspace === workspace)
        )
          throw new Fault(
            "forbidden",
            403,
            "Join this workspace before selecting it",
          );
        basePrincipal = authenticated.principal;
        headers.set("x-openlaunch-principal", JSON.stringify(basePrincipal));
        headers.set("x-openlaunch-identity", verifiedIdentity);
        if (workspace !== homeWorkspace)
          headers.set("x-openlaunch-member", "true");
        if (authenticated.tokenType === "session_token")
          headers.set("x-openlaunch-session", "true");
        if (
          authenticated.tokenType === "oauth_token" &&
          [
            "/v1/workspaces",
            "/v1/workspaces/accept",
            "/v1/workspaces/select",
          ].includes(url.pathname)
        ) {
          const admitted = await env.HUBS.get(
            env.HUBS.idFromName(workspace),
          ).fetch(
            new Request(env.API_ORIGIN + "/v1/account", {
              headers: new Headers({
                ...Object.fromEntries(headers),
                "x-openlaunch-workspace": workspace,
              }),
            }),
          );
          if (!admitted.ok) return admitted;
          if (request.method !== "GET" && basePrincipal.readOnly)
            throw new Fault("insufficient_scope", 403, "Action scope required");
        }
      } catch (error) {
        if (error instanceof Fault && error.code !== "insufficient_scope")
          return onboardingError(error);
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
    if (verifiedIdentity && homeWorkspace && indexed) {
      if (url.pathname === "/v1/workspaces" && request.method === "GET")
        return dataResponse([
          {
            workspace: homeWorkspace,
            name: "My workspace",
            role: "owner",
            principalId: "owner",
          },
          ...indexed.memberships,
        ]);
      if (
        url.pathname === "/v1/workspaces/accept" &&
        request.method === "POST"
      ) {
        try {
          const input = await boundedJson(request);
          if (
            typeof input.invitation !== "string" ||
            Object.keys(input).length !== 1
          )
            throw new Fault("invalid", 400, "Provide one workspace invitation");
          const invitedWorkspace = invitationWorkspace(input.invitation);
          if (!invitedWorkspace || invitedWorkspace === homeWorkspace)
            throw new Fault("invalid", 400, "Invalid workspace invitation");
          const response = await env.HUBS.get(
            env.HUBS.idFromName(invitedWorkspace),
          ).fetch(
            new Request(env.API_ORIGIN + "/__workspace/accept", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-openlaunch-workspace": invitedWorkspace,
                "x-openlaunch-identity": verifiedIdentity,
              },
              body: JSON.stringify(input),
            }),
          );
          if (!response.ok) return response;
          const membership = (
            (await response.json()) as { data: WorkspaceMembership }
          ).data;
          await directory(
            verifiedIdentity,
            "/__identity/link",
            "POST",
            membership,
          );
          return dataResponse(membership);
        } catch (error) {
          return onboardingError(error);
        }
      }
      if (
        url.pathname === "/v1/workspaces/select" &&
        request.method === "POST"
      ) {
        try {
          const input = await boundedJson(request);
          if (
            typeof input.workspace !== "string" ||
            Object.keys(input).length !== 1 ||
            !(
              input.workspace === homeWorkspace ||
              indexed.memberships.some((m) => m.workspace === input.workspace)
            )
          )
            throw new Fault("forbidden", 403, "Workspace membership required");
          if (headers.get("x-openlaunch-session") === "true")
            await directory(
              verifiedIdentity,
              "/__identity/select",
              "POST",
              input,
            );
          return dataResponse(input);
        } catch (error) {
          return onboardingError(error);
        }
      }
    }
    if (
      env.CONTROLS_ENABLED !== "true" &&
      ![
        "/v1/account",
        "/v1/cli-login/authorize",
        "/v1/cli-login/exchange",
      ].includes(url.pathname) &&
      !url.pathname.startsWith("/v1/workspace/")
    )
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
