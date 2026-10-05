import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "packages/embedded-sdk");
const defaultOutput = join(root, "build/embedded-sdk/openlaunch-esp32.zip");
const epoch = new Date("1980-01-01T00:00:00Z");
const sources = [
  ["../../LICENSE", "openlaunch/LICENSE", "copy"],
  ["arduino/src/openlaunch.h", "openlaunch/src/openlaunch.h", "copy"],
  ["arduino/library.properties", "openlaunch/library.properties", "copy"],
  [
    "arduino/src/openlaunch/esp32.h",
    "openlaunch/src/openlaunch/esp32.h",
    "copy",
  ],
  [
    "arduino/src/openlaunch/esp32.cpp",
    "openlaunch/src/openlaunch/esp32.cpp",
    "copy",
  ],
  [
    "arduino/src/openlaunch/esp32.hpp",
    "openlaunch/src/openlaunch/esp32.hpp",
    "adapter",
  ],
  [
    "include/openlaunch/embedded.hpp",
    "openlaunch/src/openlaunch/embedded.hpp",
    "copy",
  ],
  [
    "arduino/examples/esp32_health/esp32_health.ino",
    "openlaunch/examples/esp32_health/esp32_health.ino",
    "example",
  ],
  ["arduino/README.md", "openlaunch/README.md", "readme"],
].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

function parseOutput(args) {
  let output = defaultOutput;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--output" || !args[i + 1])
      throw new Error(
        "Usage: node scripts/package-embedded-sdk.mjs [--output FILE.zip]",
      );
    output = resolve(args[++i]);
  }
  if (!output.toLowerCase().endsWith(".zip"))
    throw new Error("Output filename must end in .zip");
  return output;
}

function rejectSymlinks(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error(`Refusing symlink in SDK source tree: ${path}`);
    if (info.isDirectory()) rejectSymlinks(path);
  }
}

function readSource(relativePath) {
  const path = join(sourceRoot, relativePath);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Expected regular file in SDK source allowlist: ${path}`);
  return readFileSync(path, "utf8");
}

function render(kind, input) {
  if (kind === "copy") return input;
  if (kind === "adapter") {
    const expected = '#include "../../../include/openlaunch/embedded.hpp"';
    if (!input.includes(expected))
      throw new Error(
        "Portable core include changed; update archive packaging explicitly",
      );
    return input.replace(expected, '#include "embedded.hpp"');
  }
  if (kind === "example") {
    if (!input.includes("#include <openlaunch.h>"))
      throw new Error(
        "Example include changed; update archive packaging explicitly",
      );
    return input;
  }
  if (kind === "readme") return input;
  throw new Error(`Unknown archive input transform: ${kind}`);
}

function packageArchive(output) {
  const scannedRoots = ["arduino", "include/openlaunch"].map((path) =>
    join(sourceRoot, path),
  );
  for (const directory of scannedRoots) rejectSymlinks(directory);
  const relativeOutput = relative(sourceRoot, output);
  if (
    relativeOutput &&
    !relativeOutput.startsWith(`..${sep}`) &&
    relativeOutput !== ".."
  )
    throw new Error(
      "Archive output must be outside the embedded SDK source tree",
    );

  const staging = mkdtempSync(join(tmpdir(), "openlaunch-embedded-package-"));
  try {
    const packageDir = join(staging, "openlaunch");
    mkdirSync(packageDir, { recursive: true });
    const filePaths = [];
    for (const [source, destination, kind] of sources) {
      const target = join(staging, destination);
      mkdirSync(dirname(target), { recursive: true });
      const content = render(kind, readSource(source));
      writeFileSync(target, content, { mode: 0o644 });
      chmodSync(target, 0o644);
      utimesSync(target, epoch, epoch);
      filePaths.push(destination);
    }

    mkdirSync(dirname(output), { recursive: true });
    rmSync(output, { force: true });
    execFileSync("zip", ["-X", "-q", "-9", output, ...filePaths], {
      cwd: staging,
    });
    const bytes = readFileSync(output);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { output, sha256, files: filePaths };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const output = parseOutput(process.argv.slice(2));
console.log(JSON.stringify(packageArchive(output)));
