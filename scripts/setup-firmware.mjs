import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { isolatedEnvironment, roombaLibraryCommit } from "./firmware.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function execute(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: isolatedEnvironment(process.env),
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed. ${result.error?.message ?? result.stderr ?? "See output above."}`,
    );
  return result.stdout?.trim() ?? "";
}

// Injected prompts/commands let tests verify transport choices without touching hardware.
export async function setupFirmware({
  ask,
  run = execute,
  directory = root,
  home = homedir(),
  exists = existsSync,
  mkdir = mkdirSync,
}) {
  console.log(
    "Build the RA application only. This never uploads or updates either chip.",
  );
  const profileChoice = await ask(
    "Transport: 1 = stock ESP, 2 = already-installed console-mux ESP: ",
  );
  if (!["1", "2"].includes(profileChoice))
    throw new Error("Choose 1 or 2; the transport is never guessed.");
  const profile = profileChoice === "1" ? "stock" : "console-mux";
  const args = ["--profile", profile];
  if (profile === "console-mux") {
    const repair =
      (
        await ask(`Repair directory [${join(home, "Code/uno-r4-wifi-fix")}]: `)
      ).trim() || join(home, "Code/uno-r4-wifi-fix");
    if (
      (await ask(
        "Matching custom ESP mux image is already installed? Type yes: ",
      )) !== "yes"
    )
      throw new Error(
        "Confirm the installed firmware pair before building console-mux.",
      );
    args.push("--repair-dir", resolve(repair), "--acknowledge-installed-mux");
  }
  const sketchChoice = await ask(
    "Application: 1 = LED/matrix, 2 = ArduRoomba: ",
  );
  if (!["1", "2"].includes(sketchChoice)) throw new Error("Choose 1 or 2.");
  const sketch = sketchChoice === "2" ? "openlaunch_roomba" : "openlaunch";
  args.push("--sketch", sketch);
  const platforms = JSON.parse(
    run("arduino-cli", ["core", "list", "--format", "json"], true),
  ).platforms;
  if (
    platforms.find((p) => p.id === "arduino:renesas_uno")?.installed_version !==
    "1.6.0"
  ) {
    if (
      (await ask("Install the required Renesas core 1.6.0? Type yes: ")) !==
      "yes"
    )
      throw new Error("Pinned Renesas core 1.6.0 is required.");
    run("arduino-cli", ["core", "update-index"]);
    run("arduino-cli", ["core", "install", "arduino:renesas_uno@1.6.0"]);
  }
  if (sketch === "openlaunch_roomba") {
    const library = join(directory, ".cache/ArduRoomba", roombaLibraryCommit);
    if (!exists(library)) {
      mkdir(join(directory, ".cache/ArduRoomba"), { recursive: true });
      run("git", [
        "clone",
        "--no-checkout",
        "https://github.com/pkyanam/ArduRoomba.git",
        library,
      ]);
      run("git", ["-C", library, "checkout", "--detach", roombaLibraryCommit]);
    }
    args.push("--roomba-library", library);
  }
  run(process.execPath, ["scripts/firmware.mjs", "--prepare-only", ...args]);
  const staging = join(
    directory,
    "build/firmware",
    profile,
    ...(sketch === "openlaunch_roomba" ? [sketch] : []),
  );
  const config = join(staging, "arduino-cli.json");
  run("arduino-cli", ["--config-file", config, "lib", "update-index"]);
  run("arduino-cli", [
    "--config-file",
    config,
    "lib",
    "install",
    "ArduinoJson@7.4.3",
    "ArduinoHttpClient@0.6.2",
    "ArduinoGraphics@1.1.5",
    ...(sketch === "openlaunch_roomba" ? ["ArduinoBLE@2.1.0"] : []),
  ]);
  run(process.execPath, ["scripts/firmware.mjs", ...args]);
  console.log(
    `Built ${profile}/${sketch}. Artifacts: ${join(staging, "compiled")}`,
  );
  console.log(
    "Next: follow docs/UNO-R4-PROFILES.md to upload this RA artifact deliberately, then run npm run provision:" +
      (sketch === "openlaunch_roomba" ? "roomba" : "uno"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help")) {
    console.log(
      "npm run setup:firmware — choose transport and application, install pinned dependencies, compile. Never flashes.",
    );
  } else if (process.argv.length > 2 || !process.stdin.isTTY) {
    console.error(
      "Run npm run setup:firmware in an interactive terminal. Install Arduino CLI first.",
    );
    process.exitCode = 1;
  } else {
    const prompts = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await setupFirmware({
        ask: async (question) => (await prompts.question(question)).trim(),
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      prompts.close();
    }
  }
}
