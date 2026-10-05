#!/usr/bin/env node
/// <reference types="node" />
/** Dynamic command-line client for agent connections. */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { stderr, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { createClient, OpenLaunchError, sdkTokenWorkspace } from "./index.js";
import {
  readAgentConfig,
  removeAgentConfig,
  validateAgentConfig,
  writeAgentConfig,
} from "./agent-config.js";
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
type Output = { write(value: string): void };

class AgentCliCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCliCallError";
  }
}

function usage(): string {
  return [
    "Usage:",
    "  ol login [--url HTTPS_ORIGIN]",
    "  ol logout",
    "  ol --version",
    "  ol devices list",
    "  ol functions list [--device DEVICE_ID]",
    "  ol call DEVICE_ID FUNCTION [ARGUMENTS_JSON] [--key KEY] [--ttl SECONDS]",
    "  ol actions get ACTION_ID",
    "  ol actions cancel ACTION_ID",
    "  ol actions watch ACTION_ID [--interval-ms MS] [--timeout-seconds SECONDS]",
    "",
    "ol login prompts for an agent API credential and stores it privately on this computer.",
    "OPENLAUNCH_AGENT_TOKEN overrides saved login; OPENLAUNCH_URL and OPENLAUNCH_WORKSPACE are optional.",
  ].join("\n");
}

function parseOptions(values: string[]): {
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
): Promise<void> {
  const [group, command, ...rawArgs] = argv;
  if (!group || !command) throw new Error(usage());
  if (group === "devices" && command === "list") {
    const { positional, options } = parseOptions(rawArgs);
    if (positional.length || options.size) throw new Error(usage());
    writeJson(output, await client.listDevices());
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
  const workspace =
    environment.OPENLAUNCH_WORKSPACE ?? sdkTokenWorkspace(token);
  const client = createClient({
    url: environment.OPENLAUNCH_URL ?? saved?.url ?? DEFAULT_URL,
    token,
    ...(workspace ? { workspace } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  await execute(
    client,
    argv,
    output,
    dependencies.sleep ??
      ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
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
      const { positional, options } = parseOptions(process.argv.slice(3));
      if (positional.length || [...options.keys()].some((key) => key !== "url"))
        throw new Error(usage());
      stdout.write(
        "Create a separate agent API credential in Connections, then paste it here.\n",
      );
      const config = validateAgentConfig({
        version: 1,
        url: options.get("url") ?? process.env.OPENLAUNCH_URL ?? DEFAULT_URL,
        token:
          process.env.OPENLAUNCH_AGENT_TOKEN ??
          (await askSecret(
            "Agent API token (hidden): ",
            stdin,
            stdout,
            "OPENLAUNCH_AGENT_TOKEN",
          )),
      });
      // Validate the existing credential with read-only discovery; login creates no grants or tokens.
      await createClient(config).listFunctions();
      await writeAgentConfig(config);
      stdout.write(
        "Saved private agent login. Run ol devices list and ol functions list.\n",
      );
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
