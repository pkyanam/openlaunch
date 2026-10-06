import { installerManifest } from "./installers.mjs";
import { publishDiscovery } from "./discovery.mjs";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
// Publish installers from this exact checkout alongside the website.
// GitHub remains a source/backup link, never the primary installer redirect.
for (const [source, destination] of [
  ["../../scripts/setup.sh", "dist/client/setup.sh"],
  ["../../scripts/install-cli.sh", "dist/client/install-cli.sh"],
  ["../../scripts/install-linux.sh", "dist/client/install-linux.sh"],
  ["../../scripts/setup.py", "dist/client/downloads/setup.py"],
  ["../../scripts/install.sh", "dist/client/install.sh"],
  ["../../scripts/setup-uno.sh", "dist/client/setup-uno.sh"],
  ["../../scripts/provision-uno.py", "dist/client/downloads/provision-uno.py"],
  [
    "../../scripts/provision-roomba.py",
    "dist/client/downloads/provision-roomba.py",
  ],
  [
    "../../scripts/provision-esp32.py",
    "dist/client/downloads/provision-esp32.py",
  ],
]) {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}
// Publish standalone Pi binaries alongside the site, with a checksum manifest.
const piArtifacts = {};
for (const architecture of ["arm64", "arm", "amd64"]) {
  const source = `../../dist/openlaunch-device-linux-${architecture}`;
  if (!existsSync(source))
    throw new Error(`Build Pi downloads first: npm run build:pi (${source})`);
  const destination = `dist/client/downloads/pi/openlaunch-device-linux-${architecture}`;
  const { mkdirSync } = await import("node:fs");
  mkdirSync("dist/client/downloads/pi", { recursive: true });
  cpSync(source, destination);
}
if (existsSync("../../scripts/install-pi.sh")) {
  cpSync("../../scripts/install-pi.sh", "dist/client/install-pi.sh");
  cpSync("../../scripts/install-pi.sh", "dist/client/downloads/pi/install.sh");
}
const origin =
  process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev";
execFileSync(process.execPath, ["../../scripts/package-plugin.mjs"], {
  stdio: "inherit",
});
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
        VITE_OPENLAUNCH_BUILD_COMMIT: commit,
      },
    },
  );
  cpSync("public/icon.svg", "dist/client/console/icon.svg");
}
// Linux host profile uses the same tested transport binary, under its own CLI name.
const linuxArtifacts = {};
const { mkdirSync } = await import("node:fs");
mkdirSync("dist/client/downloads/linux", { recursive: true });
for (const architecture of ["arm64", "arm", "amd64"]) {
  const name = `openlaunch-host-linux-${architecture}`;
  const source = `../../dist/openlaunch-device-linux-${architecture}`;
  cpSync(source, `dist/client/downloads/linux/${name}`);
  linuxArtifacts[`linux-${architecture}`] = {
    url: `${origin}/downloads/linux/${name}`,
    sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
  };
}
writeFileSync(
  "dist/client/downloads/linux/manifest.json",
  JSON.stringify(
    { version: commit.slice(0, 12), commit, artifacts: linuxArtifacts },
    null,
    2,
  ) + "\n",
);
// Blume's custom homepage is indexable but is omitted from its generated llms index.
const homepage = `## Website\n\n- [openlaunch home](${origin}/): Connect your agents to your hardware. Setup, hardware, source links and documentation.\n- [Pricing](${origin}/pricing): Free hosted use, planned Team and custom Enterprise inquiries.\n\n`;
const indexPath = "dist/client/llms.txt";
const index = readFileSync(indexPath, "utf8").replace(
  "## Docs\n",
  `${homepage}## Docs\n`,
);
writeFileSync(indexPath, index);
const homeMarkdown = readFileSync("pages/index.md", "utf8");
writeFileSync("dist/client/index.md", homeMarkdown);
writeFileSync("dist/client/index.mdx", homeMarkdown);
const pricingMarkdown = readFileSync("pages/pricing.md", "utf8");
writeFileSync("dist/client/pricing.md", pricingMarkdown);
writeFileSync("dist/client/pricing.mdx", pricingMarkdown);
const fullIndexPath = "dist/client/llms-full.txt";
const fullIndex = readFileSync(fullIndexPath, "utf8");
if (!fullIndex.includes(pricingMarkdown.trim()))
  writeFileSync(fullIndexPath, fullIndex + `\n\n${pricingMarkdown}`);
