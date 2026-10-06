import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { runAgentCli, runLogin } from "../packages/sdk/src/agent-cli.ts";
import {
  writeAgentConfig,
  readAgentConfig,
} from "../packages/sdk/src/agent-config.ts";
import { createClient } from "../packages/sdk/src/index.ts";

const workspace = "a".repeat(64);
const otherWorkspace = "b".repeat(64);
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const connectionId = "123e4567-e89b-42d3-a456-426614174001";
const agentId = "123e4567-e89b-42d3-a456-426614174002";
// The cloud exchange returns a real ol_agent_ token embedding the workspace.
const agentidToken = `ol_agent_${workspace}_${"c".repeat(64)}`;
const otherToken = `ol_agent_${otherWorkspace}_${"c".repeat(64)}`;
const apiToken = `ol_agent_${workspace}_${"b".repeat(64)}`;
// One-time code shape minted by the cloud: ol_login_<workspace64>_<secret43>
const loginCode = `ol_login_${workspace}_${"C".repeat(43)}`;
const invitationCode = "ol_invite_test_code";

function makeOutput(isTTY = false) {
  let text = "";
  return {
    output: { write: (value) => (text += value), isTTY },
    read: () => text,
  };
}

function fakeInput() {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    isPaused: () => false,
    setRawMode(value) {
      this.isRaw = value;
    },
    resume() {},
    pause() {
      this.paused = true;
    },
  });
}

