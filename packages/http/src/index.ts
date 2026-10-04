import { z } from "zod";
import {
  Hub,
  Fault,
  deviceKind,
  capabilityName,
  type Principal,
} from "../../core/src/index.ts";
import { createMcp } from "../../mcp/src/index.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
const caps = capabilityName;
const bearer = (r: Request) =>
  /^Bearer ([^\s]+)$/.exec(r.headers.get("authorization") ?? "")?.[1] ?? "";
const json = (data: unknown, status = 200) =>
  Response.json(
    { data },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
const body = async (r: Request) => {
  const t = await r.text();
  if (t.length > 16384) throw new Fault("too_large", 413, "Request too large");
  try {
    return JSON.parse(t);
  } catch {
    throw new Fault("invalid_json", 400, "Invalid JSON");
  }
};
export async function handle(
  request: Request,
  hub: Hub,
  resolve: (r: Request) => Promise<Principal>,
  context: { workspace?: string } = {},
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
    if (path === "/v1/device/enroll" && method === "POST") {
      const b = z
        .object({ token: z.string().length(64), manifest: z.unknown() })
        .strict()
        .parse(await body(request));
      return json(await hub.enroll(b.token, b.manifest), 201);
    }
    const deviceRoute =
      /^\/v1\/device\/([a-f0-9-]{36})\/(next|result|manifest)$/.exec(path);
    if (deviceRoute) {
      const id = deviceRoute[1]!;
      await hub.authenticateDevice(id, bearer(request));
      if (deviceRoute[2] === "manifest" && method === "POST") {
        const b = z
          .object({ manifest: z.unknown() })
          .strict()
          .parse(await body(request));
        return json(hub.publishManifest(id, b.manifest));
      }
      if (deviceRoute[2] === "next" && method === "POST")
        return json(hub.next(id));
      if (deviceRoute[2] === "result" && method === "POST") {
        const b = z
          .object({
            actionId: z.string().uuid(),
            status: z.enum(["succeeded", "failed"]),
            result: z.unknown(),
          })
          .strict()
          .parse(await body(request));
        return json(hub.result(id, b.actionId, b.status, b.result));
      }
      throw new Fault("method", 405, "Method not allowed");
    }
    const token = bearer(request);
    const p = token.startsWith("ol_agent_")
      ? await hub.authenticateConnection(token, context.workspace ?? "")
      : await resolve(request);
    if (path === "/mcp") {
      if (method !== "POST")
        throw new Fault("method", 405, "Stateless MCP uses POST");
      const server = createMcp(hub, p);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, {
          parsedBody: await body(request),
        });
      } finally {
        await server.close();
      }
    }
    if (path === "/v1/devices" && method === "GET") return json(hub.list(p));
    if (path === "/v1/enrollments" && method === "POST") {
      const b = z
        .object({ kind: deviceKind })
        .strict()
        .parse(await body(request));
      return json(await hub.enrollment(p, b.kind), 201);
    }
    if (path === "/v1/agent-connections" && method === "GET")
      return json(hub.connections(p));
    if (path === "/v1/agent-connections" && method === "POST") {
      const b = z
        .object({
          name: z.string().min(1).max(64),
          ttlSeconds: z.number().int().min(60).max(2592000).default(86400),
          access: z.enum(["read", "act"]).default("act"),
        })
        .strict()
        .parse(await body(request));
      return json(
        await hub.createConnection(
          p,
          context.workspace ?? "",
          b.name,
          b.ttlSeconds,
          b.access,
        ),
        201,
      );
    }
    const connectionRevoke =
      /^\/v1\/agent-connections\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (connectionRevoke && method === "POST")
      return json(hub.revokeConnection(p, connectionRevoke[1]!));
    if (path === "/v1/grants" && method === "POST") {
      const b = z
        .object({
          principal: z.string().min(1).max(128),
          deviceId: z.string().uuid(),
          capabilities: z.array(caps).min(1).max(16),
          ttlSeconds: z.number().int().min(1).max(86400).default(3600),
        })
        .strict()
        .parse(await body(request));
      return json(
        hub.grant(p, b.principal, b.deviceId, b.capabilities, b.ttlSeconds),
      );
    }
    if (path === "/v1/grants/revoke" && method === "POST") {
      const b = z
        .object({ principal: z.string(), deviceId: z.string().uuid() })
        .strict()
        .parse(await body(request));
      return json(hub.revokeGrant(p, b.principal, b.deviceId));
    }
    if (path === "/v1/broadcasts" && method === "POST") {
      const b = z
        .object({
          deviceIds: z.array(z.string().uuid()).min(1).max(20),
          capability: caps,
          arguments: z.record(z.string(), z.unknown()),
          idempotencyKey: z.string().min(1).max(64),
          ttlSeconds: z.number().int().min(1).max(300).default(30),
        })
        .strict()
        .parse(await body(request));
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
      const b = z
        .object({
          capability: caps,
          arguments: z.record(z.string(), z.unknown()),
          idempotencyKey: z.string().min(1).max(128),
          ttlSeconds: z.number().int().min(1).max(300).default(30),
        })
        .strict()
        .parse(await body(request));
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
        { status: e.status, headers: { "cache-control": "no-store" } },
      );
    return Response.json(
      { error: { code: "internal", message: "Internal error" } },
      { status: 500 },
    );
  }
}
