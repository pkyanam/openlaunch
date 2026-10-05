import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type AgentConfig = { version: 1; url: string; token: string };
export const agentConfigDirectory = () =>
  join(homedir(), ".config", "openlaunch");

function ownedPrivate(stat: Stats) {
  return (
    (typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
    (stat.mode & 0o077) === 0
  );
}

export function validateAgentConfig(value: unknown): AgentConfig {
  const config = value as Partial<AgentConfig> | null;
  if (
    !config ||
    config.version !== 1 ||
    typeof config.url !== "string" ||
    typeof config.token !== "string" ||
    !/^ol_agent_[a-f0-9]{64}_[a-f0-9]{64}$/.test(config.token)
  )
    throw new Error(
      "Use an ol_agent_ API credential from Connections; setup and owner credentials cannot log in to ol",
    );
  const url = new URL(config.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS service origin or literal loopback HTTP origin",
    );
  return { version: 1, url: url.origin, token: config.token };
}

export async function readAgentConfig(
  directory = agentConfigDirectory(),
): Promise<AgentConfig | undefined> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || !ownedPrivate(stat))
      throw new Error("ol config directory must be private and owned by you");
    const file = await open(
      join(directory, "agent.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !ownedPrivate(stat) || stat.size > 4096)
        throw new Error(
          "ol config must be a private regular file owned by you",
        );
      return validateAgentConfig(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Cannot read private ol configuration; run ol login or set OPENLAUNCH_AGENT_TOKEN",
    );
  }
}

export async function writeAgentConfig(
  value: AgentConfig,
  directory = agentConfigDirectory(),
): Promise<void> {
  const config = validateAgentConfig(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error(
      "Refusing an ol config directory not owned by you or linked elsewhere",
    );
  await chmod(directory, 0o700);
  const path = join(directory, "agent.json");
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || !ownedPrivate(existing))
      throw new Error("Refusing to replace an unsafe ol config file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.agent-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(config) + "\n");
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeAgentConfig(
  directory = agentConfigDirectory(),
): Promise<void> {
  // Read validates directory ownership, permissions and file type before removal.
  if (await readAgentConfig(directory)) await rm(join(directory, "agent.json"));
}
