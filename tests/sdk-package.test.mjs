import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hosted SDK archive installs offline with a commit version and working CLI", () => {
  const temporary = mkdtempSync(
    join(tmpdir(), "openlaunch-package-acceptance-"),
  );
  try {
    execFileSync(process.execPath, ["scripts/package-sdk.mjs"], {
      stdio: "pipe",
    });
    const archive = join(
      process.cwd(),
      "apps/site/public/downloads/openlaunch-sdk.tgz",
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        temporary,
        archive,
      ],
      { stdio: "pipe" },
    );
    const manifest = JSON.parse(
      readFileSync(
        join(temporary, "node_modules/@openlaunch/sdk/package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.version, `0.1.0-dev.g${commit.slice(0, 12)}`);
    const readme = readFileSync(
      join(temporary, "node_modules/@openlaunch/sdk/README.md"),
      "utf8",
    );
    assert(readme.includes(`openlaunch-sdk.tgz?commit=${commit}`));
    const help = execFileSync(
      process.execPath,
      [join(temporary, "node_modules/.bin/openlaunch-device"), "--help"],
      { encoding: "utf8" },
    );
    assert.match(help, /openlaunch-device setup/);
    assert.match(help, /openlaunch-device publish/);
    writeFileSync(
      join(temporary, "consumer.mts"),
      `import { createClient, createDevice, type DeviceManifest } from "@openlaunch/sdk";
const manifest: DeviceManifest = {name: "consumer", kind: "custom.device", capabilities: ["device.health"]};
const agent = createClient({url: "https://www.openlaunch.dev", token: "test-only"});
const device = createDevice({url: "https://www.openlaunch.dev", token: "ol_sdk_" + "a".repeat(64) + "_" + "b".repeat(64)});
async function check() {const action = await agent.requestAction("id", {capability: "device.health", idempotencyKey: "key"}); await agent.getAction(action.id); await device.attach(manifest, crypto.randomUUID());}
void check;
`,
    );
    writeFileSync(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
        },
        files: ["consumer.mts"],
      }),
    );
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules/typescript/bin/tsc"),
        "--project",
        join(temporary, "tsconfig.json"),
      ],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
