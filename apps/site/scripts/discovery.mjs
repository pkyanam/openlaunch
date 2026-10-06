import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { serverInfo } from "../../../packages/mcp/src/index.ts";

// Compose product discovery after Blume generates its independent docs surfaces.
// All artifacts come from this checkout; no accounts or device data are embedded.
export function publishDiscovery(root, origin) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const json = (path) => JSON.parse(read(path));
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const writeJson = (path, value) =>
    write(path, JSON.stringify(value, null, 2) + "\n");
  const declarationUrl = `${origin}/.well-known/integrations.json`;
  const basis = { via: "declared", source: declarationUrl };
  const none = { status: "none", basis };
  const bearer = {
    source: "http",
    in: "header",
    headerName: "Authorization",
    scheme: "Bearer",
  };
  const entry = (id, mechanics) => ({ use: [{ id, mechanics }], basis });
  const agentAuth = {
    status: "required",
    entries: [
      entry("openlaunch-agent-token", bearer),
      entry("openlaunch-oauth", { source: "well-known" }),
    ],
  };
  const grantNotes =
    "Credentials do not grant device access. The owner must separately grant each device function to this connection. openlaunch:read permits discovery and results; openlaunch:act is also required for commands. Queued receipts require checking the final action result.";
  const surfaces = [
    {
      slug: "openlaunch-api",
      name: "openlaunch device API",
      type: "http",
      url: origin,
      spec: `${origin}/openapi.json`,
      docs: `${origin}/docs/reference`,
      basis,
      auth: agentAuth,
      notes: `${grantNotes} The full OpenAPI contract also documents owner, setup and device endpoints; each operation declares its own credential purpose. Agent tokens cannot enroll devices or grant themselves access.`,
    },
    {
      slug: "openlaunch-mcp",
      name: "openlaunch device MCP",
      type: "mcp",
      url: `${origin}/mcp`,
      transports: ["streamable-http"],
      docs: `${origin}/docs/agents`,
      basis,
      auth: agentAuth,
      notes: `${grantNotes} Other MCP hosts may need an owner-registered OAuth client with exact callback URLs in Connections → OAuth clients; discovery does not bypass client admission.`,
    },
    {
      slug: "openlaunch-cli",
      name: "openlaunch ol CLI",
      type: "cli",
      command: "ol",
      docs: `${origin}/docs/cli`,
      basis,
      auth: {
        status: "required",
        entries: [
          entry("openlaunch-agent-token", {
            source: "cli",
            command: "ol login",
            env: ["OPENLAUNCH_AGENT_TOKEN"],
          }),
        ],
      },
      notes: `Install on macOS or Linux: curl -fsSL ${origin}/install-cli.sh | bash\nRequires Node 24+, npm, curl and Python 3. Installs ol in ~/.local/bin and adds it to PATH. Rerun to update. Run ol login and paste the agent API token into its hidden prompt. OAuth sessions and device setup tokens cannot log in to ol. ${grantNotes}`,
    },
    {
      slug: "openlaunch-docs-api",
      name: "openlaunch documentation API",
      type: "http",
      spec: `${origin}/docs-openapi.json`,
      docs: `${origin}/docs/resources`,
      basis,
      auth: none,
      notes:
        "Public read-only documentation, page JSON, Markdown and navigation. No device access.",
    },
    {
      slug: "openlaunch-docs-mcp",
      name: "openlaunch documentation MCP",
      type: "mcp",
      url: `${origin}/docs-mcp`,
      transports: ["streamable-http"],
      docs: `${origin}/docs/agents`,
      basis,
      auth: none,
      notes:
        "Public read-only documentation tools and page resources. No device access.",
    },
  ];
  writeJson(".well-known/integrations.json", {
    version: 3,
    summary:
      "openlaunch connects agents to granted hardware, Linux and Home Assistant functions through an HTTP API, MCP and ol CLI, with separate public documentation services.",
    credentials: {
      "openlaunch-agent-token": {
        type: "bearer",
        label: "openlaunch agent API token",
        generateUrl: `${origin}/console/#connections`,
        setup:
          "Sign in to the openlaunch console. In Connections → API, create an agent API connection with read or read/action access and copy its ol_agent_ token, shown once. In Devices → Access, separately grant this exact connection the required functions. Send Authorization: Bearer <token>. For ol, run ol login or supply OPENLAUNCH_AGENT_TOKEN from a secret store. Device setup tokens and device credentials cannot authenticate an agent.",
      },
      "openlaunch-oauth": {
        type: "oauth2",
        label: "openlaunch agent OAuth",
        generateUrl: `${origin}/console/#connections`,
        setup: `Connect an OAuth-capable MCP host to ${origin}/mcp. Discover the resource and authorization server using RFC 9728 metadata. Use PKCE S256 and request openlaunch:read; also request openlaunch:act for device commands. The authorization server supports client ID metadata documents. Hosts requiring a registered client can use Connections → OAuth clients to register their exact callback URLs, then complete sign-in and consent. In Devices → Access, separately grant that exact OAuth connection its functions. OAuth consent never creates device grants.`,
      },
    },
    surfaces,
  });

  // Retain Blume's docs schema and card at explicit alternate URLs.
  const docsContract = json("openapi.json");
  // Blume's Node runtime implements JSON search, but our Pages Worker serves
  // static docs JSON and live docs MCP. Do not advertise an unserved endpoint.
  delete docsContract.paths["/api/docs/search"];
  writeJson("docs-openapi.json", docsContract);
  write("openapi.json", read("device-api.json"));
  const docsCardPath = ".well-known/mcp/docs-server-card.json";
  write(docsCardPath, read(".well-known/mcp/server-card.json"));
  writeJson(".well-known/mcp/server-card.json", {
    name: "dev.openlaunch.www/openlaunch",
    title: "openlaunch",
    serverInfo,
    version: serverInfo.version,
    description:
      "Discover granted devices and functions, invoke those functions and follow action results. Device grants and OAuth scopes are checked on every request.",
    url: `${origin}/mcp`,
    transport: "streamable-http",
    transports: [{ type: "streamable-http", endpoint: `${origin}/mcp` }],
    remotes: [{ type: "streamable-http", url: `${origin}/mcp` }],
    authentication: {
      type: "oauth2",
      authorization_server: "https://clerk.openlaunch.dev",
    },
    capabilities: { tools: {} },
    websiteUrl: origin,
  });
  writeJson(".well-known/mcp.json", {
    servers: [
      {
        name: "openlaunch",
        transport: "streamable-http",
        url: `${origin}/mcp`,
      },
      {
        name: "openlaunch docs",
        transport: "streamable-http",
        url: `${origin}/docs-mcp`,
      },
    ],
  });
  const catalogUrl = `${origin}/.well-known/api-catalog`;
  // The docs schema contains full /api/docs and /{route}.md paths. Let clients
  // use its declared server origin, rather than overriding it with a prefix.
  const catalogSurfaces = surfaces
    .filter((s) => s.type !== "cli")
    .map((s) => ({ ...s, url: s.url ?? `${origin}/api/docs` }));
  writeJson(".well-known/api-catalog", {
    linkset: [
      {
        anchor: catalogUrl,
        item: catalogSurfaces.map((s) => ({ href: s.url })),
      },
      ...catalogSurfaces.map((s) => ({
        anchor: s.url,
        "service-desc": [
          {
            href:
              s.spec ??
              `${origin}/${s.slug === "openlaunch-mcp" ? ".well-known/mcp/server-card.json" : docsCardPath}`,
            type: "application/json",
          },
        ],
        "service-doc": [{ href: s.docs, type: "text/html" }],
      })),
    ],
  });

  const skillPath =
    ".well-known/agent-skills/openlaunch-device-control/SKILL.md";
  const skill = readFileSync(
    new URL(
      "../../../integrations/plugin/openlaunch/skills/openlaunch-device-control/SKILL.md",
      import.meta.url,
    ),
  );
  write(skillPath, skill);
  const skills = json(".well-known/agent-skills/index.json");
  // Hash after composition, including any future changes to generated docs skills.
  skills.skills.push({
    name: "openlaunch-device-control",
    type: "skill-md",
    url: `${origin}/${skillPath}`,
    description: skill.toString().match(/^description: (.+)$/m)[1],
    digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`,
  });
  writeJson(".well-known/agent-skills/index.json", skills);

  // Update generated docs pointers rather than changing their meaning in place.
  for (const path of [
    "agent-readability.json",
    ".well-known/ai-catalog.json",
    ".well-known/ard.json",
  ]) {
    const doc = json(path);
    const rewritten = JSON.parse(
      JSON.stringify(doc)
        .replaceAll(`${origin}/openapi.json`, `${origin}/docs-openapi.json`)
        .replaceAll(
          `${origin}/.well-known/mcp/server-card.json`,
          `${origin}/${docsCardPath}`,
        ),
    );
    if (rewritten.entries) {
      rewritten.entries.push(
        {
          displayName: "openlaunch device API",
          identifier: "urn:air:www.openlaunch.dev:api:devices",
          type: "application/vnd.oai.openapi+json",
          url: `${origin}/openapi.json`,
          description: grantNotes,
        },
        {
          displayName: "openlaunch device MCP",
          identifier: "urn:air:www.openlaunch.dev:mcp:devices",
          type: "application/mcp-server-card+json",
          url: `${origin}/.well-known/mcp/server-card.json`,
          description: grantNotes,
        },
        {
          displayName: "openlaunch device control",
          identifier:
            "urn:air:www.openlaunch.dev:skill:openlaunch-device-control",
          type: "application/agent-skills+md",
          url: `${origin}/${skillPath}`,
          description: skills.skills.at(-1).description,
        },
      );
    } else {
      delete rewritten.artifacts.api.search;
      rewritten.artifacts.deviceApi = {
        openapi: `${origin}/openapi.json`,
        url: origin,
      };
      rewritten.artifacts.deviceMcp = {
        discovery: `${origin}/.well-known/mcp/server-card.json`,
        url: `${origin}/mcp`,
      };
      rewritten.artifacts.integrations = declarationUrl;
    }
    writeJson(path, rewritten);
  }
  for (const path of ["llms.txt", "llms-full.txt"]) {
    const contents = read(path).replaceAll(
      `Described by the OpenAPI document at ${origin}/openapi.json`,
      `Described by the OpenAPI document at ${origin}/docs-openapi.json`,
    );
    write(
      path,
      `${contents}\n\n## Device integration surfaces\n\n- [Device HTTP API](${origin}/openapi.json): Canonical OpenAPI contract; agent, owner, setup and device credential purposes are distinct.\n- [Device MCP](${origin}/.well-known/mcp/server-card.json): Authenticated Streamable HTTP device control at ${origin}/mcp. OAuth openlaunch:read and openlaunch:act scopes do not create device grants.\n- [ol CLI](${origin}/docs/cli): Install with curl -fsSL ${origin}/install-cli.sh | bash; use ol login with a separate agent API token.\n- [Device-control skill](${origin}/${skillPath}): Inspect granted functions and verify final action results.\n- [Integration declaration](${declarationUrl}): Complete surface and credential inventory for integrations.sh.\n`,
    );
  }
  return `\n/.well-known/*\n  Cache-Control: public, max-age=3600\n/.well-known/api-catalog\n  Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"\n  Link: <${catalogUrl}>; rel="api-catalog"\n/openapi.json\n  Content-Type: application/json\n  Cache-Control: public, max-age=3600\n/docs-openapi.json\n  Content-Type: application/json\n  Cache-Control: public, max-age=3600\n`;
}
