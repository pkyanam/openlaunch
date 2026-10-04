import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const packageRoot = join(staging, "package");
  mkdirSync(packageRoot);
  cpSync(join(root, "packages/sdk/dist"), join(packageRoot, "dist"), {
    recursive: true,
  });
  const metadata = JSON.parse(
    readFileSync(join(root, "packages/sdk/package.json"), "utf8"),
  );
  metadata.version = `0.1.0-dev.g${commit.slice(0, 12)}`;
  delete metadata.scripts;
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify(metadata, null, 2),
  );
  writeFileSync(
    join(packageRoot, "README.md"),
    readFileSync(join(root, "packages/sdk/README.md"), "utf8").replaceAll(
      "https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz",
      `https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz?commit=${commit}`,
    ),
  );
  const [result] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", staging, "--json"],
      { cwd: packageRoot, encoding: "utf8" },
    ),
  );
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(join(staging, result.filename), destination);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
