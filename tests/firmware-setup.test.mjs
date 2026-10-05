import test from "node:test";
import assert from "node:assert/strict";
import { setupFirmware } from "../scripts/setup-firmware.mjs";

function fixture(answers) {
  const calls = [];
  return {
    calls,
    options: {
      ask: async () => answers.shift(),
      directory: "/test/openlaunch",
      home: "/test/owner",
      exists: () => true,
      run(command, args, capture) {
        calls.push({ command, args });
        if (capture)
          return JSON.stringify({
            platforms: [
              { id: "arduino:renesas_uno", installed_version: "1.6.0" },
            ],
          });
        return "";
      },
    },
  };
}

test("guided mux Roomba build preserves explicit transport and isolated dependencies", async () => {
  const f = fixture(["2", "", "yes", "2"]);
  await setupFirmware(f.options);
  const builds = f.calls.filter((c) => c.args[0] === "scripts/firmware.mjs");
  assert.equal(builds.length, 2);
  assert(builds[0].args.includes("--prepare-only"));
  assert(!builds[1].args.includes("--prepare-only"));
  for (const { args } of builds) {
    assert(args.includes("console-mux"));
    assert(args.includes("/test/owner/Code/uno-r4-wifi-fix"));
    assert(args.includes("--acknowledge-installed-mux"));
    assert(args.includes("openlaunch_roomba"));
  }
  const install = f.calls.find((c) => c.args.includes("ArduinoBLE@2.1.0"));
  assert.equal(
    install.args[1],
    "/test/openlaunch/build/firmware/console-mux/openlaunch_roomba/arduino-cli.json",
  );
  assert(
    !f.calls.some((c) => c.args.includes("upload") || c.args.includes("flash")),
  );
  assert(
    f.calls
      .filter((c) => c.args.includes("core"))
      .every((c) => c.args.includes("list")),
  );
});

test("declining mux acknowledgment performs no installs, builds or hardware commands", async () => {
  const f = fixture(["2", "", "no"]);
  await assert.rejects(
    setupFirmware(f.options),
    /Confirm the installed firmware pair/,
  );
  assert.equal(f.calls.length, 0);
});

test("stock build never uses repair assets or Roomba library", async () => {
  const f = fixture(["1", "1"]);
  await setupFirmware(f.options);
  for (const c of f.calls) {
    assert(!c.args.includes("--repair-dir"));
    assert(!c.args.includes("--roomba-library"));
    assert(!c.args.includes("upload"));
  }
  assert(f.calls.at(-1).args.includes("stock"));
});
