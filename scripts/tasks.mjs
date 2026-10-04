import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  if (result.error || result.status !== 0) {
    console.error(
      `${command} failed: ${result.error?.message ?? result.status}`,
    );
    process.exit(result.status || 1);
  }
}
const npm = (...args) => run("npm", ["run", ...args]);
const go = (args, env = {}) =>
  run("go", args, {
    cwd: `${root}/devices/pi`,
    env: { ...process.env, ...env },
  });
function host() {
  mkdirSync(`${root}/dist`, { recursive: true });
  go([
    "build",
    "-trimpath",
    "-o",
    "../../dist/openlaunch-device-host",
    "./cmd/openlaunch-device",
  ]);
}
function pi() {
  mkdirSync(`${root}/dist`, { recursive: true });
  for (const arch of ["arm64", "arm"])
    go(
      [
        "build",
        "-trimpath",
        "-o",
        `../../dist/openlaunch-device-linux-${arch}`,
        "./cmd/openlaunch-device",
      ],
      { GOOS: "linux", GOARCH: arch, GOARM: "7", CGO_ENABLED: "0" },
    );
}
function build() {
  npm("build", "--workspace", "@openlaunch/site");
  npm("build", "--workspace", "@openlaunch/web");
  npm("build", "--workspace", "@openlaunch/cloud");
  host();
  pi();
}
function firmware() {
  run(process.execPath, ["scripts/firmware.mjs", ...process.argv.slice(3)]);
}
const command = process.argv[2];
if (command === "doctor") {
  let failures = 0;
  for (const [cmd, args] of [
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["go", ["version"]],
    ["arduino-cli", ["version"]],
    ["python3", ["--version"]],
  ]) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    console.log(
      `${cmd}: ${r.error ? "MISSING" : (r.stdout || r.stderr).trim()}`,
    );
    if (r.error || r.status !== 0) failures++;
  }
  console.log(
    "Required: Node 24+, Go matching devices/pi/go.mod, Arduino CLI plus pinned core/libraries in docs/MAC-HANDOFF.md. No login or credentials inspected.",
  );
  process.exitCode = failures ? 1 : 0;
} else if (command === "build") build();
else if (command === "pi") pi();
else if (command === "firmware") firmware();
else if (command === "device-test") go(["test", "./..."]);
else if (command === "e2e") {
  host();
  run(process.execPath, ["scripts/e2e.mjs"]);
} else if (command === "verify") {
  npm("check");
  run("python3", ["tests/provision-uno.test.py"]);
  go(["test", "./..."]);
  build();
  firmware();
  run(process.execPath, ["scripts/e2e.mjs"]);
} else {
  console.error("Use doctor, build, pi, firmware, device-test, e2e or verify");
  process.exitCode = 1;
}
