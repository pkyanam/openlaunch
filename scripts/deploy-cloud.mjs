import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY)
  throw new Error("Clerk deployment configuration is required");
const commit =
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(commit))
  throw new Error("Invalid deployment commit");
const directory = await mkdtemp(join(tmpdir(), "openlaunch-deploy-"));
try {
  const secrets = join(directory, "secrets.json");
  await writeFile(
    secrets,
    JSON.stringify({ CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY }),
    { mode: 0o600 },
  );
  const child = spawn(
    "npx",
    [
      "cf",
      "deploy",
      "--secrets-file",
      secrets,
      "--message",
      `openlaunch ${commit}`,
    ],
    {
      cwd: new URL("../apps/cloud/", import.meta.url),
      stdio: "inherit",
      env: {
        ...process.env,
        OPENLAUNCH_BUILD_COMMIT: commit,
        CF_SEND_TELEMETRY: "false",
      },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (code !== 0) throw new Error("Cloudflare bridge deployment failed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
