import {
  MCP_SUPPORTED_VERSIONS,
  rpcError,
  usesPerRequestProtocol,
  validatePerRequestMcp,
} from "../../../packages/mcp/src/http-2026.ts";

// Blume owns documentation queries and resources. Keep its legacy handler and
// adapt the transport envelope without copying its search implementation.
export function compatibleDocsMcp(
  legacy: (r: Request) => Promise<Response>,
  info: { name: string; version: string },
) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      return new Response("Cross-origin request rejected", { status: 403 });
    if (["GET", "DELETE"].includes(request.method))
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (request.method !== "POST") return legacy(request);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            return rpcError(null, -32600, "Request too large", 413);
          }
          chunks.push(value);
        }
    } finally {
      reader?.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let message: any;
    try {
      message = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (!usesPerRequestProtocol(request, message))
      return legacy(new Request(request, { body: bytes }));
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return rpcError(
        message?.id,
        -32600,
        "Content-Type must be application/json",
        415,
      );
    const accept = (request.headers.get("accept") ?? "")
      .split(",")
      .map((part) => part.trim().split(";")[0]);
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    )
      return rpcError(
        message?.id,
        -32600,
        "Accept must include application/json and text/event-stream",
        406,
      );
    const validated = validatePerRequestMcp(request, message);
    if (validated instanceof Response) return validated;
    const complete = (result: Record<string, unknown>) =>
      Response.json(
        {
          jsonrpc: "2.0",
          id: validated.id,
          result: {
            ...result,
            ...([
              "server/discover",
              "tools/list",
              "resources/list",
              "resources/templates/list",
              "resources/read",
            ].includes(validated.method)
              ? { cacheScope: "public", ttlMs: 0 }
              : {}),
            resultType: "complete",
            _meta: { "io.modelcontextprotocol/serverInfo": info },
          },
        },
        { headers: { "cache-control": "no-store" } },
      );
    if (validated.method === "server/discover")
      return complete({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {}, resources: {} },
      });
    if (
      ![
        "ping",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "resources/templates/list",
      ].includes(validated.method)
    )
      return rpcError(validated.id, -32601, "Method not found", 404);
    if (validated.method === "resources/templates/list")
      return complete({ resourceTemplates: [] });
    if (
      validated.params.cursor !== undefined &&
      ["tools/list", "resources/list"].includes(validated.method)
    )
      return rpcError(
        validated.id,
        -32602,
        "This catalog has no continuation cursor",
      );
    const headers = new Headers(request.headers);
    headers.set("mcp-protocol-version", "2025-11-25");
    const response = await legacy(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...message,
          params: { ...validated.params, _meta: {} },
        }),
      }),
    );
    const payload = (await response.json()) as any;
    if (payload.error)
      return rpcError(
        validated.id,
        payload.error.code === -32002 ? -32602 : payload.error.code,
        payload.error.message,
        payload.error.code === -32601 ? 404 : 400,
      );
    return complete(payload.result);
  };
}
