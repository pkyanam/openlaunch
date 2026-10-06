import { z } from "zod";
import {
  enrollRequestSchema,
  manifestRequestSchema,
  heartbeatRequestSchema,
  gatewayChildrenSchema,
  gatewayStatusSchema,
  gatewayGrantSchema,
  resultRequestSchema,
  attachRequestSchema,
  enrollmentRequestSchema,
  createAgentConnectionSchema,
  createSetupTokenSchema,
  grantRequestSchema,
  revokeGrantRequestSchema,
  broadcastRequestSchema,
  actionRequestSchema,
  oauthClientConfigSchema,
} from "./contracts.ts";
import {
  Hub,
  Fault,
  deviceKind,
  capabilityName,
  type Principal,
  agentTokenWorkspace,
  type DeviceCredentialDeriver,
} from "../../core/src/index.ts";
import { functionGuide } from "../../core/src/function-guides.ts";
import { type OAuthClientProvider } from "../../core/src/oauth-clients.ts";
import { createMcp, toolNeedsActionScope } from "../../mcp/src/index.ts";
import {
  handlePerRequestMcp,
  rpcError,
  usesPerRequestProtocol,
} from "../../mcp/src/http-2026.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
const caps = capabilityName;
const bearer = (r: Request) =>
  /^Bearer ([^\s]+)$/.exec(r.headers.get("authorization") ?? "")?.[1] ?? "";
