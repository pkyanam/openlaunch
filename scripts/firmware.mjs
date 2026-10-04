import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const provenance = Object.freeze({
  patch: "3968e6b85ce7a6c9afbe27ddd43f524907381108973f97ba27e2ac67ce6f2955",
  image: "b2ec3425bc189a69fd31baeee30766156d1ab6504f7b05f45c4c0f481281e216",
  "Modem.cpp":
    "2c2aa923ea176cf723932e55f5afedf9af25de4b7ba738595f068bc0b2caad26",
  "Modem.h": "e76dda2966be1d767caabcbbd2a60931c1e1aa3f9c6783cdab4a71cd1f32a548",
});
export const roombaLibraryCommit = "5120998789100c1aade14ebe0645524cae6f9349";
export function parseOptions(args) {
  const options = { profile: "stock" };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--prepare-only") options.prepareOnly = true;
    else if (key === "--acknowledge-installed-mux") options.acknowledged = true;
    else if (
      ["--profile", "--repair-dir", "--sketch", "--roomba-library"].includes(
        key,
      )
    ) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${key}`);
      const optionNames = {
        "--profile": "profile",
        "--repair-dir": "repairDir",
        "--sketch": "sketch",
        "--roomba-library": "roombaLibrary",
      };
      options[optionNames[key]] = args[++i];
    } else throw new Error(`Unknown firmware option: ${key}`);
  }
  if (!["stock", "console-mux"].includes(options.profile))
    throw new Error("Profile must be stock or console-mux");
  if (
    options.profile === "stock" &&
    (options.repairDir || options.acknowledged)
  )
    throw new Error("Repair options require console-mux");
  if (
    options.profile === "console-mux" &&
    (!options.repairDir || !options.acknowledged)
  )
    throw new Error(
      "console-mux requires --repair-dir and --acknowledge-installed-mux (matching ESP image must already be installed)",
    );
  if (
    options.sketch &&
    !["openlaunch", "openlaunch_roomba"].includes(options.sketch)
  )
    throw new Error("Sketch must be openlaunch or openlaunch_roomba");
  if (options.sketch === "openlaunch_roomba" && !options.roombaLibrary)
    throw new Error(
      "Roomba sketch requires --roomba-library at the pinned clean checkout",
    );
  if (options.roombaLibrary && options.sketch !== "openlaunch_roomba")
    throw new Error("--roomba-library requires --sketch openlaunch_roomba");
  return options;
}
export function verifyHash(path, expected) {
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !== expected
  )
    throw new Error(`Source integrity mismatch: ${path}`);
}
export function isolatedEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith("ARDUINO_")),
  );
}
export function isolatedConfig(root, data) {
  return {
    directories: {
      data,
      user: join(root, "build/arduino-dependencies"),
      downloads: join(root, "build/arduino-downloads"),
    },
  };
}
export function verifyResolution(result, library) {
  if (
    !result.success ||
    resolve(
      result.builder_result?.used_libraries?.find((l) => l.name === "WiFiS3")
        ?.install_dir ?? "/missing",
    ) !== resolve(library)
  )
    throw new Error("Compile did not resolve the selected WiFiS3 transport");
}
export function verifyRoombaResolution(result, expected) {
  if (
    !result.success ||
    realpathSync(
      result.builder_result?.used_libraries?.find(
        (l) => l.name === "ArduRoomba",
      )?.install_dir ?? "/missing",
    ) !== realpathSync(expected)
  )
    throw new Error("Compile did not resolve the pinned ArduRoomba checkout");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: isolatedEnvironment(process.env),
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? (result.stderr || result.stdout || result.status)}`,
    );
  return result.stdout?.trim() ?? "";
}
export function prepare(root, data, options) {
  const core = join(data, "packages/arduino/hardware/renesas_uno/1.6.0");
  for (const name of ["Modem.cpp", "Modem.h"])
    verifyHash(join(core, "libraries/WiFiS3/src", name), provenance[name]);
  // A private user directory excludes all globally installed libraries, including patched WiFiS3.
  const directory = join(
    root,
    "build/firmware",
    options.profile,
    ...(options.sketch === "openlaunch_roomba" ? ["openlaunch_roomba"] : []),
  );
  const dependencies = join(root, "build/arduino-dependencies");
  mkdirSync(dependencies, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const config = join(directory, "arduino-cli.json");
  writeFileSync(config, JSON.stringify(isolatedConfig(root, data), null, 2));
  let patch;
  if (options.profile === "console-mux") {
    patch = join(
      resolve(options.repairDir),
      "patches/wifis3-console-uart-transport.patch",
    );
    verifyHash(patch, provenance.patch);
    verifyHash(
      join(resolve(options.repairDir), "firmware/UNOR4-WIFI-S3-0.6.0-mux.bin"),
      provenance.image,
    );
  }
  const library = join(directory, "libraries/WiFiS3");
  cpSync(join(core, "libraries/WiFiS3"), library, { recursive: true });
  if (patch)
    run(
      "patch",
      [
        "--batch",
        "--forward",
        "--strip=2",
        "--directory",
        join(directory, "libraries"),
      ],
      { input: readFileSync(patch) },
    );
  let roombaLibrary;
  if (options.sketch === "openlaunch_roomba") {
    roombaLibrary = resolve(options.roombaLibrary);
    if (
      run("git", ["-C", roombaLibrary, "rev-parse", "HEAD"]) !==
        roombaLibraryCommit ||
      run("git", ["-C", roombaLibrary, "status", "--porcelain"])
    )
      throw new Error(
        "ArduRoomba must be a clean checkout at pinned revision " +
          roombaLibraryCommit,
      );
  }
  writeFileSync(
    join(directory, "provenance.json"),
    JSON.stringify(
      {
        profile: options.profile,
        sketch: options.sketch ?? "openlaunch",
        core: "arduino:renesas_uno@1.6.0",
        library,
        ...(roombaLibrary ? { roombaLibrary, roombaLibraryCommit } : {}),
        sources: provenance,
        installedImageAcknowledged: !!options.acknowledged,
      },
      null,
      2,
    ),
  );
  return {
    config,
    library,
    roombaLibrary,
    sketch: options.sketch ?? "openlaunch",
    directory,
  };
}
function main() {
  const options = parseOptions(process.argv.slice(2));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const data = run("arduino-cli", ["config", "get", "directories.data"]);
  const platforms = JSON.parse(
    run("arduino-cli", ["core", "list", "--format", "json"]),
  ).platforms;
  if (
    platforms.find((p) => p.id === "arduino:renesas_uno")?.installed_version !==
    "1.6.0"
  )
    throw new Error("Requires installed arduino:renesas_uno@1.6.0");
  const staged = prepare(root, data, options);
  console.log(
    `Firmware profile: ${options.profile}; explicit WiFiS3: ${staged.library}`,
  );
  if (options.prepareOnly) {
    console.log(
      `Prepared validated sources and isolated config: ${staged.config}`,
    );
    return;
  }
  const sketchDir = join(root, "firmware/uno-r4-wifi", staged.sketch);
  const buildPath = join(staged.directory, "compiled");
  mkdirSync(buildPath, { recursive: true });
  const compileArgs = [
    "--config-file",
    staged.config,
    "compile",
    "--format",
    "json",
    "--fqbn",
    "arduino:renesas_uno:unor4wifi",
    "--library",
    staged.library,
    ...(staged.roombaLibrary ? ["--library", staged.roombaLibrary] : []),
    "--build-path",
    buildPath,
    sketchDir,
  ];
  const output = run("arduino-cli", compileArgs, {
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(output);
  verifyResolution(result, staged.library);
  if (staged.roombaLibrary)
    verifyRoombaResolution(result, staged.roombaLibrary);
  writeFileSync(join(buildPath, "compile-result.json"), output);
  console.log(result.compiler_out);
  console.log(`Verified selected libraries; artifacts: ${buildPath}`);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
