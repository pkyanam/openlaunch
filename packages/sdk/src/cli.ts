#!/usr/bin/env node
/// <reference types="node" />
/** One-command pairing and outbound polling runner for custom device adapters. */
import {
  createDevice,
  OpenLaunchError,
  sdkTokenWorkspace,
  type DeviceEventSocketFactory,
  type Action,
  type DeviceManifest,
} from "./index.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  link,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

const DEFAULT_URL = "https://www.openlaunch.dev";
const DEFAULT_MANIFEST: DeviceManifest = {
  name: "custom device adapter",
  kind: "custom.device",
  capabilities: ["device.health"],
};
const POLL_MS = 10_000;
const MAX_JOURNAL_ENTRIES = 5_000;

type StoredOutcome = { status: "succeeded" | "failed"; result: unknown };
type JournalEntry = {
  state: "pending" | "completed";
  expiresAt: number;
  acknowledged: boolean;
  recoveryRequired?: boolean;
  outcome?: StoredOutcome;
  terminal?: "expired" | `http_${number}`;
};
type ActionJournal = Record<string, JournalEntry>;

export function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--url must be an absolute HTTPS origin");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  )
    throw new Error(
      "--url must be a bare HTTPS origin (HTTP is allowed for localhost)",
    );
  return parsed.origin;
}

type SetupOptions = {
  directory?: string;
  name?: string;
  url?: string;
  workspace?: string;
  sdkToken?: string;
  enrollmentToken?: string;
  noStart?: boolean;
  enrollOnly?: boolean;
  fetch?: typeof fetch;
  events?: boolean;
  webSocketFactory?: DeviceEventSocketFactory;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};
type Identity = {
  url: string;
  workspace: string;
  deviceId: string;
  credential: string;
  manifest: DeviceManifest;
};
type PendingSetup = {
  version: 1;
  mode: "sdk";
  url: string;
  workspace: string;
  requestId: string;
  manifest: DeviceManifest;
};
type AdapterModule = {
  manifest?: DeviceManifest;
  handlers?: Record<string, (args: Record<string, unknown>) => unknown>;
};

