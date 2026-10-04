import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "tests/host/uno/test_result_journal.cpp");

test("native Uno result journal survives failures and rejects corrupt records", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "openlaunch-uno-journal-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const executable = join(temporary, "test-result-journal");
  const compiler = process.env.CXX || "c++";
  const compile = spawnSync(
    compiler,
    ["-std=c++11", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    compile.status,
    0,
    `Native journal test compilation failed. Ensure a C++ compiler is installed.\n${compile.stderr || compile.error?.message || ""}`,
  );
  const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `Native journal test failed.\n${run.stderr || ""}`,
  );
});
