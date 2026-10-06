import test from "node:test";
import assert from "node:assert/strict";
import {
  agentIdCarryPath,
  readCliRequest,
  cliRequestProblem,
} from "../apps/web/src/workspace.ts";

test("AgentID redirects retain CLI handshake and workspace without corrupting callback parameters", () => {
  const prior = globalThis.window;
  globalThis.window = { location: { origin: "https://www.openlaunch.dev" } };
  try {
    const search = new URLSearchParams({
      agentid: "1",
      cli_callback: "http://127.0.0.1:49152/callback",
      cli_state: "s".repeat(43),
      cli_challenge: "c".repeat(43),
      workspace: "a".repeat(64),
    });
    const callback = new URL(
      agentIdCarryPath("/console/?sso=callback", "?" + search),
      window.location.origin,
    );
    assert.equal(callback.searchParams.get("sso"), "callback");
    assert.equal(callback.searchParams.get("workspace"), "a".repeat(64));
    assert.deepEqual(readCliRequest(callback.searchParams), {
      callbackUrl: "http://127.0.0.1:49152/callback",
      state: "s".repeat(43),
      challenge: "c".repeat(43),
      workspace: "a".repeat(64),
    });
    assert.equal(
      cliRequestProblem(readCliRequest(callback.searchParams)),
      null,
    );
  } finally {
    globalThis.window = prior;
  }
});

test("partial CLI links and callback aliases fail before sign-in or consent", () => {
  assert.ok(
    cliRequestProblem(
      readCliRequest(
        new URLSearchParams({ agentid: "1", cli_state: "partial" }),
      ),
    ),
  );
  const request = {
    callbackUrl: "http://127.0.0.1:49152/callback",
    state: "s".repeat(43),
    challenge: "c".repeat(43),
  };
  for (const callbackUrl of [
    "http://localhost:49152/callback",
    "http://2130706433:49152/callback",
    "http://127.0.0.1:49152/callback?next=external",
    "http://user@127.0.0.1:49152/callback",
    "http://127.0.0.1:49152/other",
    "https://example.com/callback",
  ])
    assert.ok(cliRequestProblem({ ...request, callbackUrl }));
  assert.ok(cliRequestProblem({ ...request, workspace: "other" }));
});
