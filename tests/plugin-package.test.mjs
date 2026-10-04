import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageScript = join(root, "scripts/package-plugin.mjs");
const packagePath = join(root, "apps/site/dist/client/downloads/openlaunch-plugin.zip");

test("site plugin archive contains the portable package root and no unrelated sources", () => {
  execFileSync(process.execPath, [packageScript], { cwd: root, stdio: "pipe" });
  const listing = execFileSync("unzip", ["-Z1", packagePath], { encoding: "utf8" });
  const files = new Set(listing.trim().split("\n"));
  for (const expected of [
    "plugin.json",
    "mcp.json",
    "README.md",
    "assets/icon.png",
    "skills/openlaunch-device-control/SKILL.md",
  ]) assert.ok(files.has(expected), `archive should contain ${expected}`);
  assert.ok([...files].every((path) => !path.startsWith("openlaunch/")), "archive should preserve plugin root layout");
  for (const excluded of ["node_modules/", "apps/", "scripts/", "package.json", ".env"]) {
    assert.ok(![...files].some((path) => path === excluded || path.startsWith(excluded)), `archive should exclude ${excluded}`);
  }
  const manifest = JSON.parse(execFileSync("unzip", ["-p", packagePath, "plugin.json"], { encoding: "utf8" }));
  assert.equal(manifest.name, "openlaunch");
  assert.equal(JSON.parse(readFileSync(join(root, "integrations/plugin/openlaunch/plugin.json"), "utf8")).name, "openlaunch");
});
