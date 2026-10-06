import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
const root = new URL("../apps/site/dist/client/", import.meta.url);
const { default: worker } = await import(new URL("_worker.js", root));
const protocolSchema = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/mcp-2026/schema.json", import.meta.url),
    "utf8",
  ),
);
const schemaValidator = new Ajv2020({ strict: false, validateFormats: false });
schemaValidator.addSchema(protocolSchema, "mcp-2026");
let modernId = 0;
const modern = async (method, params, responseSchema) => {
  const request = new Request("https://www.openlaunch.dev/docs-mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(["tools/call", "resources/read"].includes(method)
        ? {
            "mcp-name": `=?base64?${Buffer.from(params.name ?? params.uri).toString("base64")}?=`,
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++modernId,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const response = await worker.fetch(request, {});
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const validate = schemaValidator.compile({
    $ref: `mcp-2026#/$defs/${responseSchema}`,
  });
  assert(validate(payload), JSON.stringify(validate.errors));
  return payload.result;
};
assert.deepEqual(
  (await modern("server/discover", {}, "DiscoverResultResponse")).capabilities,
  { tools: {}, resources: {} },
);
const modernTools = await modern("tools/list", {}, "ListToolsResultResponse");
assert(modernTools.tools.some((tool) => tool.name === "search_docs"));
assert(
  !(
    await modern(
      "tools/call",
      { name: "get_navigation", arguments: {} },
      "CallToolResultResponse",
    )
  ).isError,
);
const modernResources = await modern(
  "resources/list",
  {},
  "ListResourcesResultResponse",
);
const modernResource = await modern(
  "resources/read",
  { uri: modernResources.resources[0].uri },
  "ReadResourceResultResponse",
);
assert(modernResource.contents[0].text.length > 50);
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
const installerManifest = JSON.parse(
  await readFile(new URL("downloads/installers.json", root), "utf8"),
);
const deployment = JSON.parse(
  await readFile(new URL("deployment.json", root), "utf8"),
);
assert.equal(installerManifest.commit, deployment.commit);
assert.equal(
  new URL(installerManifest.sdk.url).searchParams.get("commit"),
  deployment.commit,
  "SDK setup URL must distinguish this deployment from npm's cached CLI",
);
for (const filename of [
  "setup.sh",
  "setup.py",
  "install-cli.sh",
  "install.sh",
  "install-pi.sh",
  "setup-uno.sh",
  "provision-uno.py",
  "provision-roomba.py",
  "provision-esp32.py",
]) {
  const path = filename.endsWith(".py") ? `downloads/${filename}` : filename;
  const original = await readFile(
    new URL(`../scripts/${filename}`, import.meta.url),
  );
  const hosted = await readFile(new URL(path, root));
  const metadata = installerManifest.installers.find(
    (installer) => new URL(installer.url).pathname === `/${path}`,
  );
  assert.deepEqual(hosted, original);
  assert.equal(
    metadata.sha256,
    createHash("sha256").update(hosted).digest("hex"),
  );
  assert(metadata.backup.includes(`/${deployment.commit}/scripts/${filename}`));
}
for (const field of ["embeddedSdk", "sdk"]) {
  const metadata = installerManifest[field];
  const bytes = await readFile(
    new URL("." + new URL(metadata.url).pathname, root),
  );
  assert.equal(
    metadata.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
}
const piManifest = JSON.parse(
  await readFile(new URL("downloads/pi/manifest.json", root), "utf8"),
);
assert.equal(piManifest.commit, deployment.commit);
for (const artifact of Object.values(piManifest.artifacts)) {
  const bytes = await readFile(
    new URL("." + new URL(artifact.url).pathname, root),
  );
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
}
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
  assert(pages.some((x) => x.route === "/docs/cli"));
  assert(pages.some((x) => x.route === "/docs/reference"));
  const actionReference = pages.find(
    (x) =>
      x.route === "/docs/reference/agent/post-v1-devices-device-id-actions",
  );
  assert(
    actionReference,
    "action endpoint must be discoverable through documentation MCP",
  );
  const actionPage = await client.callTool({
    name: "get_page",
    arguments: { route: actionReference.route },
  });
  assert(
    actionPage.content[0].text.includes("ol call"),
    "operation Markdown must include CLI examples",
  );
  assert(
    actionPage.content[0].text.includes("requestAction"),
    "operation Markdown must include SDK examples",
  );
  const contract = JSON.parse(
    await readFile(new URL("device-api.json", root), "utf8"),
  );
  assert.equal(contract.servers[0].url, "https://www.openlaunch.dev");
  assert(contract.paths["/v1/functions"].get);
  assert(contract.paths["/v1/device/{deviceId}/result"].post);
  const cliMarkdown = await readFile(new URL("docs/cli.md", root), "utf8");
  assert(cliMarkdown.includes("install-cli.sh"));
  assert(
    !cliMarkdown.includes("{{cli-install}}"),
    "content variables must resolve for agents",
  );
  await access(new URL("changelog/rss.xml", root));
  const referenceHtml = await readFile(
    new URL(actionReference.route.slice(1) + "/index.html", root),
    "utf8",
  );
  assert(
    referenceHtml.includes('href="/console/"'),
    "global console link must retain the current site's host",
  );
  assert(!referenceHtml.includes('href="/docs/console/"'));
  for (const page of pages) {
    const path = page.route === "/" ? "index.md" : page.route.slice(1) + ".md";
    await access(fileURLToPath(new URL(path, root)));
    const htmlPath =
      page.route === "/" ? "index.html" : page.route.slice(1) + "/index.html";
    const pageHtml = await readFile(new URL(htmlPath, root), "utf8");
    assert.equal(
      (pageHtml.match(/<footer(?:\s|>)/g) ?? []).length,
      1,
      `${page.route}: render exactly one footer`,
    );
    assert(
      pageHtml.includes("data-openlaunch-footer"),
      `${page.route}: use the shared footer`,
    );
    const result = await client.callTool({
      name: "get_page",
      arguments: { route: page.route },
    });
    assert(!result.isError, page.route);
    assert(result.content[0].text.length > 50, page.route);
  }
  const notFoundHtml = await readFile(new URL("404.html", root), "utf8");
  assert.equal((notFoundHtml.match(/<footer(?:\s|>)/g) ?? []).length, 1);
  assert(notFoundHtml.includes("data-openlaunch-footer"));
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
  assert.equal(controls.status, 503);
  let forwarded;
  const protectedResponse = await worker.fetch(
    new Request("https://www.openlaunch.dev/v1/account", {
      headers: {
        authorization: "Bearer fixture",
        "x-openlaunch-principal": "forged",
      },
    }),
    {
      ASSETS: assets,
      BRIDGE: {
        fetch: async (request) => {
          forwarded = request;
          return Response.json(
            { error: { code: "unauthorized" } },
            { status: 401 },
          );
        },
      },
    },
  );
  assert.equal(protectedResponse.status, 401);
  assert.equal(forwarded.headers.get("x-openlaunch-principal"), null);
  assert.equal(forwarded.headers.get("authorization"), "Bearer fixture");
  assert.equal(new URL(forwarded.url).pathname, "/v1/account");
  console.log(
    `PASS: Blume MCP discovery, ${pages.length} Markdown pages, search, navigation, content negotiation and separation from device controls`,
  );
} finally {
  await client.close();
}
