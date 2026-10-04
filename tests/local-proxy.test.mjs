import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";

test(
  "real local server enforces configured origin and returns workspace routing ID",
  { timeout: 20000 },
  async () => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const dir = await mkdtemp(join(tmpdir(), "openlaunch-proxy-test-"));
    const owner = randomBytes(32).toString("hex");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/local/src/server.ts"],
      {
        env: {
          ...process.env,
          PORT: String(port),
          OPENLAUNCH_PUBLIC_ORIGIN: "https://boards.example.com",
          OPENLAUNCH_STATE_DIR: dir,
          OPENLAUNCH_OWNER_TOKEN: owner,
          OPENLAUNCH_AGENT_TOKEN: randomBytes(32).toString("hex"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const send = (origin, host = `127.0.0.1:${port}`) =>
      new Promise((resolve, reject) => {
        const r = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/enrollments",
            method: "POST",
            headers: {
              host,
              origin,
              authorization: `Bearer ${owner}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            let body = "";
            response.on("data", (b) => (body += b));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: JSON.parse(body || "null"),
              }),
            );
          },
        );
        r.on("error", reject);
        r.end(JSON.stringify({ kind: "uno-r4-wifi" }));
      });
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(() => {
          throw Error("bridge exited before ready");
        }),
      ]);
      assert.equal((await send("https://evil.example")).status, 403);
      assert.equal(
        (await send("https://boards.example.com", "evil.example")).status,
        403,
      );
      const result = await send("https://boards.example.com");
      assert.equal(result.status, 201);
      assert.equal(result.headers["x-openlaunch-workspace"], "0".repeat(64));
      assert.equal(result.body.data.token.length, 64);
      assert.equal(
        (await send("https://boards.example.com", "boards.example.com")).status,
        201,
      );
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(dir, { recursive: true, force: true });
    }
  },
);
