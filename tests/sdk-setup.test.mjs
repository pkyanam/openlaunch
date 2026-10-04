import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  normalizeOrigin,
  publishAdapter,
  runDevice,
  setupDevice,
} from "../packages/sdk/src/cli.ts";

const workspace = "a".repeat(64);
const enrollmentToken = "b".repeat(64);
const deviceId = "11111111-1111-4111-8111-111111111111";

test("custom adapter setup accepts only a bare secure service origin", () => {
  assert.equal(
    normalizeOrigin("https://devices.example/"),
    "https://devices.example",
  );
  assert.equal(
    normalizeOrigin("http://localhost:8787"),
    "http://localhost:8787",
  );
  for (const value of [
    "http://devices.example",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?token=x",
  ]) {
    assert.throws(() => normalizeOrigin(value), /bare HTTPS origin/);
  }
});

test("setup enrolls a health-only generic adapter and stores its private credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-cli-"));
  try {
    const directory = join(root, "my-device");
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        { data: { deviceId, token: "private-device-credential" } },
        { status: 201 },
      );
    };
    const output = { write() {} };
    const result = await setupDevice({
      directory,
      name: "Workshop sensor",
      url: "https://devices.example",
      workspace,
      enrollmentToken,
      enrollOnly: true,
      fetch,
      output,
    });
    assert.equal(result.deviceId, deviceId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://devices.example/v1/device/enroll");
    assert.equal(calls[0].init.headers.authorization, undefined);
    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.token, enrollmentToken);
    assert.deepEqual(payload.manifest, {
      name: "Workshop sensor",
      kind: "custom.device",
      capabilities: ["device.health"],
    });
    const identity = JSON.parse(
      await readFile(join(directory, "identity.json"), "utf8"),
    );
    assert.equal(identity.credential, "private-device-credential");
    assert.equal(identity.deviceId, deviceId);
    assert.equal(
      (await stat(join(directory, "identity.json"))).mode & 0o777,
      0o600,
    );
    const ignored = (
      await readFile(join(directory, ".gitignore"), "utf8")
    ).split("\n");
    assert(ignored.includes("identity.json"));
    assert(ignored.includes(".identity.*.tmp"));
    assert.match(
      await readFile(join(directory, "adapter.mjs"), "utf8"),
      /adapter_online/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup never overwrites existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-cli-"));
  try {
    const directory = join(root, "existing");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
    await writeFile(join(directory, "adapter.mjs"), "user data");
    await assert.rejects(
      setupDevice({
        directory,
        workspace,
        enrollmentToken,
        noStart: true,
        output: { write() {} },
      }),
      /Refusing to overwrite/,
    );
    assert.equal(
      await readFile(join(directory, "adapter.mjs"), "utf8"),
      "user data",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI help and run commands parse as subcommands in real Node processes", async () => {
  const cli = fileURLToPath(
    new URL("../packages/sdk/src/cli.ts", import.meta.url),
  );
  const help = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /openlaunch-device publish/);
  const root = await mkdtemp(join(tmpdir(), "openlaunch-cli-"));
  try {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "run", "--directory", root],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /identity\.json/);
    assert.doesNotMatch(run.stderr, /Unknown option: run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner invokes only a manifest-advertised handler and reports its result", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-cli-"));
  try {
    const manifest = {
      name: "test adapter",
      kind: "custom.device",
      capabilities: ["custom.echo"],
      functions: [
        {
          name: "custom.echo",
          title: "Echo",
          description: "Echo input",
          access: "read",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", maxLength: 20 } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    };
    await writeFile(
      join(root, "identity.json"),
      JSON.stringify({
        url: "https://devices.example",
        workspace,
        deviceId,
        credential: "private",
        manifest,
      }),
    );
    await writeFile(
      join(root, "adapter.mjs"),
      `export const manifest = ${JSON.stringify(manifest)}; export const handlers = { "custom.echo": async (args) => ({ echoed: args.text }) };`,
    );
    const action = {
      id: "22222222-2222-4222-8222-222222222222",
      deviceId,
      capability: "custom.echo",
      args: { text: "hello" },
      status: "queued",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    const unadvertised = {
      ...action,
      id: "33333333-3333-4333-8333-333333333333",
      capability: "custom.hidden",
    };
    const reports = [];
    let nextCount = 0;
    const fetch = async (url, init) => {
      if (String(url).endsWith("/next"))
        return Response.json({
          data: nextCount++ === 0 ? unadvertised : action,
        });
      if (String(url).endsWith("/result")) {
        reports.push(JSON.parse(init.body));
        if (reports.length === 2) queueMicrotask(() => process.emit("SIGINT"));
        return Response.json({ data: { ...action, status: "succeeded" } });
      }
      throw new Error("Unexpected request");
    };
    await runDevice({
      directory: root,
      fetch,
      pollMs: 0,
      input: { isTTY: false },
      output: { write() {} },
    });
    assert.equal(reports.length, 2);
    assert.equal(reports[0].status, "failed");
    assert.deepEqual(reports[0].result, { code: "unsupported_capability" });
    assert.equal(reports[1].status, "succeeded");
    assert.deepEqual(reports[1].result, { echoed: "hello" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish updates capabilities without re-enrollment and asks owner to grant them", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-cli-"));
  try {
    const manifest = {
      name: "test adapter",
      kind: "custom.device",
      capabilities: ["device.health"],
    };
    const updated = {
      name: "test adapter",
      kind: "custom.device",
      capabilities: ["device.health", "custom.echo"],
      functions: [
        {
          name: "custom.echo",
          title: "Echo",
          description: "Echo input",
          access: "read",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    };
    await writeFile(
      join(root, "identity.json"),
      JSON.stringify({
        url: "https://devices.example",
        workspace,
        deviceId,
        credential: "private",
        manifest,
      }),
    );
    await writeFile(
      join(root, "adapter.mjs"),
      `export const manifest = ${JSON.stringify(updated)}; export const handlers = { "device.health": async () => ({ status: "adapter_online" }), "custom.echo": async () => ({}) };`,
    );
    const calls = [];
    const output = {
      text: "",
      write(value) {
        this.text += value;
      },
    };
    await publishAdapter({
      directory: root,
      output,
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return Response.json({ data: { ok: true, grantsRevoked: true } });
      },
    });
    assert.match(calls[0].url, new RegExp(`/v1/device/${deviceId}/manifest$`));
    assert.deepEqual(calls[0].body, { manifest: updated });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "identity.json"), "utf8")).manifest,
      updated,
    );
    assert.match(output.text, /grant the desired capabilities/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
