import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const root = new URL("../apps/site/dist/client/", import.meta.url);
const { default: worker } = await import(new URL("_worker.js", root));
const assets = {
  async fetch(request) {
    try {
      return new Response(
        await readFile(new URL("." + new URL(request.url).pathname, root)),
      );
    } catch {
      return new Response("missing", { status: 404 });
    }
  },
};
const client = new Client({
  name: "openlaunch-docs-acceptance",
  version: "1.0",
});
await client.connect(
  new StreamableHTTPClientTransport(
    new URL("https://www.openlaunch.dev/docs-mcp"),
    {
      fetch: (input, init) =>
        worker.fetch(new Request(input, init), { ASSETS: assets }),
    },
  ),
);
try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "get_navigation",
    "get_page",
    "list_pages",
    "search_docs",
  ]);
  const list = await client.callTool({ name: "list_pages", arguments: {} });
  assert.equal(list.isError, undefined);
  const pages = JSON.parse(list.content[0].text);
  assert(pages.some((x) => x.route === "/"));
  assert(pages.some((x) => x.route === "/docs/agents"));
  for (const page of pages) {
    const path = page.route === "/" ? "index.md" : page.route.slice(1) + ".md";
    await access(fileURLToPath(new URL(path, root)));
    const result = await client.callTool({
      name: "get_page",
      arguments: { route: page.route },
    });
    assert(!result.isError, page.route);
    assert(result.content[0].text.length > 50, page.route);
  }
  const results = await client.callTool({
    name: "search_docs",
    arguments: { query: "enrollment" },
  });
  assert(!results.isError);
  assert(results.content[0].text.includes("pairing"));
  const navigation = await client.callTool({
    name: "get_navigation",
    arguments: {},
  });
  assert(!navigation.isError);
  const markdown = await worker.fetch(
    new Request("https://www.openlaunch.dev/", {
      headers: { accept: "text/markdown" },
    }),
    { ASSETS: assets },
  );
  assert((await markdown.text()).startsWith("# openlaunch"));
  const controls = await worker.fetch(
    new Request("https://www.openlaunch.dev/mcp"),
    { ASSETS: assets },
  );
  assert.equal(controls.status, 404);
  console.log(
    `PASS: Blume MCP discovery, ${pages.length} Markdown pages, search, navigation, content negotiation and separation from device controls`,
  );
} finally {
  await client.close();
}
