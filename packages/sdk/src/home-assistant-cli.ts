#!/usr/bin/env node
/** Persistent outbound Home Assistant gateway. Run under the local HA user's identity. */
import {
  createDevice,
  sdkTokenWorkspace,
  OpenLaunchError,
  type DeviceManifest,
} from "./index.js";
import {
  HomeAssistant,
  discoverHA,
  gatewayManifest,
  type HAChild,
  type HASnapshot,
} from "./home-assistant.js";
import {
  normalizeOrigin,
  loadJournal,
  saveJournal,
  flushJournal,
} from "./cli.js";
import { askSecret } from "./secret.js";
import {
  mkdir,
  readFile,
  rename,
  rm,
  open,
  chmod,
  lstat,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const DEFAULT_DIRECTORY = join(homedir(), ".config/openlaunch/home-assistant");
type Identity = {
  url: string;
  workspace: string;
  deviceId: string;
  credential: string;
  manifest: DeviceManifest;
  haUrl: string;
  haToken?: string;
  supervisor?: boolean;
};
type Options = {
  directory?: string;
  url?: string;
  haUrl?: string;
  haToken?: string;
  sdkToken?: string;
  supervisor?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  events?: boolean;
  pollMs?: number;
  refreshMs?: number;
  output?: NodeJS.WriteStream;
};
async function privateWrite(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readIdentity(directory: string): Promise<Identity> {
  const metadata = await lstat(join(directory, "identity.json"));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077)
    throw Error(
      "Home Assistant identity must be a private regular file (chmod 600)",
    );
  const i = JSON.parse(
    await readFile(join(directory, "identity.json"), "utf8"),
  ) as Identity;
  if (
    !i.deviceId ||
    !i.credential ||
    !i.workspace ||
    !i.haUrl ||
    (!i.haToken && !i.supervisor) ||
    i.manifest?.kind !== "gateway.home-assistant"
  )
    throw Error("Invalid Home Assistant identity; refusing to start");
  return { ...i, url: normalizeOrigin(i.url) };
}
const prompt = async (label: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
};
export async function setupHomeAssistant(options: Options = {}) {
  const directory = resolve(options.directory ?? DEFAULT_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const existing = await readIdentity(directory);
    process.stdout.write(
      "Keeping existing Home Assistant pairing and credentials.\n",
    );
    return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const supervisor = options.supervisor ?? !!process.env.SUPERVISOR_TOKEN;
  const haUrl =
    options.haUrl ??
    process.env.OPENLAUNCH_HA_URL ??
    (supervisor
      ? "http://supervisor"
      : (await prompt(
          "Home Assistant URL [http://homeassistant.local:8123]: ",
        )) || "http://homeassistant.local:8123");
  const haToken =
    options.haToken ??
    (supervisor
      ? process.env.SUPERVISOR_TOKEN
      : (process.env.OPENLAUNCH_HA_TOKEN ??
        (await askSecret(
          "Home Assistant long-lived access token: ",
          process.stdin,
          process.stdout,
          "OPENLAUNCH_HA_TOKEN",
        ))));
  const ha = new HomeAssistant(haUrl, haToken ?? "", options.fetch, supervisor);
  const snapshot = await ha.snapshot();
  const url = normalizeOrigin(options.url ?? "https://www.openlaunch.dev");
  const sdkToken =
    options.sdkToken ??
    (await askSecret(
      "openlaunch Home Assistant setup token: ",
      process.stdin,
      process.stdout,
    ));
  const workspace = sdkTokenWorkspace(sdkToken);
  if (!workspace || !sdkToken.startsWith("ol_sdk_"))
    throw Error(
      "Use a Home Assistant device setup token from the openlaunch console",
    );
  const pendingPath = join(directory, ".setup-pending.json");
  let pending: { requestId: string; url: string; workspace: string };
  try {
    pending = JSON.parse(await readFile(pendingPath, "utf8"));
    if (
      pending.url !== url ||
      pending.workspace !== workspace ||
      typeof pending.requestId !== "string"
    )
      throw Error("Pending pairing belongs to a different workspace");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    pending = { requestId: randomUUID(), url, workspace };
    await privateWrite(pendingPath, pending);
  }
  const device = createDevice({
    url,
    workspace,
    token: sdkToken,
    fetch: options.fetch,
  });
  const manifest = gatewayManifest;
  const attached = await device.attach(manifest, pending.requestId);
  const identity: Identity = {
    url,
    workspace,
    deviceId: attached.deviceId,
    credential: attached.token,
    manifest,
    haUrl: ha.url,
    ...(supervisor ? { supervisor: true } : { haToken }),
  };
  await privateWrite(join(directory, "identity.json"), identity);
  await rm(pendingPath, { force: true });
  process.stdout.write(
    "Paired Home Assistant. Credentials stay in " + directory + ".\n",
  );
  return identity;
}

/** Publish a complete bounded inventory. Revoked children never regain access. */
export async function publishHAInventory(
  device: ReturnType<typeof createDevice>,
  snapshot: HASnapshot,
  previous = new Map<
    string,
    { fingerprint: string; deviceId: string; revoked?: boolean }
  >(),
) {
  const children = discoverHA(snapshot);
  if (children.length > 2000)
    throw Error(
      "Home Assistant inventory exceeds the approved 2000-device limit",
    );
  const next = new Map<
    string,
    { fingerprint: string; deviceId: string; revoked?: boolean }
  >();
  const byId = new Map<string, HAChild>();
  let batch: HAChild[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const outcomes = await device.gatewayChildren(
      batch.map(({ key, manifest }) => ({ key, manifest })),
    );
    if (outcomes.length !== batch.length)
      throw Error("Incomplete gateway inventory response");
    for (let n = 0; n < batch.length; n++) {
      const child = batch[n]!;
      const outcome = outcomes[n]!;
      if (outcome.key !== child.key || outcome.error || !outcome.deviceId)
        throw Error(
          "Gateway inventory rejected; inspect the setup limit and gateway access",
        );
      next.set(child.key, {
        fingerprint: JSON.stringify(child.manifest),
        deviceId: outcome.deviceId,
        revoked: outcome.revoked,
      });
      if (!outcome.revoked) byId.set(outcome.deviceId, child);
    }
    batch = [];
  };
  for (const child of children) {
    const cached = previous.get(child.key);
    const fingerprint = JSON.stringify(child.manifest);
    if (cached?.fingerprint === fingerprint) {
      next.set(child.key, cached);
      if (!cached.revoked) byId.set(cached.deviceId, child);
      continue;
    }
    if (
      batch.length >= 8 ||
      Buffer.byteLength(
        JSON.stringify({
          children: [...batch, child].map(({ key, manifest }) => ({
            key,
            manifest,
          })),
        }),
      ) > 63000
    )
      await flush();
    batch.push(child);
  }
  await flush();
  // Only a complete successful discovery can remove inventory. An outage never does.
  const keys = children.map((c) => c.key);
  if (keys.length !== previous.size || keys.some((k) => !previous.has(k)))
    await device.gatewayStatus(true, keys);
  else await device.gatewayStatus(true);
  return { inventory: next, byId };
}

export async function runHomeAssistant(options: Options = {}) {
  const directory = resolve(options.directory ?? DEFAULT_DIRECTORY);
  const identity = await readIdentity(directory);
  const output = options.output ?? process.stdout;
  const lock = join(directory, ".runner-lock");
  // Exclusive process lock, with safe recovery after a crashed process.
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let pid: number;
    try {
      pid = Number(await readFile(join(lock, "pid"), "utf8"));
      if (!Number.isInteger(pid) || pid < 1) throw Error();
      process.kill(pid, 0);
      throw Error("Home Assistant gateway is already running");
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH")
        throw Error(
          "Home Assistant gateway is already running or its lock needs inspection",
        );
    }
    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
  }
  const pidFile = await open(join(lock, "pid"), "wx", 0o600);
  await pidFile.writeFile(String(process.pid));
  await pidFile.close();
  const device = createDevice({ ...identity, fetch: options.fetch });
  const ha = new HomeAssistant(
    identity.haUrl,
    identity.supervisor
      ? (process.env.SUPERVISOR_TOKEN ?? "")
      : identity.haToken!,
    options.fetch,
    identity.supervisor,
  );
  const journalPath = join(directory, ".actions.json");
  const journal = await loadJournal(journalPath);
  let stopped = !!options.signal?.aborted;
  let waiting: (() => void) | undefined;
  let generation = 0;
  const wake = () => {
    generation++;
    waiting?.();
  };
  const stop = () => {
    stopped = true;
    wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop, { once: true });
  const wait = (ms: number, since = generation) =>
    new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        if (waiting === finish) waiting = undefined;
        done();
      };
      const timer = setTimeout(finish, ms);
      waiting = finish;
      if (stopped || generation !== since) finish();
    });
  const events = options.events === false ? undefined : device.openEvents(wake);
  events?.start();
  let snapshot: HASnapshot | undefined;
  let inventory = new Map<
    string,
    { fingerprint: string; deviceId: string; revoked?: boolean }
  >();
  let byId = new Map<string, HAChild>();
  let nextRefresh = 0;
  output.write(
    "Home Assistant gateway running. Manage agent access in the openlaunch console. Ctrl-C stops this runner.\n",
  );
  try {
    while (!stopped) {
      if (!(await flushJournal(device, journalPath, journal, output))) {
        await wait(2000);
        continue;
      }
      const since = generation;
      try {
        if (Date.now() >= nextRefresh) {
          try {
            const fresh = await ha.snapshot();
            const published = await publishHAInventory(
              device,
              fresh,
              inventory,
            );
            snapshot = fresh;
            inventory = published.inventory;
            byId = published.byId;
            nextRefresh = Date.now() + (options.refreshMs ?? 60000);
          } catch (e) {
            if (e instanceof OpenLaunchError) throw e;
            await device.gatewayStatus(false);
            nextRefresh = Date.now() + 10000;
            output.write(
              "Home Assistant unavailable or inventory rejected. Retrying; existing grants are preserved.\n",
            );
            if ((e as Error).message === "ha_authentication_failed")
              throw Error(
                "Home Assistant sign-in expired. Update the local token before restarting.",
              );
            snapshot = undefined;
          }
        }
        if (!snapshot) {
          await wait(2000, since);
          continue;
        }
        const action = await device.nextAction();
        if (!action) {
          await wait(options.pollMs ?? 10000, since);
          continue;
        }
        if (journal[action.id]) {
          continue;
        }
        if (Object.keys(journal).length >= 5000)
          throw Error("Action journal full; archive it before restarting");
        journal[action.id] = {
          state: "pending",
          expiresAt: action.expiresAt,
          acknowledged: false,
        };
        await saveJournal(journalPath, journal);
        let outcome: { status: "succeeded" | "failed"; result: unknown };
        let heartbeatBusy = false;
        const heartbeat = setInterval(() => {
          if (heartbeatBusy) return;
          heartbeatBusy = true;
          void device
            .heartbeat()
            .catch(() => {})
            .finally(() => {
              heartbeatBusy = false;
            });
        }, 20000);
        try {
          const child = byId.get(action.deviceId);
          if (action.deviceId !== identity.deviceId && !child)
            throw Error("linked_device_unavailable");
          outcome = {
            status: "succeeded",
            result: await ha.execute(action, child, snapshot),
          };
        } catch (e) {
          const code = (e as Error).message;
          outcome = {
            status: "failed",
            result: {
              code: /^[a-z_0-9]+$/.test(code) ? code : "ha_operation_failed",
              ...(code === "ha_write_outcome_unknown"
                ? { outcomeUnknown: true }
                : {}),
              physicalVerified: false,
            },
          };
          if (
            code === "ha_unreachable_or_timeout" ||
            code === "ha_write_outcome_unknown" ||
            code === "ha_authentication_failed"
          )
            nextRefresh = 0;
        } finally {
          clearInterval(heartbeat);
        }
        journal[action.id] = {
          state: "completed",
          expiresAt: action.expiresAt,
          acknowledged: false,
          outcome,
        };
        await saveJournal(journalPath, journal);
      } catch (e) {
        if (
          (e instanceof OpenLaunchError && [0, 408, 429].includes(e.status)) ||
          (e instanceof OpenLaunchError && e.status >= 500)
        ) {
          output.write(
            "openlaunch connection interrupted. Retrying without replaying HA commands.\n",
          );
          await wait(2000);
          continue;
        }
        throw e;
      }
    }
  } finally {
    if (Object.values(journal).some((e) => e.recoveryRequired))
      output.write(
        "Interrupted action IDs: " +
          Object.entries(journal)
            .filter(([, e]) => e.recoveryRequired)
            .map(([id]) => id)
            .join(", ") +
          ". Inspect HA before recovery.\n",
      );
    events?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    await device.gatewayStatus(false).catch(() => {});
    await rm(lock, { recursive: true, force: true });
  }
}

