// Protocol output only on stdout. This adapter reads the agent credential, never the owner credential.
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const path = resolve(
  process.env.OPENLAUNCH_INSTALL_DIR ??
    fileURLToPath(new URL("../", import.meta.url)),
  ".cache/local/agent.json",
);
const info = statSync(path);
if (
  process.platform !== "win32" &&
  (info.mode & 0o077 || info.uid !== process.getuid())
) {
  throw Error("Agent credential must belong to you and have mode 600");
}
const { token, origin } = JSON.parse(readFileSync(path, "utf8"));
const address = new URL(origin);
if (
  address.protocol !== "http:" ||
  address.hostname !== "127.0.0.1" ||
  address.username ||
  address.password ||
  address.pathname !== "/" ||
  address.search ||
  address.hash ||
  typeof token !== "string" ||
  !/^[a-f0-9]{64}$/.test(token)
)
  throw Error("Invalid local bridge credential; restart openlaunch");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
    const response = await fetch(origin + "/mcp", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
    });
    if (message.id === undefined) continue;
    if (!response.ok) throw Error(`Bridge returned HTTP ${response.status}`);
    process.stdout.write(JSON.stringify(await response.json()) + "\n");
  } catch (error) {
    if (message?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "Bridge unavailable",
          },
        }) + "\n",
      );
    else console.error("openlaunch could not process an MCP notification");
  }
}
