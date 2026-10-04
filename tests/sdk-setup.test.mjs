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
const sdkToken = `ol_sdk_${workspace}_${"c".repeat(64)}`;
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

test("SDK setup resumes an uncertain attach with its saved request ID and never saves the SDK token", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-sdk-setup-"));
  try {
    const directory = join(root, "my-device");
    const calls = [];
    let outputText = "";
    const output = {
      write(value) {
        outputText += value;
      },
    };
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const pending = JSON.parse(
        await readFile(join(directory, ".setup-pending.json"), "utf8"),
      );
      assert.equal(pending.workspace, workspace);
      assert.equal("token" in pending, false);
      assert.equal(JSON.stringify(pending).includes(sdkToken), false);
      assert.equal(
        (await stat(join(directory, ".setup-pending.json"))).mode & 0o777,
        0o600,
      );
      if (calls.length === 1) throw new Error("response lost after attach");
      return Response.json(
        { data: { deviceId, token: "private-device-credential" } },
        { status: 201 },
      );
    };
    const setupArgs = {
      directory,
      name: "Workshop sensor",
      url: "https://devices.example",
      sdkToken,
      enrollOnly: true,
      fetch,
      output,
    };
    await assert.rejects(setupDevice(setupArgs), /could not be completed/);
    const pending = JSON.parse(
      await readFile(join(directory, ".setup-pending.json"), "utf8"),
    );
    assert.match(pending.requestId, /^[0-9a-f-]{36}$/i);
    await assert.rejects(readFile(join(directory, "identity.json")), {
      code: "ENOENT",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://devices.example/v1/sdk/devices");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${sdkToken}`);

    await setupDevice({ ...setupArgs, name: undefined });
    assert.equal(calls.length, 2);
    assert.deepEqual(
      JSON.parse(calls[0].init.body),
      JSON.parse(calls[1].init.body),
    );
    assert.equal(JSON.parse(calls[1].init.body).requestId, pending.requestId);
    const identity = JSON.parse(
      await readFile(join(directory, "identity.json"), "utf8"),
    );
    assert.equal(identity.credential, "private-device-credential");
    assert.equal(identity.workspace, workspace);
    assert.equal(JSON.stringify(identity).includes(sdkToken), false);
    await assert.rejects(readFile(join(directory, ".setup-pending.json")), {
      code: "ENOENT",
    });
    assert.equal(outputText.includes(sdkToken), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK setup preserves pending state when owner attachment quota rejects the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "openlaunch-sdk-quota-"));
  try {
    const directory = join(root, "my-device");
    await assert.rejects(
      setupDevice({
        directory,
        sdkToken,
        url: "https://devices.example",
        enrollOnly: true,
        output: { write() {} },
        fetch: async () =>
          Response.json(
            {
              error: { code: "device_limit", message: "private server detail" },
            },
            { status: 429 },
          ),
      }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "device_limit");
        assert.equal(error.message.includes("private server detail"), false);
        return true;
      },
    );
    const pending = JSON.parse(
      await readFile(join(directory, ".setup-pending.json"), "utf8"),
    );
    assert.match(pending.requestId, /^[0-9a-f-]{36}$/i);
    await assert.rejects(readFile(join(directory, "identity.json")), {
      code: "ENOENT",
    });
    assert.equal(JSON.stringify(pending).includes(sdkToken), false);
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
        return Response.json({
          data: {
            ...action,
            id: reports.at(-1).actionId,
            status: reports.at(-1).status,
            result: reports.at(-1).result,
          },
        });
      }
      throw new Error("Unexpected request");
    };
    await runDevice({
      directory: root,
      events: false,
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

 test("custom setup rejects legacy agent tokens before attachment or saving identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-legacy-"));
  let calls = 0;
  try {
    await assert.rejects(setupDevice({
      directory, name: "Test device", url: "https://devices.example",
      sdkToken: sdkToken.replace("ol_sdk_", "ol_agent_"), enrollOnly: true,
      fetch: async () => { calls++; throw new Error("unexpected network request"); },
      output: { write() {} },
    }), /agent tokens cannot pair devices/);
    assert.equal(calls, 0);
    await assert.rejects(stat(join(directory, "identity.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
