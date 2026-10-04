import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "apps/site/public/downloads/openlaunch-sdk.tgz");
const staging = mkdtempSync(join(tmpdir(), "openlaunch-sdk-"));
try {
  execFileSync("npm", ["run", "build", "--workspace", "@openlaunch/sdk"], {
    cwd: root,
    stdio: "inherit",
  });
  const [result] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--workspace",
        "@openlaunch/sdk",
        "--pack-destination",
        staging,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(join(staging, result.filename), destination);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