async function askLine(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function askSecret(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  environmentName = "OPENLAUNCH_SDK_TOKEN",
): Promise<string> {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      `Set ${environmentName} when running without an interactive terminal`,
    );
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      output.write("\n");
      error ? reject(error) : resolveSecret(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return finish(new Error("Setup cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u007f") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function createScaffold(
  directory: string,
  manifest: DeviceManifest,
  resume = false,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {
    ".gitignore":
      "identity.json\n.identity.*.tmp\n.actions.json\n.actions.*.tmp\n.setup-pending.json\n.setup-pending.*.tmp\n",
    "adapter.mjs": `// Connect your board or service here. Only capabilities in manifest are exposed to agents.\nexport const manifest = ${JSON.stringify(manifest, null, 2)};\nexport const handlers = {\n  "device.health": async () => ({ status: "adapter_online" }),\n};\n`,
    "README.md": `# openlaunch custom device adapter\n\nThis folder contains your adapter and its private device identity. Keep identity.json private. The generated .gitignore excludes it from Git.\n\nThe starter advertises only device.health. That result means this adapter process is online; it does not claim that physical hardware was detected. To add operations, edit manifest and handlers in adapter.mjs, then run \`openlaunch-device publish --directory .\`. Publishing a changed manifest revokes existing grants; choose the capabilities to grant in the openlaunch console.\n\nRun with Node.js 22 or newer:\n\n\`\`\`sh\nopenlaunch-device run --directory .\n\`\`\`\n`,
  };
  for (const name of [...Object.keys(files), "identity.json"]) {
    if (resume && name !== "identity.json" && Object.hasOwn(files, name)) {
      try {
        const existing = await readFile(join(directory, name), "utf8");
        if (existing !== files[name])
          throw new Error(
            `Refusing to replace changed setup file ${join(directory, name)}`,
          );
        continue;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Refusing to replace changed setup file")
        )
          throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      await access(join(directory, name));
      throw new Error(`Refusing to overwrite ${join(directory, name)}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Refusing to overwrite ")
      )
        throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [name, contents] of Object.entries(files)) {
    if (resume) {
      try {
        await access(join(directory, name));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const handle = await open(join(directory, name), "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error(`Refusing to overwrite ${join(directory, name)}`);
        throw error;
      },
    );
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  }
  // Avoid changing permissions on a directory the user already owned.
}

async function writePendingSetup(path: string, pending: PendingSetup) {
  const directory = resolve(path, "..");
  const tempPath = join(
    directory,
    `.setup-pending.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const file = await open(tempPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(pending, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    // link() creates the destination without replacing an existing file.
    await link(tempPath, path);
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readPendingSetup(path: string): Promise<PendingSetup | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Refusing to read a non-regular pending setup file");
  const pending = JSON.parse(await readFile(path, "utf8")) as PendingSetup;
  if (
    pending?.version !== 1 ||
    pending.mode !== "sdk" ||
    typeof pending.url !== "string" ||
    typeof pending.workspace !== "string" ||
    !/^[a-f0-9]{64}$/.test(pending.workspace) ||
    typeof pending.requestId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(pending.requestId) ||
    !pending.manifest ||
    typeof pending.manifest !== "object"
  )
    throw new Error("Invalid pending setup record; refusing to continue");
  return pending;
}

export async function setupDevice(options: SetupOptions = {}) {
  const output = options.output ?? stdout;
  const input = options.input ?? stdin;
  const directory = resolve(options.directory ?? "openlaunch-device");
  const url = normalizeOrigin(
    options.url ?? process.env.OPENLAUNCH_URL ?? DEFAULT_URL,
  );
  const sdkToken =
    options.sdkToken ??
    process.env.OPENLAUNCH_SDK_TOKEN ??
    (options.enrollmentToken || process.env.OPENLAUNCH_ENROLLMENT_TOKEN
      ? undefined
      : await askSecret("SDK token (hidden): ", input, output));
  const enrollmentToken =
    options.enrollmentToken ?? process.env.OPENLAUNCH_ENROLLMENT_TOKEN;
  if (sdkToken && enrollmentToken)
    throw new Error(
      "Choose either OPENLAUNCH_SDK_TOKEN or the legacy enrollment token",
    );

  let workspace: string;
  let manifest: DeviceManifest;
  let enrolled: { deviceId: string; token: string };
  let pendingPath: string | undefined;
  if (sdkToken) {
    workspace = sdkTokenWorkspace(sdkToken) ?? "";
    if (!workspace || !sdkToken.startsWith("ol_sdk_"))
      throw new Error("Use an owner-issued ol_sdk_ token; agent tokens cannot pair devices");
    if (options.workspace && options.workspace !== workspace)
      throw new Error("Workspace ID does not match the SDK token");
    pendingPath = join(directory, ".setup-pending.json");
    const pending = await readPendingSetup(pendingPath);
    if (pending) {
      if (pending.url !== url || pending.workspace !== workspace)
        throw new Error(
          "Pending setup belongs to a different URL or workspace",
        );
      if (options.name?.trim() && options.name.trim() !== pending.manifest.name)
        throw new Error(
          "Pending setup has a different device name; finish or remove that setup first",
        );
      manifest = pending.manifest;
      await createScaffold(directory, manifest, true);
      const device = createDevice({
        url,
        token: sdkToken,
        fetch: options.fetch,
      });
      enrolled = await device.attach(manifest, pending.requestId);
    } else {
      manifest = {
        ...DEFAULT_MANIFEST,
        name: options.name?.trim() || DEFAULT_MANIFEST.name,
      };
      await createScaffold(directory, manifest);
      const nextPending: PendingSetup = {
        version: 1,
        mode: "sdk",
        url,
        workspace,
        requestId: randomUUID(),
        manifest,
      };
      await writePendingSetup(pendingPath, nextPending);
      const device = createDevice({
        url,
        token: sdkToken,
        fetch: options.fetch,
      });
      enrolled = await device.attach(manifest, nextPending.requestId);
    }
  } else {
    const token =
      enrollmentToken ??
      (await askSecret(
        "One-use enrollment token (hidden): ",
        input,
        output,
        "OPENLAUNCH_ENROLLMENT_TOKEN",
      ));
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Enrollment token must be 64 hexadecimal characters");
    workspace =
      options.workspace ??
      process.env.OPENLAUNCH_WORKSPACE ??
      (await askLine("Workspace ID: ", input, output));
    if (!/^[a-f0-9]{64}$/.test(workspace))
      throw new Error(
        "Workspace ID must be the 64-character value from the openlaunch console",
      );
    manifest = {
      ...DEFAULT_MANIFEST,
      name: options.name?.trim() || DEFAULT_MANIFEST.name,
    };
    await createScaffold(directory, manifest);
    const device = createDevice({ url, workspace, fetch: options.fetch });
    enrolled = await device.enroll({ token, manifest });
  }
  const identity: Identity = {
    url,
    workspace,
    deviceId: enrolled.deviceId,
    credential: enrolled.token,
    manifest,
  };
  const identityPath = join(directory, "identity.json");
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(identityPath, 0o600);
  if (pendingPath) await rm(pendingPath, { force: true });
  if (options.enrollOnly || options.noStart) {
    output.write(
      `Paired ${manifest.name} (${enrolled.deviceId}). Run openlaunch-device run --directory ${directory} to start the adapter.\n`,
    );
    return { directory, enrolled: true, deviceId: enrolled.deviceId };
  }
  output.write(
    `Paired ${manifest.name} (${enrolled.deviceId}). Starting the adapter; press Ctrl-C to stop.\n`,
  );
  await runDevice({
    directory,
    fetch: options.fetch,
    input,
    output,
    events: options.events,
    webSocketFactory: options.webSocketFactory,
  });
  return { directory, enrolled: true, deviceId: enrolled.deviceId };
}

async function executeAction(
  device: ReturnType<typeof createDevice>,
  action: Action,
  manifest: DeviceManifest,
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<StoredOutcome> {
  if (Date.now() >= action.expiresAt) {
    return { status: "failed", result: { code: "expired" } };
  }
  if (
    !manifest.capabilities.includes(action.capability) ||
    typeof handlers[action.capability] !== "function"
  ) {
    return { status: "failed", result: { code: "unsupported_capability" } };
  }
  try {
    const result = await handlers[action.capability]!(action.args);
    if (Date.now() >= action.expiresAt) {
      return { status: "failed", result: { code: "expired" } };
    }
    return { status: "succeeded", result };
  } catch {
    return { status: "failed", result: { code: "adapter_error" } };
  }
}

async function saveJournal(path: string, journal: ActionJournal) {
  const tempPath = join(
    resolve(path, ".."),
    `.actions.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const file = await open(tempPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(journal)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function loadJournal(path: string): Promise<ActionJournal> {
  try {
    const journal = JSON.parse(await readFile(path, "utf8")) as ActionJournal;
    if (!journal || Array.isArray(journal) || typeof journal !== "object")
      throw new Error("invalid action journal");
    for (const [id, entry] of Object.entries(journal)) {
      if (
        !id ||
        !entry ||
        (entry.state !== "pending" && entry.state !== "completed") ||
        !Number.isFinite(entry.expiresAt) ||
        typeof entry.acknowledged !== "boolean" ||
        (entry.recoveryRequired !== undefined &&
          typeof entry.recoveryRequired !== "boolean") ||
        (entry.state === "completed" &&
          (!entry.outcome ||
            !["succeeded", "failed"].includes(entry.outcome.status)))
      )
        throw new Error("invalid action journal");
      // Earlier runners recorded this recovery outcome without a stop flag.
      if (
        entry.outcome?.result &&
        typeof entry.outcome.result === "object" &&
        "code" in entry.outcome.result &&
        entry.outcome.result.code === "outcome_unknown"
      )
        entry.recoveryRequired = true;
    }
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("invalid action journal; refusing device execution");
  }
}

async function flushJournal(
  device: ReturnType<typeof createDevice>,
  path: string,
  journal: ActionJournal,
  output: NodeJS.WriteStream,
): Promise<boolean> {
  for (const [actionId, entry] of Object.entries(journal)) {
    if (entry.state === "pending") {
      entry.state = "completed";
      entry.recoveryRequired = true;
      entry.outcome = {
        status: "failed",
        result: { code: "outcome_unknown" },
      };
      await saveJournal(path, journal);
    }
    if (entry.acknowledged || entry.terminal) continue;
    if (Date.now() >= entry.expiresAt) {
      entry.terminal = "expired";
      await saveJournal(path, journal);
      output.write(
        `Action ${actionId} expired before its result was acknowledged; its outcome remains unconfirmed.\n`,
      );
      continue;
    }
    try {
      const receipt = await device.submitResult(actionId, entry.outcome!);
      const expectedResult = JSON.stringify(entry.outcome!.result);
      if (
        !receipt ||
        receipt.id !== actionId ||
        receipt.status !== entry.outcome!.status ||
        !Object.hasOwn(receipt, "result") ||
        expectedResult === undefined ||
        !isDeepStrictEqual(receipt.result, JSON.parse(expectedResult))
      )
        throw new Error(
          "Result receipt does not match the saved outcome; journal retained",
        );
      entry.acknowledged = true;
      await saveJournal(path, journal);
    } catch (error) {
      if (!(error instanceof OpenLaunchError)) throw error;
      if ([401, 403, 404].includes(error.status))
        throw new Error(
          `Device access is no longer valid (${error.status}); result delivery remains unconfirmed`,
        );
      if (
        error.status === 0 ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500
      )
        return false;
      if (error.status >= 400) {
        entry.terminal = `http_${error.status}`;
        await saveJournal(path, journal);
        output.write(
          `Could not confirm result delivery for action ${actionId} (HTTP ${error.status}); its outcome remains unconfirmed.\n`,
        );
        continue;
      }
      throw error;
    }
  }
  if (Object.values(journal).some((entry) => entry.recoveryRequired))
    throw new Error(
      "Interrupted action outcome is unknown; inspect the device and recover before accepting new commands",
    );
  return true;
}

export async function runDevice(
  options: {
    directory?: string;
    fetch?: typeof fetch;
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
    pollMs?: number;
    events?: boolean;
    webSocketFactory?: DeviceEventSocketFactory;
  } = {},
) {
  const directory = resolve(options.directory ?? "openlaunch-device");
  const identity = JSON.parse(
    await readFile(join(directory, "identity.json"), "utf8"),
  ) as Identity;
  if (
    !identity ||
    !identity.workspace ||
    !identity.deviceId ||
    !identity.credential ||
    !identity.manifest
  )
    throw new Error("identity.json is incomplete");
  const adapter = (await import(
    pathToFileURL(join(directory, "adapter.mjs")).href
  )) as AdapterModule;
  if (JSON.stringify(adapter.manifest) !== JSON.stringify(identity.manifest))
    throw new Error(
      "adapter.mjs manifest changed; publish it before running the adapter",
    );
  validateAdapter(adapter);
  const device = createDevice({
    ...identity,
    fetch: options.fetch,
    webSocketFactory: options.webSocketFactory,
  });
  const journalPath = join(directory, ".actions.json");
  const journal = await loadJournal(journalPath);
  const handlers = adapter.handlers!;
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  let stopping = false;
  let wakeGeneration = 0;
  let waiting: (() => void) | undefined;
  const wake = () => {
    wakeGeneration++;
    waiting?.();
  };
  const stop = () => {
    stopping = true;
    waiting?.();
  };
  const waitFor = (milliseconds: number, sinceGeneration = wakeGeneration) =>
    new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.off?.("data", onData);
        if (waiting === finish) waiting = undefined;
        resolveWait();
      };
      const timer = setTimeout(finish, milliseconds);
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("\u0003")) stop();
        finish();
      };
      waiting = finish;
      if (input.isTTY) input.once("data", onData);
      if (wakeGeneration !== sinceGeneration || stopping) finish();
    });
  const eventChannel =
    options.events === false ? undefined : device.openEvents(wake);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  eventChannel?.start();
  try {
    while (!stopping) {
      const flushGeneration = wakeGeneration;
      let journalFlushed: boolean;
      try {
        journalFlushed = await flushJournal(
          device,
          journalPath,
          journal,
          output,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "Device access is no longer valid",
            "Result receipt does not match",
            "Interrupted action outcome is unknown",
          ].some((message) => error.message.startsWith(message))
        )
          throw error;
        throw new Error(
          "Could not safely update the action journal; refusing to continue",
          { cause: error },
        );
      }
      if (!journalFlushed) {
        output.write(
          "Connection interrupted; retrying result delivery shortly.\n",
        );
        await waitFor(
          Math.min(options.pollMs ?? POLL_MS, 10_000),
          flushGeneration,
        );
        continue;
      }
      const pollGeneration = wakeGeneration;
      try {
        const action = await device.nextAction();
        if (action) {
          let entry = journal[action.id];
          if (!entry) {
            if (Object.keys(journal).length >= MAX_JOURNAL_ENTRIES)
              throw new Error(
                "action journal retention limit reached; archive safely before restarting",
              );
            journal[action.id] = {
              state: "pending",
              expiresAt: action.expiresAt,
              acknowledged: false,
            };
            await saveJournal(journalPath, journal);
            const outcome = await executeAction(
              device,
              action,
              identity.manifest,
              handlers,
            );
            journal[action.id] = {
              state: "completed",
              expiresAt: action.expiresAt,
              acknowledged: false,
              outcome,
            };
            await saveJournal(journalPath, journal);
          }
          continue;
        }
        if (wakeGeneration !== pollGeneration) continue;
      } catch (error) {
        if (!(error instanceof OpenLaunchError)) throw error;
        if (
          error instanceof OpenLaunchError &&
          [401, 403, 404].includes(error.status)
        )
          throw new Error(
            `Device access is no longer valid (${error.status}); re-pair or restore access in the openlaunch console`,
          );
        if (
          error instanceof OpenLaunchError &&
          error.status > 0 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        )
          throw error;
        output.write("Connection interrupted; retrying shortly.\n");
        await waitFor(
          Math.min(options.pollMs ?? POLL_MS, 10_000),
          pollGeneration,
        );
        continue;
      }
      await waitFor(options.pollMs ?? POLL_MS, pollGeneration);
    }
  } finally {
    eventChannel?.close();
    waiting?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function parseArgs(args: string[]) {
  const command = ["setup", "run", "publish"].includes(args[0]!)
    ? args[0]!
    : "setup";
  const options: Record<string, string | boolean> = {};
  for (
    let i = ["setup", "run", "publish"].includes(args[0]!) ? 1 : 0;
    i < args.length;
    i++
  ) {
    if (args[i] === "--help" || args[i] === "-h")
      return { command: "help", options };
    const arg = args[i]!;
    if (arg === "--no-start") {
      options.noStart = true;
      continue;
    }
    if (arg === "--enroll-only") {
      options.enrollOnly = true;
      continue;
    }
    const [flag, inline] = arg.split("=", 2);
    if (!["--url", "--directory", "--name"].includes(flag!))
      throw new Error(`Unknown option: ${flag}`);
    const value = inline ?? args[++i];
    if (!value) throw new Error(`${flag} requires a value`);
    options[flag!.slice(2)] = value;
  }
  return { command, options };
}

function validateAdapter(
  adapter: AdapterModule,
): asserts adapter is Required<AdapterModule> {
  const manifest = adapter.manifest;
  const handlers = adapter.handlers;
  if (
    !manifest ||
    !Array.isArray(manifest.capabilities) ||
    !handlers ||
    typeof handlers !== "object"
  )
    throw new Error("adapter.mjs must export manifest and handlers");
  if (
    Object.keys(handlers).some(
      (name) => !manifest.capabilities.includes(name),
    ) ||
    manifest.capabilities.some((name) => typeof handlers[name] !== "function")
  )
    throw new Error(
      "Each advertised capability must have exactly one matching handler in adapter.mjs",
    );
}

export async function publishAdapter(
  options: {
    directory?: string;
    fetch?: typeof fetch;
    output?: NodeJS.WriteStream;
  } = {},
) {
  const directory = resolve(options.directory ?? "openlaunch-device");
  const identityPath = join(directory, "identity.json");
  const identity = JSON.parse(await readFile(identityPath, "utf8")) as Identity;
  const adapter = (await import(
    pathToFileURL(join(directory, "adapter.mjs")).href
  )) as AdapterModule;
  validateAdapter(adapter);
  const device = createDevice({ ...identity, fetch: options.fetch });
  const publication = await device.publishManifest(adapter.manifest);
  const nextIdentity = { ...identity, manifest: adapter.manifest };
  const tempPath = join(
    directory,
    `.identity.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(nextIdentity, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, identityPath);
  } finally {
    await rm(tempPath, { force: true });
  }
  await chmod(identityPath, 0o600);
  (options.output ?? stdout).write(
    `${publication.grantsRevoked ? "Manifest changed; previous grants were revoked. " : ""}Adapter capabilities published. Review and grant the desired capabilities in the openlaunch console.\n`,
  );
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "help") {
      stdout.write(
        "openlaunch-device setup [--url ORIGIN] [--directory PATH] [--name NAME] [--no-start]\nopenlaunch-device run [--directory PATH]\nopenlaunch-device publish [--directory PATH]\n",
      );
      return;
    }
    if (command === "run")
      await runDevice({
        directory: String(options.directory ?? "openlaunch-device"),
      });
    else if (command === "publish")
      await publishAdapter({
        directory: String(options.directory ?? "openlaunch-device"),
      });
    else
      await setupDevice({
        directory: String(options.directory ?? "openlaunch-device"),
        url: options.url as string | undefined,
        name: options.name as string | undefined,
        noStart: Boolean(options.noStart),
        enrollOnly: Boolean(options.enrollOnly),
      });
  } catch (error) {
    stderrWrite(error instanceof Error ? error.message : "Setup failed");
    process.exitCode = 1;
  }
}
function stderrWrite(message: string) {
  process.stderr.write(`${message}\n`);
}
if (process.argv[1]) {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
      void main();
  } catch {
    // Imported modules and unresolved command paths are not CLI entry points.
  }
}
