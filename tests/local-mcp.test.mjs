import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Adapter can use a test installation path, but always selects its agent credential.
test("local stdio adapter connects using only agent credentials and observes grants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openlaunch-stdio-"));
  const owner = randomBytes(32).toString("hex"),
    agent = randomBytes(32).toString("hex");
  const port = 19881,
    origin = `http://127.0.0.1:${port}`;
  await mkdir(join(dir, ".cache/local"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, ".cache/local/agent.json"),
    JSON.stringify({ origin, token: agent }),
    { mode: 0o600 },
  );
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "apps/local/src/server.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        OPENLAUNCH_OWNER_TOKEN: owner,
        OPENLAUNCH_AGENT_TOKEN: agent,
        OPENLAUNCH_STATE_DIR: dir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const client = new Client({ name: "stdio-acceptance", version: "1.0" });
  try {
    await new Promise((ok, bad) => {
      server.stdout.once("data", ok);
      server.once("exit", (code) => bad(Error("server exited " + code)));
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["scripts/local-mcp.mjs"],
        env: { ...process.env, OPENLAUNCH_INSTALL_DIR: dir },
        stderr: "pipe",
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const list = await client.callTool({ name: "list_devices", arguments: {} });
    assert.deepEqual(list.structuredContent.data, []);
    assert(!tools.tools.some((x) => /grant|enroll/.test(x.name)));
    const management = await fetch(origin + "/v1/enrollments", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agent,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "uno-r4-wifi" }),
    });
    assert.equal(management.status, 403);
  } finally {
    await client.close();
    const exit = new Promise((ok) => server.once("exit", ok));
    server.kill("SIGTERM");
    await exit;
    await rm(dir, { recursive: true, force: true });
  }
});