const json = (data: unknown, status = 200) => {
  // Explicit byte framing lets embedded HTTP/1.1 clients finish a response
  // without waiting for an idle timeout and safely reuse the TLS connection.
  const payload = new TextEncoder().encode(JSON.stringify({ data }));
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
const body = async (r: Request, limit = 16384) => {
  const reader = r.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Fault("too_large", 413, "Request too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    const zeroBytes = bytes.reduce(
      (count, byte) => count + Number(byte === 0),
      0,
    );
    throw new Fault(
      "invalid_json",
      400,
      `Invalid JSON (bytes=${bytes.length}, zeroBytes=${zeroBytes}, first=${bytes[0] ?? -1}, last=${bytes.at(-1) ?? -1})`,
    );
  }
};
export async function handle(
  request: Request,
  hub: Hub,
  resolve: (r: Request) => Promise<Principal>,
  context: {
    workspace?: string;
    deviceCredentials?: DeviceCredentialDeriver;
    oauthClients?: OAuthClientProvider;
    oauthBuiltinClients?: string[];
    resourceMetadata?: string;
  } = {},
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (path === "/healthz" && method === "GET")
      return json({ service: "openlaunch", protocolVersion: 1 });
    // Reject browser-originated cross-origin requests before credentialed operations.
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new Fault("origin", 403, "Cross-origin request rejected");
    if (path === "/v1/device/enroll") {
      if (method !== "POST")
        throw new Fault("method", 405, "Method not allowed");
      const b = enrollRequestSchema.parse(await body(request));
      return json(await hub.enroll(b.token, b.manifest), 201);
    }
    const gatewayRoute =
      /^\/v1\/device\/([a-f0-9-]{36})\/(children|children\/status)$/.exec(path);
    if (gatewayRoute) {
      const id = gatewayRoute[1]!;
      const device = await hub.authenticateDevice(id, bearer(request));
      if (method !== "POST")
        throw new Fault("method", 405, "Method not allowed");
      if (!device.kind.startsWith("gateway.") || !device.gatewayDeviceLimit)
        throw new Fault("forbidden", 403, "Approved gateway required");
      if (gatewayRoute[2] === "children") {
        const input = gatewayChildrenSchema.parse(await body(request, 65536));
        return json(hub.gatewayChildren(id, input.children));
      }
      const input = gatewayStatusSchema.parse(await body(request, 524288));
      return json(hub.gatewayStatus(id, input.online, input.keys));
    }
    const deviceRoute =
      /^\/v1\/device\/([a-f0-9-]{36})\/(next|result|manifest|heartbeat)$/.exec(
        path,
      );
    if (deviceRoute) {
      const id = deviceRoute[1]!;
      await hub.authenticateDevice(id, bearer(request));
      if (deviceRoute[2] === "heartbeat" && method === "POST") {
        heartbeatRequestSchema.parse(await body(request, 128));
        return json(hub.heartbeat(id));
      }
      if (deviceRoute[2] === "manifest" && method === "POST") {
        const b = manifestRequestSchema.parse(await body(request));
        return json(hub.publishManifest(id, b.manifest));
      }
      if (deviceRoute[2] === "next" && method === "POST")
        return json(hub.next(id));
      if (deviceRoute[2] === "result" && method === "POST") {
        // Authentication precedes the host-only larger envelope. The Hub
        // permits larger results only for the dispatched screenshot action.
        const host =
          hub.state.devices.find((device) => device.id === id)?.kind ===
          "linux";
        const b = resultRequestSchema.parse(
          await body(request, host ? 65536 : 16384),
        );
        return json(hub.result(id, b.actionId, b.status, b.result));
      }
      throw new Fault("method", 405, "Method not allowed");
    }
    // Device credentials never become owner/agent credentials on a misspelled
    // route. Report the route error before resolving an agent principal.
    if (path.startsWith("/v1/device/"))
      throw new Fault("not_found", 404, "Device route not found");
    const token = bearer(request);
    let p = agentTokenWorkspace(token)
      ? await hub.authenticateConnection(token, context.workspace ?? "")
      : await resolve(request);
    p = hub.admitOAuthClient(p, context.oauthBuiltinClients);
    if (
      p.connectionPurpose === "device-setup" &&
      !(path === "/v1/sdk/devices" && method === "POST")
    )
      throw new Fault(
        "forbidden",
        403,
        "Device setup tokens can only attach devices",
      );
    if (path === "/mcp") {
      if (method !== "POST")
        return Response.json(
          { error: { code: "method", message: "Stateless MCP uses POST" } },
          {
            status: 405,
            headers: { allow: "POST", "cache-control": "no-store" },
          },
        );
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        return rpcError(
          null,
          -32600,
          "Content-Type must be application/json",
          415,
        );
      const accept = request.headers.get("accept") ?? "";
      const acceptedTypes = accept
        .split(",")
        .map((value) => value.trim().split(";")[0]);
      if (
        !acceptedTypes.includes("application/json") ||
        !acceptedTypes.includes("text/event-stream")
      )
        return rpcError(
          null,
          -32600,
          "Accept must include application/json and text/event-stream",
          406,
        );
      let message: any;
      try {
        message = await body(request);
      } catch (error) {
        if (error instanceof Fault && error.code === "invalid_json")
          return rpcError(null, -32700, "Parse error");
        throw error;
      }
      // Only trusted token scopes and live grants authorize execution; request
      // metadata and client capabilities are self-reported protocol information.
      if (usesPerRequestProtocol(request, message))
        return handlePerRequestMcp(request, message, hub, p);
      if (
        message?.method === "tools/call" &&
        p.readOnly &&
        toolNeedsActionScope(
          hub,
          p,
          message.params?.name,
          message.params?.arguments,
        )
      )
        throw new Fault("insufficient_scope", 403, "Write scope required");
      const server = createMcp(hub, p);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, {
          parsedBody: message,
        });
      } finally {
        await server.close();
      }
    }
    if (path === "/v1/sdk/devices" && method === "POST") {
      const b = attachRequestSchema.parse(await body(request));
      if (!context.deviceCredentials)
        throw new Fault(
          "setup_required",
          503,
          "Device attachment is not configured",
        );
      return json(
        await hub.attachDevice(
          p,
          context.workspace ?? "",
          b.requestId,
          b.manifest,
          context.deviceCredentials,
        ),
        201,
      );
    }
    if (path === "/v1/devices" && method === "GET") return json(hub.list(p));
    if (path === "/v1/actions" && method === "GET") return json(hub.history(p));
    if (path === "/v1/actions/export" && method === "GET")
      return json(hub.exportHistory(p));
    if (path === "/v1/grants" && method === "GET") return json(hub.grants(p));
    if (path === "/v1/functions" && method === "GET") {
      return json(
        hub.functionCatalog(p).map((functionRow) => ({
          ...functionRow,
          guide: functionGuide(functionRow.kind, functionRow.definition),
        })),
      );
    }
    if (path === "/v1/enrollments" && method === "POST") {
      const b = enrollmentRequestSchema.parse(await body(request));
      return json(await hub.enrollment(p, b.kind), 201);
    }
    if (path === "/v1/agent-connections" && method === "GET")
      return json(
        hub
          .connections(p)
          .filter((c) => !["device-setup", "oauth"].includes(c.purpose ?? "")),
      );
    if (path === "/v1/oauth-clients" && method === "GET")
      return json({
        available: !!context.oauthClients,
        clients: hub.connections(p).filter((c) => c.purpose === "oauth"),
      });
    if (path === "/v1/oauth-clients" && method === "POST") {
      // Ownership and capacity precede any provider-side registration.
      hub.checkOAuthClientCapacity(p);
      const config = oauthClientConfigSchema.parse(await body(request));
      if (!context.oauthClients)
        throw new Fault(
          "setup_required",
          503,
          "OAuth client registration is not configured for this server",
        );
      const created = await context.oauthClients.create(config);
      try {
        const client = hub.registerOAuthClient(p, config, created);
        return json(
          {
            ...client,
            ...(created.clientSecret
              ? { clientSecret: created.clientSecret }
              : {}),
          },
          201,
        );
      } catch (error) {
        await context.oauthClients
          .delete(created.applicationId)
          .catch(() => undefined);
        throw error;
      }
    }
    const oauthRevoke = /^\/v1\/oauth-clients\/([a-f0-9-]{36})\/revoke$/.exec(
      path,
    );
    if (oauthRevoke && method === "POST") {
      hub.connections(p); // Owner-only; never expose other workspaces' provider apps.
      const connection = hub.state.agentConnections!.find(
        (c) => c.id === oauthRevoke[1] && c.purpose === "oauth",
      );
      if (!connection?.oauth)
        throw new Fault("not_found", 404, "OAuth client not found");
      hub.revokeConnection(p, connection.id);
      let providerCleanupPending = true;
      if (context.oauthClients) {
        try {
          await context.oauthClients.delete(connection.oauth.applicationId);
          providerCleanupPending = false;
        } catch {
          /* Local admission is revoked even if the provider is unavailable. */
        }
      }
      return json({ ok: true, providerCleanupPending });
    }
    if (path === "/v1/agent-connections" && method === "POST") {
      const b = createAgentConnectionSchema.parse(await body(request));
      return json(
        await hub.createConnection(
          p,
          context.workspace ?? "",
          b.name,
          b.ttlSeconds,
          b.access,
          { canAttach: false, deviceLimit: 0 },
          "agent",
        ),
        201,
      );
    }
    if (
      ["/v1/device-setup-tokens", "/v1/sdk-tokens"].includes(path) &&
      method === "GET"
    )
      return json(hub.deviceSetupTokens(p));
    if (
      ["/v1/device-setup-tokens", "/v1/sdk-tokens"].includes(path) &&
      method === "POST"
    ) {
      const b = createSetupTokenSchema.parse(await body(request));
      return json(
        await hub.createConnection(
          p,
          context.workspace ?? "",
          b.name,
          b.ttlSeconds,
          "act",
          {
            canAttach: true,
            deviceLimit: b.deviceLimit,
            ...(b.gatewayDeviceLimit
              ? { gatewayDeviceLimit: b.gatewayDeviceLimit }
              : {}),
          },
          "device-setup",
        ),
        201,
      );
    }
    const connectionRevoke =
      /^\/v1\/(?:agent-connections|device-setup-tokens|sdk-tokens)\/([a-f0-9-]{36})\/revoke$/.exec(
        path,
      );
    if (connectionRevoke && method === "POST")
      return json(hub.revokeConnection(p, connectionRevoke[1]!));
    const gatewayGrant =
      /^\/v1\/devices\/([a-f0-9-]{36})\/gateway-grants$/.exec(path);
    if (gatewayGrant && method === "POST") {
      const b = gatewayGrantSchema.parse(await body(request));
      return json(
        hub.gatewayGrants(
          p,
          gatewayGrant[1]!,
          b.principal,
          b.mode,
          b.includeServices,
          b.ttlSeconds,
        ),
      );
    }
    if (path === "/v1/grants" && method === "POST") {
      const b = grantRequestSchema.parse(await body(request));
      return json(
        hub.grant(p, b.principal, b.deviceId, b.capabilities, b.ttlSeconds),
      );
    }
    if (path === "/v1/grants/revoke" && method === "POST") {
      const b = revokeGrantRequestSchema.parse(await body(request));
      return json(hub.revokeGrant(p, b.principal, b.deviceId));
    }
    if (path === "/v1/broadcasts" && method === "POST") {
      const b = broadcastRequestSchema.parse(await body(request));
      return json(
        hub.broadcast(
          p,
          b.deviceIds,
          b.capability,
          b.arguments,
          b.idempotencyKey,
          b.ttlSeconds,
        ),
        202,
      );
    }
    const revoke = /^\/v1\/devices\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (revoke && method === "POST") return json(hub.revoke(p, revoke[1]!));
    const action = /^\/v1\/devices\/([a-f0-9-]{36})\/actions$/.exec(path);
    if (action && method === "POST") {
      const b = actionRequestSchema.parse(await body(request));
      return json(
        hub.request(
          p,
          action[1]!,
          b.capability,
          b.arguments,
          b.idempotencyKey,
          b.ttlSeconds,
        ),
        202,
      );
    }
    const result = /^\/v1\/actions\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
    if (result && method === "GET" && !result[2])
      return json(hub.get(p, result[1]!));
    if (result && method === "POST" && result[2])
      return json(hub.cancel(p, result[1]!));
    throw new Fault("not_found", 404, "Route not found");
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        {
          error: {
            code: "validation",
            issues: e.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        },
        { status: 400 },
      );
    if (e instanceof Fault)
      return Response.json(
        { error: { code: e.code, message: e.message } },
        {
          status: e.status,
          headers: {
            "cache-control": "no-store",
            ...(e.status === 401 || e.code === "insufficient_scope"
              ? {
                  "www-authenticate": `Bearer resource_metadata="${context.resourceMetadata ?? new URL(request.url).origin + "/.well-known/oauth-protected-resource/mcp"}", scope="${e.code === "insufficient_scope" ? "openlaunch:read openlaunch:act" : "openlaunch:read"}"${e.code === "insufficient_scope" ? ', error="insufficient_scope"' : ""}`,
                }
              : {}),
          },
        },
      );
    return Response.json(
      { error: { code: "internal", message: "Internal error" } },
      { status: 500 },
    );
  }
}
