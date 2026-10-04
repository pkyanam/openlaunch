import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const origin =
  process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev";
// Blume's custom homepage is indexable but is omitted from its generated llms index.
const homepage = `## Website\n\n- [openlaunch home](${origin}/): Connect your agents to your hardware. Setup, hardware, source links and developer alpha status.\n\n`;
const indexPath = "dist/llms.txt";
const index = readFileSync(indexPath, "utf8").replace(
  "## Docs\n",
  `${homepage}## Docs\n`,
);
writeFileSync(indexPath, index);
writeFileSync("dist/index.md", index);
writeFileSync("dist/index.mdx", index);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = Boolean(
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
);
writeFileSync(
  "dist/deployment.json",
  JSON.stringify(
    {
      product: "openlaunch",
      commit,
      dirty,
      site: origin,
      builtAt: new Date().toISOString(),
      surface: "static-website-only",
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "dist/_headers",
  readFileSync("dist/_headers", "utf8") +
    "\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n",
);
// Blume 2.1.1's generated 404 ignores the custom Logo slot and omits raster dimensions.
const notFoundPath = "dist/404.html";
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
