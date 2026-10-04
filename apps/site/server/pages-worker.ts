import { createMcpFetchHandler } from "blume/ai/mcp/server.ts";
import data from "../dist/mcp-data.json";
const docs = createMcpFetchHandler(
  data as Parameters<typeof createMcpFetchHandler>[0],
);
export default {
  async fetch(
    request: Request,
    env: { ASSETS: { fetch(request: Request): Promise<Response> } },
  ) {
    const url = new URL(request.url);
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
