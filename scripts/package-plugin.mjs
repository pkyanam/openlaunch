import { createHash } from "node:crypto";
import { readdirSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repositoryRoot, "integrations/plugin/openlaunch");
const output = resolve(repositoryRoot, process.argv[2] ?? "apps/site/dist/client/downloads/openlaunch-plugin.zip");

function rejectSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin package cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) rejectSymlinks(path);
  }
}

rejectSymlinks(pluginRoot);
mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
execFileSync("zip", ["-X", "-r", output, "."], { cwd: pluginRoot, stdio: "inherit" });

const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
console.log(`Created ${output} (sha256 ${sha256})`);
