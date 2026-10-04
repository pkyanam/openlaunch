import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("portable embedded SDK compiles and passes native protocol scenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "openlaunch-embedded-"));
  try {
    const binary = join(dir, "embedded-sdk-test");
    const compile = spawnSync(
      process.env.CXX ?? "c++",
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        "-I",
        join(root, "packages/embedded-sdk/include"),
        join(root, "tests/embedded-sdk.cpp"),
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /embedded-sdk core checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
