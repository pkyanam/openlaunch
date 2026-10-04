import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseOptions,
  verifyHash,
  isolatedEnvironment,
  isolatedConfig,
  verifyResolution,
  verifyRoombaResolution,
  roombaLibraryCommit,
} from "../scripts/firmware.mjs";

test("successful compilation must resolve selected library, not a global override", () => {
  const result = {
    success: true,
    builder_result: {
      used_libraries: [{ name: "WiFiS3", install_dir: "/global/patched" }],
    },
  };
  assert.throws(() => verifyResolution(result, "/selected/stock"));
  result.builder_result.used_libraries[0].install_dir = "/selected/stock";
  verifyResolution(result, "/selected/stock");
  result.success = false;
  assert.throws(() => verifyResolution(result, "/selected/stock"));
});

test("global sketchbook and environment cannot override the private library directory", () => {
  const env = isolatedEnvironment({
    PATH: "/bin",
    ARDUINO_DIRECTORIES_USER: "/global/patched",
    ARDUINO_DIRECTORIES_DATA: "/wrong/core",
  });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(
    isolatedConfig("/checkout", "/installed/data").directories.user,
    "/checkout/build/arduino-dependencies",
  );
  assert.equal(
    isolatedConfig("/checkout", "/installed/data").directories.data,
    "/installed/data",
  );
});

test("Roomba sketch requires its clean pinned library and keeps separate resolution checks", () => {
  assert.throws(() => parseOptions(["--sketch", "openlaunch_roomba"]));
  assert.throws(() =>
    parseOptions(["--sketch", "arbitrary", "--roomba-library", "/tmp/lib"]),
  );
  assert.throws(() => parseOptions(["--roomba-library", "/tmp/lib"]));
  assert.deepEqual(
    parseOptions([
      "--profile",
      "stock",
      "--sketch",
      "openlaunch_roomba",
      "--roomba-library",
      "/tmp/ArduRoomba",
    ]),
    {
      profile: "stock",
      sketch: "openlaunch_roomba",
      roombaLibrary: "/tmp/ArduRoomba",
    },
  );
  assert.equal(roombaLibraryCommit, "5120998789100c1aade14ebe0645524cae6f9349");
  const directory = mkdtempSync(
    join(tmpdir(), "openlaunch-roomba-resolution-"),
  );
  const selected = join(directory, "selected");
  const alias = join(directory, "alias");
  mkdirSync(selected);
  symlinkSync(selected, alias);
  const result = {
    success: true,
    builder_result: {
      used_libraries: [
        { name: "WiFiS3", install_dir: "/selected/wifi" },
        { name: "ArduRoomba", install_dir: selected },
      ],
    },
  };
  verifyResolution(result, "/selected/wifi");
  try {
    verifyRoombaResolution(result, alias);
    assert.throws(() => verifyRoombaResolution(result, "/global/ArduRoomba"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stock is default and rejects accidental repair options", () => {
  assert.deepEqual(parseOptions([]), { profile: "stock" });
  assert.deepEqual(parseOptions(["--prepare-only"]), {
    profile: "stock",
    prepareOnly: true,
  });
  for (const args of [
    ["--repair-dir", "/local"],
    ["--acknowledge-installed-mux"],
    ["--profile", "automatic"],
    ["--profile"],
    ["--upload"],
  ])
    assert.throws(() => parseOptions(args));
});
test("mux requires explicit path and installed-image acknowledgement", () => {
  assert.throws(() =>
    parseOptions(["--prepare-only", "--profile", "console-mux"]),
  );
  assert.throws(() => parseOptions(["--profile", "console-mux"]));
  assert.throws(() =>
    parseOptions(["--profile", "console-mux", "--repair-dir", "/local"]),
  );
  assert.equal(
    parseOptions([
      "--profile",
      "console-mux",
      "--repair-dir",
      "/local",
      "--acknowledge-installed-mux",
    ]).profile,
    "console-mux",
  );
});
test("integrity checks reject changed or missing source", () => {
  const directory = mkdtempSync(join(tmpdir(), "openlaunch-profile-"));
  try {
    const path = join(directory, "source");
    writeFileSync(path, "original");
    const hash = createHash("sha256").update("original").digest("hex");
    verifyHash(path, hash);
    writeFileSync(path, "changed");
    assert.throws(() => verifyHash(path, hash), /integrity mismatch/);
    assert.throws(() => verifyHash(join(directory, "missing"), hash));
  } finally {
    rmSync(directory, { recursive: true });
  }
});