async function withConfig(run) {
  const directory = await mkdtemp(join(tmpdir(), "ol-agentid-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Disposable loopback HTTP fixture; every request is recorded as a hit. */
async function withFixture(routes, run) {
  const { createServer } = await import("node:http");
  const hits = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const hit = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: body ? JSON.parse(body) : undefined,
      };
      hits.push(hit);
      const respond = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const route = routes.find(
        (candidate) =>
          candidate.method === request.method &&
          (candidate.path instanceof RegExp
            ? candidate.path.test(url.pathname)
            : candidate.path === url.pathname),
      );
      if (!route) {
        respond(404, {
          error: { code: "not_found", message: "no fixture route" },
        });
        return;
      }
      try {
        const result = await route.handle(hit, response);
        if (result !== undefined) respond(result.status ?? 200, result.body);
      } catch (error) {
        respond(500, {
          error: { code: "fixture", message: String(error?.message ?? error) },
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ origin, hits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const exchangeData = (token = agentidToken) => ({
  token,
  workspace: token === agentidToken ? workspace : otherWorkspace,
  connectionId,
  expiresAt: Date.now() + 3_600_000,
  access: "read",
  role: "operator",
});

/** A v2 config whose credential embeds its workspace, as the exchange mints. */
const agentidConfig = (url, overrides = {}) => ({
  version: 2,
  mode: "agentid",
  url,
  token: agentidToken,
  workspace,
  connectionId,
  expiresAt: null,
  access: "read",
  role: "operator",
  ...overrides,
});

/** Drives the browser side of a login: follows the printed public URL only. */
const browserStep = async (url) => {
  const parsed = new URL(url);
  await fetch(
    `${parsed.searchParams.get("cli_callback")}?code=${encodeURIComponent(loginCode)}&state=${parsed.searchParams.get("cli_state")}`,
  );
};

test("agentid login completes PKCE, rejects a wrong callback state and saves a private credential", async () => {
  const exchange = { challenge: undefined };
  await withFixture(
    [
      {
        method: "POST",
        path: "/v1/cli-login/exchange",
        handle: (hit) => {
          // PKCE: the verifier's S256 hash must match the challenge in the auth URL.
          const expected = createHash("sha256")
            .update(hit.body.verifier)
            .digest("base64url");
          if (hit.body.code !== loginCode || expected !== exchange.challenge)
            return {
              status: 400,
              body: {
                error: {
                  code: "invalid_grant",
                  message: "PKCE verification failed",
                },
              },
            };
          return { body: { data: exchangeData() } };
        },
      },
    ],
    async ({ origin, hits }) => {
      await withConfig(async (configDirectory) => {
        const output = makeOutput();
        await runLogin(["--agentid", "--url", origin, "--workspace", workspace], {}, {
          configDirectory,
          output: output.output,
          openURL: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.origin, origin);
            assert.equal(parsed.pathname, "/console/");
            assert.equal(parsed.searchParams.get("agentid"), "1");
            assert.equal(parsed.searchParams.get("workspace"), workspace);
            exchange.challenge = parsed.searchParams.get("cli_challenge");
            const state = parsed.searchParams.get("cli_state");
            const callback = parsed.searchParams.get("cli_callback");
            assert.match(exchange.challenge, /^[A-Za-z0-9_-]{43}$/);
            assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            // Wrong callback state: rejected without an exchange attempt.
            const bad = await fetch(
              `${callback}?code=${encodeURIComponent(loginCode)}&state=${"w".repeat(43)}`,
            );
            assert.equal(bad.status, 400);
            assert.doesNotMatch(await bad.text(), /ol_login|verifier|token/i);
            const good = await fetch(
              `${callback}?code=${encodeURIComponent(loginCode)}&state=${state}`,
            );
            assert.equal(good.status, 200);
          },
        });
        assert.equal(hits.length, 1, "wrong state must not trigger an exchange");
        assert.equal(hits[0].body.code, loginCode);
        assert.equal(
          createHash("sha256").update(hits[0].body.verifier).digest("base64url"),
          exchange.challenge,
        );
        const config = await readAgentConfig(configDirectory);
        assert.deepEqual(config, agentidConfig(origin, { expiresAt: config.expiresAt }));
        assert.equal(config.token, agentidToken);
        assert.equal(config.workspace, workspace);
        assert.equal((await stat(configDirectory)).mode & 0o777, 0o700);
        assert.equal(
          (await stat(join(configDirectory, "agent.json"))).mode & 0o777,
          0o600,
        );
        assert.doesNotMatch(
          output.read(),
          new RegExp(agentidToken),
          "token must not be logged",
        );
        assert.doesNotMatch(output.read(), /ol_login_/);
      });
    },
  );
});

test("an exchange for a different workspace is rejected and leaves the saved credential untouched", async () => {
  await withFixture(
    [
      {
        method: "POST",
        path: "/v1/cli-login/exchange",
        handle: () => ({ body: { data: exchangeData(otherToken) } }),
      },
    ],
    async ({ origin }) => {
      await withConfig(async (configDirectory) => {
        const existing = agentidConfig("https://www.openlaunch.dev");
        await writeAgentConfig(existing, configDirectory);
        await assert.rejects(
          runLogin(["--agentid", "--url", origin, "--workspace", workspace], {}, {
            configDirectory,
            output: makeOutput().output,
            openURL: browserStep,
          }),
          /instead of the requested workspace/,
        );
        assert.deepEqual(await readAgentConfig(configDirectory), existing);
      });
    },
  );
});

test("failed exchange (HTTP error or redirect) never overwrites a saved credential", async () => {
  await withConfig(async (configDirectory) => {
    const existing = {
      version: 1,
      url: "https://www.openlaunch.dev",
      token: apiToken,
    };
    await writeAgentConfig(existing, configDirectory);
    // First run: exchange returns 500.
    await withFixture(
      [
        {
          method: "POST",
          path: "/v1/cli-login/exchange",
          handle: () => ({
            status: 500,
            body: {
              error: { code: "upstream", message: "exchange unavailable" },
            },
          }),
        },
      ],
      async ({ origin }) => {
        await assert.rejects(
          runLogin(["--agentid", "--url", origin], {}, {
            configDirectory,
            output: makeOutput().output,
            openURL: browserStep,
          }),
          /Login exchange failed/,
        );
      },
    );
    // Second run: exchange answers with a redirect; forwarding is forbidden.
    await withFixture(
      [
        {
          method: "POST",
          path: "/v1/cli-login/exchange",
          handle: (_hit, response) => {
            response.writeHead(302, { location: "https://attacker.test/" });
            response.end();
          },
        },
      ],
      async ({ origin }) => {
        await assert.rejects(
          runLogin(["--agentid", "--url", origin], {}, {
            configDirectory,
            output: makeOutput().output,
            openURL: browserStep,
          }),
          /Could not reach the openlaunch login exchange endpoint/,
        );
      },
    );
    assert.deepEqual(await readAgentConfig(configDirectory), existing);
  });
});

test("timeout closes the callback server and saves nothing", async () => {
  await withFixture([], async ({ origin }) => {
    await withConfig(async (configDirectory) => {
      const output = makeOutput();
      await assert.rejects(
        runLogin(["--agentid", "--url", origin], {}, {
          configDirectory,
          output: output.output,
          timeoutMs: 200,
          // Tests must never open a real browser; the opener is stubbed.
          openURL: async () => {},
        }),
        /timed out/i,
      );
      const authUrl = output
        .read()
        .split("\n")
        .find((line) => line.startsWith("http"));
      const callback = new URL(authUrl).searchParams.get("cli_callback");
      await assert.rejects(
        fetch(callback),
        (error) => (error?.cause?.code ?? error?.code) === "ECONNREFUSED",
      );
      assert.equal(await readAgentConfig(configDirectory), undefined);
    });
  });
});

test("--no-open prints only the public auth URL with no secrets", async () => {
  await withFixture([], async ({ origin }) => {
    await withConfig(async (configDirectory) => {
      const output = makeOutput();
      await assert.rejects(
        runLogin(["--agentid", "--url", origin, "--no-open"], {}, {
          configDirectory,
          output: output.output,
          timeoutMs: 200,
        }),
        /timed out/i,
      );
      const printed = output.read();
      const authUrl = new URL(
        printed.split("\n").find((line) => line.startsWith("http")),
      );
      assert.equal(authUrl.origin, origin);
      assert.equal(authUrl.pathname, "/console/");
      assert.equal(authUrl.searchParams.get("agentid"), "1");
      for (const key of ["cli_callback", "cli_state", "cli_challenge"])
        assert.ok(authUrl.searchParams.get(key), `${key} must be present`);
      assert.doesNotMatch(printed, /code=|verifier|token|ol_login/i);
    });
  });
});

test("manual ol login --token stays compatible and saves a private v1 credential", async () => {
  await withFixture(
    [
      {
        method: "GET",
        path: "/v1/functions",
        handle: () => ({ body: { data: [] } }),
      },
    ],
    async ({ origin, hits }) => {
      await withConfig(async (configDirectory) => {
        const output = makeOutput();
        await runLogin(["--url", origin, "--token", apiToken], {}, {
          configDirectory,
          output: output.output,
        });
        assert.equal(hits.length, 1);
        assert.equal(hits[0].path, "/v1/functions");
        assert.equal(hits[0].headers.authorization, `Bearer ${apiToken}`);
        assert.deepEqual(await readAgentConfig(configDirectory), {
          version: 1,
          url: origin,
          token: apiToken,
        });
        assert.equal(
          (await stat(join(configDirectory, "agent.json"))).mode & 0o777,
          0o600,
        );
        assert.doesNotMatch(output.read(), /ol_agent_/);
      });
    },
  );
});

test("a saved AgentID login runs status and devices with its embedded workspace binding", async () => {
  await withFixture(
    [
      {
        method: "GET",
        path: "/v1/account",
        handle: () => ({ body: { data: { workspace } } }),
      },
      {
        method: "GET",
        path: "/v1/devices",
        handle: () => ({ body: { data: [{ id: deviceId, name: "bench" }] } }),
      },
    ],
    async ({ origin, hits }) => {
      await withConfig(async (configDirectory) => {
        await writeAgentConfig(agentidConfig(origin), configDirectory);
        for (const args of [["status"], ["devices", "list"]]) {
          const output = makeOutput();
          await runAgentCli(args, {}, output.output, { configDirectory });
          const hit = hits.at(-1);
          assert.equal(hit.method, "GET");
          assert.equal(hit.path, args[0] === "status" ? "/v1/account" : "/v1/devices");
          assert.equal(hit.headers.authorization, `Bearer ${agentidToken}`);
          assert.equal(hit.headers["x-openlaunch-workspace"], workspace);
          assert.equal(hit.headers["x-openlaunch-target-workspace"], undefined);
          if (args[0] === "devices")
            assert.equal(JSON.parse(output.read())[0].id, deviceId);
        }
      });
    },
  );
});

test("v2 management commands keep API-token workspace routing and contract bodies", async () => {
  await withFixture(
    [
      { method: "GET", path: "/v1/account", handle: () => ({ body: { data: { workspace } } }) },
      { method: "GET", path: "/v1/onboarding", handle: () => ({ body: { data: {} } }) },
      { method: "GET", path: "/v1/access", handle: () => ({ body: { data: {} } }) },
      { method: "GET", path: "/v1/access-policies", handle: () => ({ body: { data: [] } }) },
      { method: "POST", path: "/v1/access-policies", handle: () => ({ body: { data: {} } }) },
      { method: "GET", path: "/v1/workspace/agents", handle: () => ({ body: { data: [] } }) },
      { method: "POST", path: "/v1/workspace/invitations", handle: () => ({ body: { data: { invitation: invitationCode } } }) },
      { method: "POST", path: new RegExp(`^/v1/workspace/agents/${agentId}/revoke$`), handle: () => ({ body: { data: {} } }) },
      { method: "GET", path: "/v1/workspaces", handle: () => ({ body: { data: [] } }) },
      { method: "POST", path: "/v1/workspaces/accept", handle: () => ({ body: { data: { workspace: otherWorkspace } } }) },
      { method: "POST", path: "/v1/device-setup-tokens", handle: () => ({ body: { data: { id: connectionId, token: "ol_sdk_x" } } }) },
      { method: "GET", path: "/v1/agent-connections", handle: () => ({ body: { data: [] } }) },
      { method: "POST", path: "/v1/agent-connections", handle: () => ({ body: { data: { id: connectionId, token: "ol_agent_x" } } }) },
      { method: "POST", path: new RegExp(`^/v1/agent-connections/${connectionId}/revoke$`), handle: () => ({ body: { data: {} } }) },
      { method: "POST", path: new RegExp(`^/v1/devices/${deviceId}/revoke$`), handle: () => ({ body: { data: {} } }) },
    ],
    async ({ origin, hits }) => {
      await withConfig(async (configDirectory) => {
        await writeAgentConfig(
          agentidConfig(origin, { role: "administrator" }),
          configDirectory,
        );
        const policy = {
          delegatedFrom: "parent-agent",
          principal: "ol_agent_connection",
          mode: "all",
          excludedDevices: [deviceId],
          excludedFunctions: [{ deviceId: null, capability: "custom.clean" }],
          role: "operator",
          expiresAt: null,
        };
        const cases = [
          { args: ["status"], method: "GET", path: "/v1/account" },
          { args: ["onboarding"], method: "GET", path: "/v1/onboarding" },
          { args: ["access"], method: "GET", path: "/v1/access" },
          { args: ["access", "policies"], method: "GET", path: "/v1/access-policies" },
          {
            args: ["access", "set", JSON.stringify(policy)],
            method: "POST",
            path: "/v1/access-policies",
            body: policy,
          },
          { args: ["agents", "list"], method: "GET", path: "/v1/workspace/agents" },
          {
            args: ["agents", "invite", "Codex"],
            method: "POST",
            path: "/v1/workspace/invitations",
            body: { name: "Codex", role: "operator", ttlSeconds: 600 },
          },
          {
            args: ["agents", "invite", "Codex", "--role", "administrator", "--ttl", "120"],
            method: "POST",
            path: "/v1/workspace/invitations",
            body: { name: "Codex", role: "administrator", ttlSeconds: 120 },
          },
          {
            args: ["agents", "revoke", agentId],
            method: "POST",
            path: `/v1/workspace/agents/${agentId}/revoke`,
          },
          { args: ["workspace", "list"], method: "GET", path: "/v1/workspaces" },
          {
            args: ["setup", "token", "bench"],
            method: "POST",
            path: "/v1/device-setup-tokens",
            body: { name: "bench", ttlSeconds: 600 },
          },
          { args: ["connections", "list"], method: "GET", path: "/v1/agent-connections" },
          {
            args: ["connections", "create", "helper"],
            method: "POST",
            path: "/v1/agent-connections",
            body: { name: "helper", ttlSeconds: 86400, access: "act" },
          },
          {
            args: ["connections", "revoke", connectionId],
            method: "POST",
            path: `/v1/agent-connections/${connectionId}/revoke`,
          },
          {
            args: ["devices", "revoke", deviceId],
            method: "POST",
            path: `/v1/devices/${deviceId}/revoke`,
          },
        ];
        for (const testCase of cases) {
          const output = makeOutput();
          await runAgentCli(testCase.args, {}, output.output, {
            configDirectory,
          });
          const hit = hits.at(-1);
          assert.equal(hit.method, testCase.method, testCase.args.join(" "));
          assert.equal(hit.path, testCase.path);
          if (testCase.body) assert.deepEqual(hit.body, testCase.body);
          else assert.equal(hit.body, undefined);
          assert.equal(
            hit.headers.authorization,
            `Bearer ${agentidToken}`,
            testCase.args.join(" "),
          );
          // API tokens are always workspace-bound: embedded header, no selector.
          assert.equal(
            hit.headers["x-openlaunch-workspace"],
            workspace,
            testCase.args.join(" "),
          );
          assert.equal(
            hit.headers["x-openlaunch-target-workspace"],
            undefined,
            testCase.args.join(" "),
          );
        }
        // The invitation code is shown once in the terminal output.
        const inviteOutput = makeOutput();
        await runAgentCli(["agents", "invite", "Codex"], {}, inviteOutput.output, {
          configDirectory,
        });
        assert.match(inviteOutput.read(), new RegExp(invitationCode));
        // Invalid policy JSON is rejected locally without an HTTP request.
        const before = hits.length;
        await assert.rejects(
          runAgentCli(
            ["access", "set", JSON.stringify({ ...policy, mode: "weird" })],
            {},
            makeOutput().output,
            { configDirectory },
          ),
          /mode must be/,
        );
        assert.equal(hits.length, before);
        const sdk = createClient({ url: origin, token: agentidToken });
        await sdk.createDeviceSetupToken();
        assert.deepEqual(hits.at(-1).body, { name: "Device setup" });
      });
    },
  );
});

test("workspace selector is reserved for identity-bound tokens, not API tokens", () => {
  // API tokens: equal embedded workspace is accepted but sends no selector.
  const equal = createClient({
    url: "https://api.example.test",
    token: apiToken,
    targetWorkspace: workspace,
  });
  assert.equal(typeof equal.listDevices, "function");
  // API tokens: a different workspace is rejected with an actionable error.
  assert.throws(
    () =>
      createClient({
        url: "https://api.example.test",
        token: apiToken,
        targetWorkspace: otherWorkspace,
      }),
    /ol login --agentid --workspace/,
  );
  assert.throws(
    () =>
      createClient({
        url: "https://api.example.test",
        token: apiToken,
        targetWorkspace: "nothex",
      }),
    /64-character/,
  );
});

test("identity-bound OAuth bearer tokens send the target workspace selector", async () => {
  let seen;
  const fetchImpl = async (input, init) => {
    seen = new Request(input, init);
    return Response.json({ data: [] });
  };
  const client = createClient({
    url: "https://api.example.test",
    token: "oauth-bearer-credential",
    targetWorkspace: otherWorkspace,
    fetch: fetchImpl,
  });
  await client.listWorkspaceAgents();
  assert.equal(
    seen.headers.get("x-openlaunch-target-workspace"),
    otherWorkspace,
  );
  await client.acceptWorkspaceInvitation(invitationCode);
  assert.equal(seen.headers.get("x-openlaunch-target-workspace"), null);
});

test("ol workspace join prompts for the private code and joins without a workspace selector", async () => {
  await withFixture(
    [
      {
        method: "POST",
        path: "/v1/workspaces/accept",
        handle: () => ({ body: { data: { workspace: otherWorkspace } } }),
      },
    ],
    async ({ origin, hits }) => {
      await withConfig(async (configDirectory) => {
        await writeAgentConfig(agentidConfig(origin), configDirectory);
        const input = fakeInput();
        const output = makeOutput(true);
        const pending = runAgentCli(["workspace", "join"], {}, output.output, {
          configDirectory,
          input,
        });
        while (input.listenerCount("data") === 0)
          await new Promise((resolve) => setImmediate(resolve));
        input.emit("data", Buffer.from(`${invitationCode}\n`));
        await pending;
        const hit = hits.at(-1);
        assert.deepEqual(hit.body, { invitation: invitationCode });
        assert.equal(hit.headers["x-openlaunch-target-workspace"], undefined);
        assert.doesNotMatch(output.read(), new RegExp(invitationCode));
        assert.match(
          output.read(),
          new RegExp(`ol login --agentid --workspace ${otherWorkspace}`),
        );
      });
    },
  );
});

test("API-token logins cannot join a workspace and keep the legacy header", async () => {
  await withConfig(async (configDirectory) => {
    await writeAgentConfig(
      { version: 1, url: "https://www.openlaunch.dev", token: apiToken },
      configDirectory,
    );
    await assert.rejects(
      runAgentCli(["workspace", "join"], {}, makeOutput().output, {
        configDirectory,
      }),
      /AgentID login/,
    );
    // Legacy routing is unchanged: the embedded workspace header is sent.
    let seen;
    const fetchImpl = async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ data: [] });
    };
    await runAgentCli(
      ["devices", "list"],
      {
        OPENLAUNCH_AGENT_TOKEN: apiToken,
        OPENLAUNCH_URL: "https://api.example.test",
        OPENLAUNCH_WORKSPACE: workspace,
      },
      makeOutput().output,
      { fetch: fetchImpl },
    );
    assert.equal(seen.headers.get("x-openlaunch-workspace"), workspace);
    assert.equal(seen.headers.get("x-openlaunch-target-workspace"), null);
    // A cross-workspace environment override is refused with an actionable error.
    await assert.rejects(
      runAgentCli(
        ["devices", "list"],
        {
          OPENLAUNCH_AGENT_TOKEN: apiToken,
          OPENLAUNCH_URL: "https://api.example.test",
          OPENLAUNCH_WORKSPACE: otherWorkspace,
        },
        makeOutput().output,
        { fetch: fetchImpl },
      ),
      /ol login --agentid --workspace/,
    );
  });
});
