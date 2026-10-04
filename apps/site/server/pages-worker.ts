import { createMcpFetchHandler } from "blume/ai/mcp/server.ts";
import data from "../dist/mcp-data.json";
const docs = createMcpFetchHandler(
  data as Parameters<typeof createMcpFetchHandler>[0],
);
export default {
  async fetch(
    request: Request,
    env: {
      ASSETS: { fetch(request: Request): Promise<Response> };
      BRIDGE?: { fetch(request: Request): Promise<Response> };
    },
  ) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/v1/") ||
      [
        "/mcp",
        "/healthz",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(url.pathname)
    ) {
      if (!env.BRIDGE)
        return Response.json(
          {
            error: {
              code: "setup_required",
              message: "Device service is unavailable",
            },
          },
          { status: 503 },
        );
      const headers = new Headers(request.headers);
      headers.delete("x-openlaunch-principal");
      return env.BRIDGE.fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/docs-mcp") return docs(request);
    if (
      request.headers.get("accept")?.includes("text/markdown") &&
      !url.pathname.split("/").at(-1)?.includes(".")
    ) {
      url.pathname =
        url.pathname === "/"
          ? "/index.md"
          : url.pathname.replace(/\/$/, "") + ".md";
      return env.ASSETS.fetch(
        new Request(url, { method: request.method, headers: request.headers }),
      );
    }
    return env.ASSETS.fetch(request);
  },
};
