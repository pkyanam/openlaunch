import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
// Publish installers from this exact checkout alongside the website.
// GitHub remains a source/backup link, never the primary installer redirect.
for (const [source, destination] of [
  ["../../scripts/install.sh", "dist/client/install.sh"],
  ["../../scripts/provision-uno.py", "dist/client/downloads/provision-uno.py"],
]) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}
const origin =
  process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev";
// Bundle the shared console for the hosted route, with only its public Clerk key.
if (process.env.CLERK_PUBLISHABLE_KEY) {
  execFileSync(
    process.execPath,
    [
      "../../node_modules/vite/bin/vite.js",
      "build",
      "--base",
      "/console/",
      "--outDir",
      "../site/dist/client/console",
      "--emptyOutDir",
    ],
    {
      cwd: "../web",
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
      },
    },
  );
  cpSync("public/icon.svg", "dist/client/console/icon.svg");
}
// Blume's custom homepage is indexable but is omitted from its generated llms index.
const homepage = `## Website\n\n- [openlaunch home](${origin}/): Connect your agents to your hardware. Setup, hardware, source links and documentation.\n\n`;
const indexPath = "dist/client/llms.txt";
const index = readFileSync(indexPath, "utf8").replace(
  "## Docs\n",
  `${homepage}## Docs\n`,
);
writeFileSync(indexPath, index);
const homeMarkdown = readFileSync("pages/index.md", "utf8");
writeFileSync("dist/client/index.md", homeMarkdown);
writeFileSync("dist/client/index.mdx", homeMarkdown);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = Boolean(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
);
writeFileSync(
  "dist/client/deployment.json",
  JSON.stringify(
    {
      product: "openlaunch",
      commit,
      dirty,
      site: origin,
      builtAt: new Date().toISOString(),
      surface: "website-and-read-only-docs-mcp",
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "dist/client/_headers",
  (existsSync("dist/client/_headers")
    ? readFileSync("dist/client/_headers", "utf8")
    : "") +
    "\n/install.sh\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: public, max-age=0, must-revalidate\n/downloads/provision-uno.py\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: public, max-age=0, must-revalidate\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n",
);
// Blume 2.1.1's generated 404 ignores the custom Logo slot and omits raster dimensions.
const notFoundPath = "dist/client/404.html";
writeFileSync(
  notFoundPath,
  readFileSync(notFoundPath, "utf8").replace(
    /<img\b[^>]*src="\/icon\.png"[^>]*>/g,
    (tag) =>
      /\bwidth=/.test(tag)
        ? tag
        : tag.replace("<img", '<img width="1280" height="1280"'),
  ),
);

// Use Blume's own corpus and read-only MCP runtime in a Pages advanced-mode Worker.
const { scanProject } = await import("blume/core/project-graph.ts");
const { buildMcpData } = await import("blume/ai/mcp/data.ts");
const { build } = await import("esbuild");
const project = await scanProject(process.cwd(), { mode: "build" });
const corpus = await buildMcpData(project);
corpus.pages["/"] = homeMarkdown;
corpus.routes.push({
  route: "/",
  title: "openlaunch",
  description: "Connect your agents to your hardware",
  contentType: "page",
  indexable: true,
  lastModified: null,
  locale: "en",
  version: "",
});
corpus.documents.push({
  route: "/",
  title: "openlaunch",
  content: homeMarkdown,
  contentType: "page",
  locale: "en",
  version: "",
});
writeFileSync("dist/mcp-data.json", JSON.stringify(corpus));
await build({
  entryPoints: ["server/pages-worker.ts"],
  outfile: "dist/client/_worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
writeFileSync(
  "dist/client/_routes.json",
  JSON.stringify({
    version: 1,
    include: [
      "/docs-mcp",
      "/",
      "/docs",
      "/docs/*",
      "/v1/*",
      "/mcp",
      "/healthz",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/*",
    ],
    exclude: ["/docs/*.md", "/docs/*.mdx"],
  }),
);
