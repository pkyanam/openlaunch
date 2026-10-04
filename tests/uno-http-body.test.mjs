import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "tests/host/uno/test_http_body_writer.cpp");

test("Uno JSON body streaming handles partial writes and stops on connection failure", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "openlaunch-uno-body-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const executable = join(temporary, "test-http-body-writer");
  const compiler = process.env.CXX || "c++";
  const compile = spawnSync(
    compiler,
    ["-std=c++11", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    compile.status,
    0,
    `Native JSON writer test compilation failed. Ensure a C++ compiler is installed.\n${compile.stderr || compile.error?.message || ""}`,
  );
  const run = spawnSync(executable, [], { cwd: root, encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `Native JSON writer test failed.\n${run.stderr || ""}`,
  );
});
