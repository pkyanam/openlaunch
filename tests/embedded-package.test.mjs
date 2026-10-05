import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageScript = join(root, "scripts/package-embedded-sdk.mjs");
const canonicalCore = join(
  root,
  "packages/embedded-sdk/include/openlaunch/embedded.hpp",
);

function makeArchive(directory, name) {
  const output = join(directory, name);
  const result = spawnSync(
    process.execPath,
    [packageScript, "--output", output],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { output, metadata: JSON.parse(result.stdout.trim()) };
}

test("Arduino ZIP is sanitized, reproducible, and contains a standalone library", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "openlaunch-embedded-zip-test-"));
  try {
    const { output, metadata } = makeArchive(temp, "sdk-one.zip");
    const second = makeArchive(temp, "sdk-two.zip");
    const archiveHash = createHash("sha256")
      .update(readFileSync(output))
      .digest("hex");
    assert.equal(metadata.sha256, archiveHash);
    assert.equal(
      second.metadata.sha256,
      archiveHash,
      "same inputs produce byte-identical ZIPs",
    );

    const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.ok(entries.length > 0);
    assert.deepEqual(entries, [
      "openlaunch/LICENSE",
      "openlaunch/README.md",
      "openlaunch/examples/esp32_health/esp32_health.ino",
      "openlaunch/library.properties",
      "openlaunch/src/openlaunch.h",
      "openlaunch/src/openlaunch/embedded.hpp",
      "openlaunch/src/openlaunch/esp32.cpp",
      "openlaunch/src/openlaunch/esp32.h",
      "openlaunch/src/openlaunch/esp32.hpp",
    ]);
    assert.ok(entries.every((entry) => entry.startsWith("openlaunch/")));
    assert.ok(entries.includes("openlaunch/library.properties"));
    assert.ok(entries.includes("openlaunch/src/openlaunch/embedded.hpp"));
    assert.ok(entries.includes("openlaunch/src/openlaunch/esp32.hpp"));
    assert.ok(
      entries.includes("openlaunch/examples/esp32_health/esp32_health.ino"),
    );
    assert.ok(
      entries.every(
        (entry) => !/(secrets|build|repair|\.git|node_modules)/i.test(entry),
      ),
    );

    const extracted = join(temp, "extracted");
    execFileSync("unzip", ["-q", output, "-d", extracted]);
    const library = join(extracted, "openlaunch");
    assert.deepEqual(
      readFileSync(join(library, "LICENSE")),
      readFileSync(join(root, "LICENSE")),
      "archive includes the canonical MIT license",
    );
    assert.deepEqual(
      readFileSync(join(library, "src/openlaunch/embedded.hpp")),
      readFileSync(canonicalCore),
      "archive core header is generated from the canonical SDK source",
    );
    const adapter = readFileSync(
      join(library, "src/openlaunch/esp32.hpp"),
      "utf8",
    );
    assert.ok(adapter.includes('#include "embedded.hpp"'));
    assert.ok(!adapter.includes("../../../include/"));
    const example = readFileSync(
      join(library, "examples/esp32_health/esp32_health.ino"),
      "utf8",
    );
    assert.ok(example.includes("#include <openlaunch.h>"));

    const esp32Core =
      process.env.ARDUINO_ESP32_CORE ??
      join(homedir(), "Library/Arduino15/packages/esp32/hardware/esp32/3.3.11");
    const jsonLibrary = join(
      root,
      "build/arduino-dependencies/libraries/ArduinoJson",
    );
    const cli = spawnSync("arduino-cli", ["version"], { encoding: "utf8" });
    if (
      cli.status !== 0 ||
      !existsSync(esp32Core) ||
      !existsSync(jsonLibrary)
    ) {
      t.diagnostic(
        "Archive checks passed; ESP32 compile smoke needs the local toolchain and ArduinoJson",
      );
      return;
    }
    const buildPath = join(temp, "build");
    const compile = spawnSync(
      "arduino-cli",
      [
        "compile",
        "--fqbn",
        "esp32:esp32:esp32",
        "--library",
        library,
        "--library",
        jsonLibrary,
        "--build-path",
        buildPath,
        join(library, "examples/esp32_health"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    assert.match(compile.stdout, /Sketch uses/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
