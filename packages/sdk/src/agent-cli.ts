#!/usr/bin/env node
/// <reference types="node" />
/** Dynamic command-line client for agent connections. */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { stderr, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  createClient,
  OpenLaunchError,
  sdkTokenWorkspace,
  type AccessPolicy,
} from "./index.js";
import {
  readAgentConfig,
  removeAgentConfig,
  validateAgentConfig,
  writeAgentConfig,
} from "./agent-config.js";
import {
  browserLogin,
  validateLoginOrigin,
  type UrlOpener,
} from "./agent-login.js";
import { askSecret } from "./secret.js";

const DEFAULT_URL = "https://www.openlaunch.dev";
const TERMINAL = new Set([
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "unknown",
]);
const MAX_TTL_SECONDS = 300;
const MAX_WATCH_SECONDS = 3_600;
type AgentClient = ReturnType<typeof createClient>;
type Output = { write(value: string): void; isTTY?: boolean };
type Input = NodeJS.ReadStream;

class AgentCliCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCliCallError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  ol login [--url HTTPS_ORIGIN] [--token TOKEN]",
    "  ol login --agentid [--url HTTPS_ORIGIN] [--workspace ID] [--no-open]",
    "  ol logout",
    "  ol --version",
    "  ol status",
    "  ol onboarding",
    "  ol devices list",
    "  ol devices revoke DEVICE_ID",
    "  ol functions list [--device DEVICE_ID]",
    "  ol call DEVICE_ID FUNCTION [ARGUMENTS_JSON] [--key KEY] [--ttl SECONDS]",
    "  ol actions get ACTION_ID",
    "  ol actions cancel ACTION_ID",
    "  ol actions watch ACTION_ID [--interval-ms MS] [--timeout-seconds SECONDS]",
    "  ol access",
    "  ol access policies",
    "  ol access set POLICY_JSON",
    "  ol agents list",
    "  ol agents invite NAME [--role operator|administrator] [--ttl SECONDS]",
    "  ol agents revoke AGENT_ID",
    "  ol workspace list",
    "  ol workspace join",
    "  ol setup token [NAME] [--ttl SECONDS]",
    "  ol connections list",
    "  ol connections create NAME [--ttl SECONDS] [--access read|act]",
    "  ol connections revoke CONNECTION_ID",
    "",
    "ol login prompts for an agent API credential and stores it privately on this computer.",
    "ol login --agentid signs in with AgentID in a browser (PKCE); --no-open prints",
    "the public sign-in URL only. Plain ol login stays manual; use ol login --agentid",
    "for workspace switching and identity-backed management commands.",
    "OPENLAUNCH_AGENT_TOKEN overrides saved login; OPENLAUNCH_URL and OPENLAUNCH_WORKSPACE are optional.",
  ].join("\n");
}

function parseOptions(
  values: string[],
  booleanFlags: Set<string> = new Set(),
): {
  positional: string[];
  options: Map<string, string>;
} {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!/^[a-z][a-z-]*$/.test(key) || options.has(key))
      throw new Error(`Invalid or repeated option: ${value}`);
    if (booleanFlags.has(key)) {
      options.set(key, "true");
      continue;
    }
    const next = values[++i];
    if (!next || next.startsWith("--"))
      throw new Error(`Option --${key} requires a value`);
    options.set(key, next);
  }
  return { positional, options };
}

function integerOption(
  options: Map<string, string>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = options.get(key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`--${key} must be between ${min} and ${max}`);
  return value;
}

function writeJson(output: Output, value: unknown) {
  output.write(`${JSON.stringify(value)}\n`);
}

function objectArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("ARGUMENTS_JSON must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ARGUMENTS_JSON must be a JSON object");
  return value as Record<string, unknown>;
}

