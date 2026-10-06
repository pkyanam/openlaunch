/** Browser-backed AgentID login for the ol CLI: PKCE with a loopback callback. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { validateAgentConfig, type AgentIdAgentConfig } from "./agent-config.js";
import { sdkTokenWorkspace } from "./index.js";

export type LoginOutput = { write(value: string): void };
export type UrlOpener = (
  url: string,
) => Promise<boolean | void> | boolean | void;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
/** One-time codes minted by the cloud: ol_login_<workspace64>_<secret43>. */
const LOGIN_CODE = /^ol_login_[a-f0-9]{64}_[A-Za-z0-9_-]{43}$/;

/** Accept only HTTPS origins, or literal loopback HTTP for local development. */
export function validateLoginOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be an absolute HTTPS origin");
  }
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
  return url.origin;
}

/** S256 challenge derived from the PKCE verifier; only the challenge is shared. */
export function challengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Timing-safe comparison; string lengths are not secret here. */
function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function buildAuthUrl(input: {
  origin: string;
  callback: string;
  state: string;
  challenge: string;
  workspace?: string;
}): string {
  const url = new URL("/console/", input.origin);
  url.searchParams.set("agentid", "1");
  url.searchParams.set("cli_callback", input.callback);
  url.searchParams.set("cli_state", input.state);
  url.searchParams.set("cli_challenge", input.challenge);
  if (input.workspace) url.searchParams.set("workspace", input.workspace);
  return url.toString();
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

/** Open the auth URL with the platform browser helper, without a shell. */
export function defaultUrlOpener(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? undefined
          : "xdg-open";
    if (!command) {
      resolve(false);
      return;
    }
    try {
      const child = spawn(command, [url], { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

type ExchangeData = {
  token: string;
  workspace: string;
  connectionId: string;
  expiresAt: number | null;
  access: string;
  role: string;
};

async function exchangeCode(input: {
  origin: string;
  code: string;
  verifier: string;
  fetchImpl: typeof fetch;
}): Promise<ExchangeData> {
  let response: Response;
  try {
    response = await input.fetchImpl(`${input.origin}/v1/cli-login/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code, verifier: input.verifier }),
      cache: "no-store",
      // Never forward the one-time code to a redirect target.
      redirect: "error",
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Could not reach the openlaunch login exchange endpoint");
  }
  if (new URL(response.url).origin !== input.origin)
    throw new Error("Login exchange was redirected to a different origin");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Login exchange returned an invalid response");
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!response.ok || !data || typeof data !== "object") {
    const message = (payload as { error?: { message?: unknown } } | null)
      ?.error?.message;
    const detail =
      typeof message === "string" && message.length <= 200
        ? message
        : "Try ol login --agentid again";
    throw new Error(`Login exchange failed (${response.status}). ${detail}`);
  }
  const value = data as Record<string, unknown>;
  if (
    typeof value.token !== "string" ||
    !/^ol_agent_[a-f0-9]{64}_[a-f0-9]{64}$/.test(value.token) ||
    typeof value.workspace !== "string" ||
    // The returned credential embeds the workspace it is bound to.
    value.workspace !== sdkTokenWorkspace(value.token) ||
    typeof value.connectionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.connectionId) ||
    !(
      value.expiresAt === null ||
      (typeof value.expiresAt === "number" &&
        Number.isSafeInteger(value.expiresAt) &&
        value.expiresAt >= 0)
    ) ||
    (value.access !== "read" && value.access !== "act") ||
    (value.role !== "operator" && value.role !== "administrator")
  )
    throw new Error(
      "Login exchange returned an unexpected credential; run ol login --agentid again",
    );
  return {
    token: value.token,
    workspace: value.workspace,
    connectionId: value.connectionId,
    expiresAt: value.expiresAt as number | null,
    access: value.access,
    role: value.role,
  };
}

/**
 * Run the AgentID browser login. A random state and the S256 PKCE challenge
 * are sent in the public auth URL; the verifier and the one-time code never
 * appear in the URL, logs or the callback response. The returned config is
 * validated and ready to save; nothing is written here.
 */
export async function browserLogin(options: {
  origin: string;
  workspace?: string;
  /** Print the public auth URL only when false (--no-open). */
  open?: boolean;
  output: LoginOutput;
  fetch?: typeof fetch;
  openURL?: UrlOpener;
  timeoutMs?: number;
}): Promise<{ config: AgentIdAgentConfig; url: string }> {
  const origin = validateLoginOrigin(options.origin);
  if (
    options.workspace !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.workspace)
  )
    throw new Error("--workspace must be the 64-character workspace ID");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Login timeout must be a positive number of milliseconds");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = challengeForVerifier(verifier);

  const server = createServer();
  // Prevent an unhandled 'error' event from crashing the process.
  server.on("error", () => {});
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch {
    throw new Error("Could not start the local login callback listener");
  }
  let settleCode: ((error: Error | null, code?: string) => void) | undefined;
  const codePromise = new Promise<string>((resolveCode, rejectCode) => {
    let settled = false;
    settleCode = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectCode(error);
      else resolveCode(code as string);
    };
    const timer = setTimeout(
      () =>
        settleCode?.(
          new Error(
            "Login timed out before the browser returned a callback; run ol login --agentid again",
          ),
        ),
      timeoutMs,
    );
  });
  let accepted = false;
  server.on("request", (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      request.destroy();
      return;
    }
    if (url.pathname !== "/callback") {
      respond(response, 404, "Not found");
      return;
    }
    if (request.method !== "GET") {
      respond(response, 405, "Method not allowed");
      return;
    }
    const code = url.searchParams.get("code");
    const callbackState = url.searchParams.get("state");
    if (
      !code ||
      !LOGIN_CODE.test(code) ||
      !callbackState ||
      !timingSafeStringEqual(callbackState, state)
    ) {
      // Reject and keep listening; the real browser can still finish.
      respond(
        response,
        400,
        "Invalid login callback. Return to the terminal and try again.",
      );
      return;
    }
    if (!accepted) {
      accepted = true;
      settleCode?.(null, code);
    }
    respond(
      response,
      200,
      "openlaunch login complete. Return to the terminal.",
    );
  });
  try {
    const callbackUrl = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/callback`;
    const authUrl = buildAuthUrl({
      origin,
      callback: callbackUrl,
      state,
      challenge,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    });
    options.output.write(
      `Open this URL to sign in with AgentID and authorize the openlaunch CLI:\n${authUrl}\n`,
    );
    if (options.open !== false) {
      const opened = await (options.openURL ?? defaultUrlOpener)(authUrl);
      if (opened === false)
        options.output.write(
          "Could not open a browser automatically; open the URL above to continue.\n",
        );
    }
    const code = await codePromise;
    const data = await exchangeCode({
      origin,
      code,
      verifier,
      fetchImpl: options.fetch ?? globalThis.fetch,
    });
    if (
      options.workspace !== undefined &&
      data.workspace !== options.workspace
    )
      throw new Error(
        `The browser login returned workspace ${data.workspace} instead of the requested workspace; run ol login --agentid --workspace ${data.workspace} to target it, or sign in with the account that owns the requested workspace`,
      );
    const config = validateAgentConfig({
      version: 2,
      mode: "agentid",
      url: origin,
      ...data,
    }) as AgentIdAgentConfig;
    return { config, url: authUrl };
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