const sitemapPath = "dist/client/sitemap.xml";
if (existsSync(sitemapPath)) {
  const sitemap = readFileSync(sitemapPath, "utf8");
  if (!sitemap.includes(`${origin}/pricing`))
    writeFileSync(
      sitemapPath,
      sitemap.replace(
        "</urlset>",
        `<url><loc>${origin}/pricing</loc></url></urlset>`,
      ),
    );
}
// Pin GitHub backup links to the deployed commit, never the moving main branch.
const pinInstallerBackup = (text) => {
  for (const filename of [
    "install.sh",
    "install-pi.sh",
    "install-linux.sh",
    "provision-uno.py",
    "provision-esp32.py",
  ])
    text = text.replaceAll(
      `https://raw.githubusercontent.com/pkyanam/openlaunch/main/scripts/${filename}`,
      `https://raw.githubusercontent.com/pkyanam/openlaunch/${commit}/scripts/${filename}`,
    );
  // A distinct package URL prevents npm exec from reusing an older cached CLI.
  return text.replaceAll(
    /https:\/\/www\.openlaunch\.dev\/downloads\/openlaunch-sdk\.tgz(?!\?commit=)/g,
    `https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz?commit=${commit}`,
  );
};
function pinGeneratedLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) pinGeneratedLinks(path);
    else if (/\.(html|md|mdx|txt|json)$/.test(entry.name)) {
      const original = readFileSync(path, "utf8");
      let pinned = pinInstallerBackup(original);
      // Blume bases relative header links under /docs. These two surfaces live
      // at the site root; publish relative links so previews retain their host.
      if (entry.name.endsWith(".html"))
        pinned = pinned.replace(/<a\b[^>]*>/g, (tag) => {
          for (const route of ["/console/", "/changelog", "/pricing"]) {
            if (tag.includes(`href="https://www.openlaunch.dev${route}"`)) {
              tag = tag.replaceAll(
                `href="https://www.openlaunch.dev${route}"`,
                `href="${route}"`,
              );
              // These are same-site navigation, including in a local preview.
              tag = tag.replace(
                /\s+(?:target="_blank"|rel="noreferrer"|aria-describedby="blume-new-tab-hint")/g,
                "",
              );
            }
          }
          return tag.replaceAll('href="/docs/pricing"', 'href="/pricing"');
        });
      if (pinned !== original) writeFileSync(path, pinned);
    }
  }
}
pinGeneratedLinks("dist/client");
writeFileSync(
  "dist/client/downloads/installers.json",
  JSON.stringify(installerManifest("dist/client/downloads", origin), null, 2) +
    "\n",
);
for (const architecture of ["arm64", "arm", "amd64"]) {
  const name = `openlaunch-device-linux-${architecture}`;
  piArtifacts[`linux-${architecture}`] = {
    url: `${origin}/downloads/pi/${name}`,
    sha256: createHash("sha256")
      .update(readFileSync(`dist/client/downloads/pi/${name}`))
      .digest("hex"),
  };
}
writeFileSync(
  "dist/client/downloads/pi/manifest.json",
  JSON.stringify(
    { version: commit.slice(0, 12), commit, artifacts: piArtifacts },
    null,
    2,
  ) + "\n",
);
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
      surface: "website-docs-and-authenticated-console",
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
    "\n/*.sh\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: public, max-age=0, must-revalidate\n/downloads/*\n  Cache-Control: public, max-age=0, must-revalidate\n/downloads/*.py\n  Content-Type: text/plain; charset=utf-8\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n" +
    publishDiscovery("dist/client", origin),
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

// Blume 2.1.1's generated 404 also bypasses the Footer override. Reuse
// the rendered shared footer; its styling lives in the global theme sheet.
const sharedFooter = readFileSync("dist/client/index.html", "utf8").match(
  /<footer\b[\s\S]*?<\/footer>/,
)?.[0];
if (!sharedFooter) throw new Error("Shared site footer missing from homepage");
writeFileSync(
  notFoundPath,
  readFileSync(notFoundPath, "utf8").replace(
    /<footer\b[\s\S]*?<\/footer>/,
    sharedFooter,
  ),
);

// Use Blume's own corpus and read-only MCP runtime in a Pages advanced-mode Worker.
const { scanProject } = await import("blume/core/project-graph.ts");
const { buildMcpData } = await import("blume/ai/mcp/data.ts");
const { build } = await import("esbuild");
const project = await scanProject(process.cwd(), { mode: "build" });
const corpus = await buildMcpData(project);
corpus.pages["/pricing"] = pricingMarkdown;
corpus.routes.push({
  route: "/pricing",
  title: "Pricing",
  description: "Free, planned Team and custom Enterprise inquiries",
  contentType: "page",
  indexable: true,
  lastModified: null,
  locale: "en",
  version: "",
});
corpus.documents.push({
  route: "/pricing",
  title: "Pricing",
  content: pricingMarkdown,
  contentType: "page",
  locale: "en",
  version: "",
});
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
writeFileSync("dist/mcp-data.json", pinInstallerBackup(JSON.stringify(corpus)));
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
      "/pricing",
      "/",
      "/docs",
      "/docs/*",
      "/reference",
      "/reference/*",
      "/changelog",
      "/changelog/*",
      "/v1/*",
      "/mcp",
      "/healthz",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/*",
    ],
    exclude: [
      "/docs/*.md",
      "/docs/*.mdx",
      "/reference/*.md",
      "/reference/*.mdx",
      "/changelog/*.md",
      "/changelog/*.mdx",
    ],
  }),
);