async function execute(
  client: AgentClient,
  argv: string[],
  output: Output,
  sleep: (milliseconds: number) => Promise<void>,
  io: { input: Input; invitationCode?: string; identityBacked: boolean },
): Promise<void> {
  const [group, command, ...rawArgs] = argv;
  if (!group) throw new Error(usage());
  if (group === "status") {
    if (command || rawArgs.length) throw new Error(usage());
    writeJson(output, await client.getAccount());
    return;
  }
  if (group === "onboarding") {
    if (command || rawArgs.length) throw new Error(usage());
    writeJson(output, await client.getOnboarding());
    return;
  }
  if (group === "devices" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    writeJson(output, await client.listDevices());
    return;
  }
  if (group === "devices" && command === "revoke") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length !== 1 || options.size) throw new Error(usage());
    writeJson(output, await client.revokeDevice(positional[0]));
    return;
  }
  if (group === "functions" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (
      positional.length ||
      [...options.keys()].some((key) => key !== "device")
    )
      throw new Error(usage());
    const rows = await client.listFunctions();
    const deviceId = options.get("device");
    writeJson(
      output,
      deviceId ? rows.filter((row) => row.deviceId === deviceId) : rows,
    );
    return;
  }
  if (group === "call") {
    const { positional, options } = parseOptions([command, ...rawArgs]);
    if (
      positional.length < 2 ||
      positional.length > 3 ||
      [...options.keys()].some((key) => !["key", "ttl"].includes(key))
    )
      throw new Error(usage());
    const [deviceId, capability, rawArguments] = positional;
    const idempotencyKey = options.get("key") ?? randomUUID();
    if (!idempotencyKey || idempotencyKey.length > 128)
      throw new Error("--key must be 1–128 characters");
    const ttlSeconds = integerOption(options, "ttl", 30, 1, MAX_TTL_SECONDS);
    const args = objectArguments(rawArguments);
    let action;
    try {
      action = await client.requestAction(deviceId, {
        capability,
        arguments: args,
        idempotencyKey,
        ttlSeconds,
      });
    } catch (error) {
      const failure =
        error instanceof OpenLaunchError
          ? { code: error.code, status: error.status, message: error.message }
          : {
              code: "request_failed",
              status: 0,
              message: "openlaunch request could not be completed",
            };
      writeJson(output, { idempotencyKey, error: failure });
      throw new AgentCliCallError(
        "Action request failed; reuse the reported idempotencyKey with identical arguments to retry safely",
      );
    }
    writeJson(output, { idempotencyKey, action });
    return;
  }
  if (group === "actions" && (command === "get" || command === "cancel")) {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length !== 1 || options.size) throw new Error(usage());
    writeJson(
      output,
      await (command === "get"
        ? client.getAction(positional[0])
        : client.cancelAction(positional[0])),
    );
    return;
  }
  if (group === "actions" && command === "watch") {
    const { positional, options } = parseOptions(rawArgs);
    if (
      positional.length !== 1 ||
      [...options.keys()].some(
        (key) => !["interval-ms", "timeout-seconds"].includes(key),
      )
    )
      throw new Error(usage());
    const intervalMs = integerOption(
      options,
      "interval-ms",
      1_000,
      100,
      30_000,
    );
    const timeoutSeconds = integerOption(
      options,
      "timeout-seconds",
      300,
      1,
      MAX_WATCH_SECONDS,
    );
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let lastStatus: string | undefined;
    while (true) {
      const action = await client.getAction(positional[0]);
      if (action.status !== lastStatus) {
        writeJson(output, action);
        lastStatus = action.status;
      }
      if (TERMINAL.has(action.status)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Timed out waiting for action status");
      await sleep(Math.min(intervalMs, remaining));
    }
  }
  if (group === "access") {
    if (command === "policies") {
      const { positional, options } = parseOptions(rawArgs);
      if (positional.length || options.size) throw new Error(usage());
      writeJson(output, await client.listAccessPolicies());
      return;
    }
    if (command === "set") {
      const { positional, options } = parseOptions(rawArgs);
      if (positional.length !== 1 || options.size) throw new Error(usage());
      writeJson(
        output,
        await client.saveAccessPolicy(
          objectArguments(positional[0]) as unknown as AccessPolicy,
        ),
      );
      return;
    }
    if (!command) {
      if (rawArgs.length) throw new Error(usage());
      writeJson(output, await client.getAccess());
      return;
    }
    throw new Error(usage());
  }
  if (group === "agents" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    writeJson(output, await client.listWorkspaceAgents());
    return;
  }
  if (group === "agents" && command === "invite") {
    const { positional, options } = parseOptions(rawArgs);
    if (
      positional.length !== 1 ||
      [...options.keys()].some((key) => !["role", "ttl"].includes(key))
    )
      throw new Error(usage());
    const role = options.get("role") ?? "operator";
    if (role !== "operator" && role !== "administrator")
      throw new Error("--role must be operator or administrator");
    const ttlSeconds = integerOption(options, "ttl", 600, 60, 3_600);
    writeJson(
      output,
      await client.inviteWorkspaceAgent({
        name: positional[0],
        role,
        ttlSeconds,
      }),
    );
    return;
  }
  if (group === "agents" && command === "revoke") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length !== 1 || options.size) throw new Error(usage());
    writeJson(output, await client.revokeWorkspaceAgent(positional[0]));
    return;
  }
  if (group === "workspace" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    writeJson(output, await client.listWorkspaces());
    return;
  }
  if (group === "workspace" && command === "join") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    if (!io.identityBacked)
      throw new Error(
        "ol workspace join requires an AgentID login; run ol login --agentid first",
      );
    const invitation =
      io.invitationCode ??
      (await askSecret(
        "Invitation code (hidden): ",
        io.input,
        output as unknown as NodeJS.WriteStream,
        "OPENLAUNCH_INVITATION_CODE",
      ));
    const joined = await client.acceptWorkspaceInvitation(invitation);
    writeJson(output, joined);
    const workspaceId = (joined as { workspace?: unknown }).workspace;
    output.write(
      typeof workspaceId === "string" && /^[a-f0-9]{64}$/.test(workspaceId)
        ? `Joined workspace ${workspaceId}. Run ol login --agentid --workspace ${workspaceId} to target it in future commands.\n`
        : "Joined the workspace. Run ol login --agentid --workspace TARGET_WORKSPACE_ID to target it in future commands.\n",
    );
    return;
  }
  if (group === "setup" && command === "token") {
    const { positional, options } = parseOptions(rawArgs);
    if (
      positional.length > 1 ||
      [...options.keys()].some((key) => key !== "ttl")
    )
      throw new Error(usage());
    const ttlSeconds = integerOption(options, "ttl", 600, 60, 3_600);
    writeJson(
      output,
      await client.createDeviceSetupToken({
        ...(positional.length ? { name: positional[0] } : {}),
        ttlSeconds,
      }),
    );
    return;
  }
  if (group === "connections" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    writeJson(output, await client.listAgentConnections());
    return;
  }
  if (group === "connections" && command === "create") {
    const { positional, options } = parseOptions(rawArgs);
    if (
      positional.length !== 1 ||
      [...options.keys()].some((key) => !["ttl", "access"].includes(key))
    )
      throw new Error(usage());
    const access = options.get("access") ?? "act";
    if (access !== "read" && access !== "act")
      throw new Error("--access must be read or act");
    const ttlSeconds = integerOption(options, "ttl", 86_400, 60, 2_592_000);
    writeJson(
      output,
      await client.createAgentConnection({
        name: positional[0],
        ttlSeconds,
        access,
      }),
    );
    return;
  }
  if (group === "connections" && command === "revoke") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length !== 1 || options.size) throw new Error(usage());
    writeJson(output, await client.revokeAgentConnection(positional[0]));
    return;
  }
  throw new Error(usage());
}

