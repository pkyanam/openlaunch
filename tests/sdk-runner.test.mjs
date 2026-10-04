import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDevice } from "../packages/sdk/src/cli.ts";

const workspace = "a".repeat(64);
const deviceId = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-journal-"));
  const manifest = {
    name: "journal test",
    kind: "custom.device",
    capabilities: ["custom.echo"],
  };
  await writeFile(
    join(directory, "identity.json"),
    JSON.stringify({
      url: "https://devices.example",
      workspace,
      deviceId,
      credential: "private",
      manifest,
    }),
  );
  await writeFile(
    join(directory, "adapter.mjs"),
    `export const manifest = ${JSON.stringify(manifest)}; export const handlers = { "custom.echo": async (args) => { globalThis.__openlaunchHandlerRuns = (globalThis.__openlaunchHandlerRuns ?? 0) + 1; return { echoed: args.text }; } };`,
  );
  return directory;
}

const action = {
  id: "22222222-2222-4222-8222-222222222222",
  deviceId,
  capability: "custom.echo",
  args: { text: "hello" },
  status: "queued",
  createdAt: Date.now(),
  expiresAt: Date.now() + 30_000,
};

test("CLI help runs when invoked through the npm bin symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openlaunch-bin-link-"));
  try {
    const cli = fileURLToPath(
      new URL("../packages/sdk/src/cli.ts", import.meta.url),
    );
    const link = join(directory, "openlaunch-device");
    await symlink(cli, link);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", link, "--help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /openlaunch-device setup/);
    assert.match(result.stdout, /openlaunch-device publish/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner retries a saved result without executing its handler again", async () => {
  const directory = await fixture();
  try {
    globalThis.__openlaunchHandlerRuns = 0;
    const submitted = [];
    const sequence = [];
    let resultAttempts = 0;
    let polls = 0;
    await runDevice({
      directory,
      events: false,
      pollMs: 0,
      input: { isTTY: false },
      output: { write() {} },
      fetch: async (url, init) => {
        if (String(url).endsWith("/next")) {
          polls++;
          sequence.push("next");
          return Response.json({ data: polls === 1 ? action : null });
        }
        if (String(url).endsWith("/result")) {
          const body = JSON.parse(init.body);
          submitted.push(body);
          resultAttempts++;
          sequence.push(`result-${resultAttempts}`);
          if (resultAttempts === 1)
            throw new Error("temporary network failure");
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({
            data: { ...action, status: body.status, result: body.result },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    assert.equal(submitted.length, 2);
    assert.equal(polls, 2);
    assert.ok(sequence.indexOf("result-2") < sequence.lastIndexOf("next"));
    assert.equal(globalThis.__openlaunchHandlerRuns, 1);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.deepEqual(submitted[1], {
      actionId: action.id,
      status: "succeeded",
      result: { echoed: "hello" },
    });
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.deepEqual(journal[action.id], {
      state: "completed",
      expiresAt: action.expiresAt,
      acknowledged: true,
      outcome: { status: "succeeded", result: { echoed: "hello" } },
    });
  } finally {
    delete globalThis.__openlaunchHandlerRuns;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner reports outcome_unknown after restart without replaying a pending action", async () => {
  const directory = await fixture();
  try {
    globalThis.__openlaunchHandlerRuns = 0;
    await writeFile(
      join(directory, ".actions.json"),
      JSON.stringify({
        [action.id]: {
          state: "pending",
          expiresAt: action.expiresAt,
          acknowledged: false,
        },
      }),
      { mode: 0o600 },
    );
    const submitted = [];
    const sequence = [];
    let polls = 0;
    await assert.rejects(
      runDevice({
        directory,
        events: false,
        pollMs: 0,
        input: { isTTY: false },
        output: { write() {} },
        fetch: async (url, init) => {
          if (String(url).endsWith("/next")) {
            polls++;
            sequence.push("next");
            return Response.json({ data: null });
          }
          if (String(url).endsWith("/result")) {
            sequence.push("result");
            submitted.push(JSON.parse(init.body));
            return Response.json({
              data: {
                ...action,
                status: "failed",
                result: { code: "outcome_unknown" },
              },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      }),
      /Interrupted action outcome is unknown/,
    );
    assert.deepEqual(submitted, [
      {
        actionId: action.id,
        status: "failed",
        result: { code: "outcome_unknown" },
      },
    ]);
    assert.equal(globalThis.__openlaunchHandlerRuns, 0);
    assert.equal(polls, 0);
    assert.deepEqual(sequence, ["result"]);
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.deepEqual(journal[action.id], {
      state: "completed",
      expiresAt: action.expiresAt,
      acknowledged: true,
      recoveryRequired: true,
      outcome: { status: "failed", result: { code: "outcome_unknown" } },
    });
  } finally {
    delete globalThis.__openlaunchHandlerRuns;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner leaves expired result delivery unacknowledged and reports uncertainty", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, ".actions.json"),
      JSON.stringify({
        [action.id]: {
          state: "completed",
          expiresAt: Date.now() - 1,
          acknowledged: false,
          outcome: { status: "succeeded", result: { echoed: "hello" } },
        },
      }),
      { mode: 0o600 },
    );
    let message = "";
    await runDevice({
      directory,
      events: false,
      pollMs: 0,
      input: { isTTY: false },
      output: {
        write(value) {
          message += value;
        },
      },
      fetch: async (url) => {
        if (String(url).endsWith("/result"))
          throw new Error("expired outcomes must not be uploaded");
        if (String(url).endsWith("/next")) {
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({ data: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    assert.match(
      message,
      /expired before its result was acknowledged; its outcome remains unconfirmed/,
    );
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.equal(journal[action.id].acknowledged, false);
    assert.equal(journal[action.id].terminal, "expired");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner records terminal result rejection and does not retry it", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, ".actions.json"),
      JSON.stringify({
        [action.id]: {
          state: "completed",
          expiresAt: action.expiresAt,
          acknowledged: false,
          outcome: { status: "succeeded", result: { echoed: "hello" } },
        },
      }),
      { mode: 0o600 },
    );
    let resultAttempts = 0;
    let message = "";
    await runDevice({
      directory,
      events: false,
      pollMs: 0,
      input: { isTTY: false },
      output: {
        write(value) {
          message += value;
        },
      },
      fetch: async (url) => {
        if (String(url).endsWith("/result")) {
          resultAttempts++;
          return Response.json(
            { error: { code: "invalid_action" } },
            { status: 400 },
          );
        }
        if (String(url).endsWith("/next")) {
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({ data: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    assert.equal(resultAttempts, 1);
    assert.match(message, /HTTP 400.*outcome remains unconfirmed/);
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.equal(journal[action.id].acknowledged, false);
    assert.equal(journal[action.id].terminal, "http_400");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner retains a mismatched receipt and halts before new commands", async () => {
  for (const patch of [
    { id: "33333333-3333-4333-8333-333333333333" },
    { status: "failed" },
    { result: { echoed: "different" } },
    { result: undefined },
  ]) {
    const directory = await fixture();
    try {
      const outcome = { status: "succeeded", result: { echoed: "hello" } };
      const entry = {
        state: "completed",
        expiresAt: Date.now() + 30000,
        acknowledged: false,
        outcome,
      };
      await writeFile(
        join(directory, ".actions.json"),
        JSON.stringify({ [action.id]: entry }),
        { mode: 0o600 },
      );
      let polls = 0;
      await assert.rejects(
        runDevice({
          directory,
          events: false,
          pollMs: 0,
          input: { isTTY: false },
          output: { write() {} },
          fetch: async (url) => {
            if (String(url).endsWith("/next")) {
              polls++;
              return Response.json({ data: null });
            }
            return Response.json({ data: { ...action, ...outcome, ...patch } });
          },
        }),
        /Result receipt does not match/,
      );
      assert.equal(polls, 0);
      const journal = JSON.parse(
        await readFile(join(directory, ".actions.json"), "utf8"),
      );
      assert.deepEqual(journal[action.id], entry);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("runner accepts semantically equal receipt objects with reordered keys", async () => {
  const directory = await fixture();
  try {
    const entry = {
      state: "completed",
      expiresAt: Date.now() + 30000,
      acknowledged: false,
      outcome: {
        status: "succeeded",
        result: { first: 1, nested: { a: true, b: [2, 3] } },
      },
    };
    await writeFile(
      join(directory, ".actions.json"),
      JSON.stringify({ [action.id]: entry }),
      { mode: 0o600 },
    );
    let polls = 0;
    await runDevice({
      directory,
      events: false,
      pollMs: 0,
      input: { isTTY: false },
      output: { write() {} },
      fetch: async (url) => {
        if (String(url).endsWith("/next")) {
          polls++;
          queueMicrotask(() => process.emit("SIGINT"));
          return Response.json({ data: null });
        }
        return Response.json({
          data: {
            ...action,
            status: "succeeded",
            result: { nested: { b: [2, 3], a: true }, first: 1 },
          },
        });
      },
    });
    assert.equal(polls, 1);
    const journal = JSON.parse(
      await readFile(join(directory, ".actions.json"), "utf8"),
    );
    assert.equal(journal[action.id].acknowledged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("previously acknowledged unknown outcomes still block new intake on restart", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, ".actions.json"),
      JSON.stringify({
        [action.id]: {
          state: "completed",
          expiresAt: Date.now() + 30000,
          acknowledged: true,
          outcome: { status: "failed", result: { code: "outcome_unknown" } },
        },
      }),
      { mode: 0o600 },
    );
    let requests = 0;
    await assert.rejects(
      runDevice({
        directory,
        events: false,
        pollMs: 0,
        input: { isTTY: false },
        output: { write() {} },
        fetch: async () => {
          requests++;
          throw new Error("Unknown execution must not request new work");
        },
      }),
      /Interrupted action outcome is unknown/,
    );
    assert.equal(requests, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