export function homeAssistantService(
  command: string,
  directory = DEFAULT_DIRECTORY,
) {
  if (process.platform !== "linux")
    throw Error(
      "Background service requires Linux. Use openlaunch-ha start on this computer.",
    );
  const unit = "openlaunch-ha.service";
  const systemctl = (args: string[]) => {
    const result = spawnSync("systemctl", ["--user", ...args], {
      stdio: "inherit",
    });
    if (result.error || result.status !== 0)
      throw Error(
        "User service command failed. Use openlaunch-ha start when no user service manager is available.",
      );
  };
  if (command === "install")
    return (async () => {
      const units = join(homedir(), ".config/systemd/user");
      await mkdir(units, { recursive: true });
      const quote = (v: string) =>
        '"' +
        v.replace(/[%"\\\n\r]/g, (c) =>
          c === "%" ? "%%" : c === "\n" || c === "\r" ? "" : "\\" + c,
        ) +
        '"';
      const unitPath = join(units, unit);
      const file = await open(unitPath, "w", 0o600);
      try {
        await file.writeFile(
          `[Unit]\nDescription=openlaunch Home Assistant gateway\nAfter=network-online.target\n\n[Service]\nExecStart=${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} start --directory ${quote(resolve(directory))}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
        );
      } finally {
        await file.close();
      }
      systemctl(["daemon-reload"]);
      systemctl(["enable", "--now", unit]);
      process.stdout.write(
        "Home Assistant gateway service installed. Use openlaunch-ha service status or logs.\n",
      );
    })();
  if (command === "logs") {
    const r = spawnSync(
      "journalctl",
      ["--user", "-u", unit, "-n", "100", "--no-pager"],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw Error("Cannot read service logs");
    return;
  }
  if (!["start", "stop", "restart", "status"].includes(command))
    throw Error("Use service install, start, stop, restart, status or logs");
  systemctl([command, unit]);
}
async function main(args: string[]) {
  const command = args.shift() ?? "setup";
  const options: Options = {};
  const serviceCommand = command === "service" ? args.shift() : undefined;
  while (args.length) {
    const key = args.shift();
    if (key === "--help" || key === "-h") {
      args = [];
      return help();
    }
    if (!["--directory", "--url"].includes(key ?? ""))
      throw Error("Unknown option. Use openlaunch-ha --help");
    const value = args.shift();
    if (!value) throw Error("Option requires a value");
    if (key === "--directory") options.directory = value;
    else options.url = value;
  }
  if (command === "--help" || command === "-h") return help();
  if (command === "setup") {
    options.sdkToken = process.env.OPENLAUNCH_SETUP_TOKEN;
    await setupHomeAssistant(options);
    await runHomeAssistant(options);
  } else if (command === "recover") {
    const directory = resolve(options.directory ?? DEFAULT_DIRECTORY);
    const identity = await readIdentity(directory);
    const recoveryId = process.env.OPENLAUNCH_RECOVERY_ACTION_ID;
    if (
      recoveryId &&
      (!identity.supervisor || !/^[a-f0-9-]{36}$/.test(recoveryId))
    )
      throw Error("Recovery action ID is invalid for this app");
    try {
      const pid = Number(
        await readFile(join(directory, ".runner-lock/pid"), "utf8"),
      );
      process.kill(pid, 0);
      throw Error("Stop the gateway before recovery");
    } catch (e) {
      if (
        !["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")
      )
        throw e;
    }
    if (
      !recoveryId &&
      (await prompt(
        "Confirm you inspected Home Assistant and accept interrupted outcomes as unknown. Type recover: ",
      )) !== "recover"
    )
      throw Error("Recovery cancelled");
    const path = join(directory, ".actions.json");
    const journal = await loadJournal(path);
    for (const [id, entry] of Object.entries(journal)) {
      if (recoveryId && id !== recoveryId) continue;
      if (entry.state === "pending") {
        entry.state = "completed";
        entry.outcome = {
          status: "failed",
          result: {
            code: "outcome_unknown",
            outcomeUnknown: true,
            physicalVerified: false,
          },
        };
      }
      if (
        entry.recoveryRequired ||
        (entry.outcome?.result as { code?: string })?.code === "outcome_unknown"
      ) {
        entry.recoveryRequired = false;
        entry.terminal = "expired";
      }
    }
    // A distinct marker prevents older shared journal readers from re-enabling the stop flag.
    for (const [id, entry] of Object.entries(journal))
      if (
        (!recoveryId || id === recoveryId) &&
        (entry.outcome?.result as { code?: string })?.code === "outcome_unknown"
      )
        entry.outcome!.result = {
          code: "outcome_unknown_owner_reviewed",
          outcomeUnknown: true,
          physicalVerified: false,
        };
    await saveJournal(path, journal);
    process.stdout.write(
      "Interrupted outcomes remain unknown. No HA command was replayed. Run openlaunch-ha start.\n",
    );
  } else if (command === "start") await runHomeAssistant(options);
  else if (command === "status") {
    const i = await readIdentity(
      resolve(options.directory ?? DEFAULT_DIRECTORY),
    );
    process.stdout.write(
      JSON.stringify(
        {
          deviceId: i.deviceId,
          homeAssistant: i.haUrl,
          configuration: resolve(options.directory ?? DEFAULT_DIRECTORY),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (command === "service")
    await homeAssistantService(serviceCommand ?? "status", options.directory);
  else throw Error("Use setup, start, status or service");
}
function help() {
  process.stdout.write(
    "openlaunch-ha setup           Pair HA and start; updates preserve credentials\nopenlaunch-ha start           Run an existing gateway (Ctrl-C to stop)\nopenlaunch-ha status          Show pairing and private configuration location\nopenlaunch-ha recover         Review and acknowledge interrupted outcomes locally\nopenlaunch-ha service install Install a Linux user service\nopenlaunch-ha service stop    Stop the installed service\nopenlaunch-ha service logs    Inspect service logs\nOptions: --directory PATH, --url ORIGIN\nHome Assistant tokens are prompted privately, never accepted in command arguments.\n",
  );
}
try {
  if (
    process.argv[1] &&
    realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
  )
    void main(process.argv.slice(2)).catch((error) => {
      if (
        error instanceof Error &&
        error.message.startsWith("Interrupted action outcome")
      )
        process.stderr.write(
          "An interrupted action is unknown. Inspect HA, then run openlaunch-ha recover before restarting.\n",
        );
      else if (
        error instanceof Error &&
        /^(Home Assistant|User service|Gateway inventory|Action journal|Stop the gateway|Recovery cancelled)/.test(
          error.message,
        )
      )
        process.stderr.write(error.message + "\n");
      else if (error instanceof OpenLaunchError)
        process.stderr.write(
          `openlaunch rejected the gateway request (HTTP ${error.status}, ${error.code}). Check the Home Assistant setup token and access.\n`,
        );
      else
        process.stderr.write(
          "openlaunch Home Assistant gateway failed. Check connectivity, pairing, or the private action journal; run openlaunch-ha --help.\n",
        );
      process.exitCode = 1;
    });
} catch {}