export async function runAgentCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: Output = stdout,
  dependencies: {
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    configDirectory?: string;
    input?: Input;
  } = {},
): Promise<void> {
  const saved = environment.OPENLAUNCH_AGENT_TOKEN
    ? undefined
    : await readAgentConfig(dependencies.configDirectory);
  const token = environment.OPENLAUNCH_AGENT_TOKEN ?? saved?.token;
  if (!token)
    throw new Error(
      "Run ol login or set OPENLAUNCH_AGENT_TOKEN to an agent API credential",
    );
  // API tokens are always workspace-bound, regardless of login mode. The
  // AgentID (v2) flag only proves identity-bound metadata for joining.
  const identityBacked = saved?.version === 2;
  const embedded = sdkTokenWorkspace(token);
  if (embedded && environment.OPENLAUNCH_WORKSPACE &&
      environment.OPENLAUNCH_WORKSPACE !== embedded)
    throw new Error(
      `This API token is bound to workspace ${embedded}; to switch workspaces run ol login --agentid --workspace ${environment.OPENLAUNCH_WORKSPACE}`,
    );
  const workspace = environment.OPENLAUNCH_WORKSPACE ?? embedded;
  const client = createClient({
    url: environment.OPENLAUNCH_URL ?? saved?.url ?? DEFAULT_URL,
    token,
    // API tokens are routed by their embedded workspace; never send a
    // target-workspace selector for them.
    ...(workspace ? { workspace } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  await execute(
    client,
    argv,
    output,
    dependencies.sleep ??
      ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    {
      input: dependencies.input ?? stdin,
      invitationCode: environment.OPENLAUNCH_INVITATION_CODE,
      identityBacked,
    },
  );
}

/**
 * `ol login`: manual agent API credential prompt (or --token), or the
 * --agentid browser PKCE flow. The saved credential is only written after the
 * full flow succeeds; a failed login never overwrites an existing one.
 */
export async function runLogin(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    fetch?: typeof fetch;
    configDirectory?: string;
    output?: Output;
    input?: Input;
    openURL?: UrlOpener;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const output = dependencies.output ?? stdout;
  const { positional, options } = parseOptions(
    args,
    new Set(["agentid", "no-open"]),
  );
  if (positional.length) throw new Error(usage());
  const origin = validateLoginOrigin(
    options.get("url") ?? environment.OPENLAUNCH_URL ?? DEFAULT_URL,
  );
  if (options.has("agentid")) {
    if (
      options.has("token") ||
      [...options.keys()].some(
        (key) => !["agentid", "no-open", "url", "workspace"].includes(key),
      )
    )
      throw new Error(usage());
    const workspace = options.get("workspace");
    const result = await browserLogin({
      origin,
      ...(workspace !== undefined ? { workspace } : {}),
      open: !options.has("no-open"),
      output,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.openURL ? { openURL: dependencies.openURL } : {}),
      ...(dependencies.timeoutMs !== undefined
        ? { timeoutMs: dependencies.timeoutMs }
        : {}),
    });
    await writeAgentConfig(result.config, dependencies.configDirectory);
    output.write(
      `Saved private AgentID login for workspace ${result.config.workspace} (connection ${result.config.connectionId}, role ${result.config.role}, access ${result.config.access}). Run ol status and ol devices list.\n`,
    );
    return;
  }
  if (
    [...options.keys()].some((key) => !["url", "token"].includes(key)) ||
    (options.has("token") && environment.OPENLAUNCH_AGENT_TOKEN !== undefined)
  )
    throw new Error(usage());
  output.write(
    "Create a separate agent API credential in Connections, then paste it here.\n",
  );
  const config = validateAgentConfig({
    version: 1,
    url: origin,
    token:
      options.get("token") ??
      environment.OPENLAUNCH_AGENT_TOKEN ??
      (await askSecret(
        "Agent API token (hidden): ",
        dependencies.input ?? stdin,
        output as unknown as NodeJS.WriteStream,
        "OPENLAUNCH_AGENT_TOKEN",
      )),
  });
  // Validate the existing credential with read-only discovery; login creates no grants or tokens.
  await createClient({
    url: origin,
    token: config.token,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  }).listFunctions();
  await writeAgentConfig(config, dependencies.configDirectory);
  output.write(
    "Saved private agent login. Run ol devices list and ol functions list.\n",
  );
}

async function main() {
  try {
    if (process.argv[2] === "--help" || process.argv[2] === "-h") {
      stdout.write(`${usage()}\n`);
      return;
    }
    if (process.argv[2] === "--version") {
      stdout.write(
        `${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}\n`,
      );
      return;
    }
    if (process.argv[2] === "login") {
      await runLogin(process.argv.slice(3));
      return;
    }
    if (process.argv[2] === "logout") {
      if (process.argv.length !== 3) throw new Error(usage());
      await removeAgentConfig();
      stdout.write(
        "Removed saved login. Revoke the API connection in the console to stop access elsewhere.\n",
      );
      return;
    }
    await runAgentCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof AgentCliCallError) {
      process.exitCode = 1;
      return;
    }
    const message =
      error instanceof OpenLaunchError
        ? error.message
        : error instanceof Error
          ? error.message
          : "openlaunch agent command failed";
    stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
      void main();
  } catch {
    // Imported modules and unresolved command paths are not CLI entry points.
  }
}
