import { useCallback, useEffect, useState } from "react";
import { useAuth, useSignIn } from "@clerk/react";
import { AuthCardFrame } from "./auth-frame";
import {
  type AccountSummary,
  agentIdCarryPath,
  cliRequestProblem,
  readCliRequest,
  roleLabels,
} from "./workspace";

/**
 * Automatic AgentID entry point for /console/?agentid=1.
 *
 * Starts the official Clerk oauth_agentid redirect as soon as Clerk is ready.
 * The AgentID/CLI parameters are carried through the redirect callback URL so
 * they are still present when the sign-in completes.
 */
export function AgentIdEntry({ paused = false }: { paused?: boolean }) {
  const { isLoaded } = useAuth();
  const { signIn } = useSignIn();
  const [request] = useState(() => readCliRequest());
  const problem = request ? cliRequestProblem(request) : null;
  const [autoStarted, setAutoStarted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");

  const start = useCallback(async () => {
    if (!signIn) return;
    setWaiting(true);
    setError("");
    try {
      const result = await signIn.sso({
        strategy: "oauth_agentid",
        redirectCallbackUrl: agentIdCarryPath("/console/?sso=callback"),
        redirectUrl: agentIdCarryPath("/console/"),
      });
      if (result.error) throw result.error;
      // A successful call normally navigates the browser to AgentID.
    } catch (thrown) {
      const clerkError = thrown as { longMessage?: string; message?: string };
      setWaiting(false);
      setError(
        clerkError?.longMessage ??
          clerkError?.message ??
          "AgentID sign-in could not start.",
      );
    }
  }, [signIn]);

  useEffect(() => {
    if (!isLoaded || paused || problem || autoStarted || !signIn) return;
    setAutoStarted(true);
    void start();
  }, [isLoaded, paused, problem, autoStarted, signIn, start]);

  return (
    <AuthCardFrame includeLegalLinks={false}>
      <h1>Sign in with AgentID</h1>
      {problem ? (
        <>
          <p role="alert" aria-live="assertive">
            This AgentID link is not valid: {problem}
          </p>
          <p className="muted">
            Start the connection again from your terminal, or sign in with the
            standard options.
          </p>
          <div className="auth-actions">
            <a href="/console/">Use the standard sign-in options</a>
          </div>
        </>
      ) : (
        <>
          <p>
            AgentID verifies this agent and signs it in to its own workspace,
            which starts with all device functions enabled. To control devices
            in someone else's workspace, that workspace's owner must invite this
            agent first.
          </p>
          {(waiting || paused || error) && (
            <p
              role={error ? "alert" : "status"}
              aria-live={error ? "assertive" : "polite"}
              aria-busy={waiting && !error}
              className={error ? "agentid-error" : "agentid-status"}
            >
              {waiting && !error
                ? "Opening AgentID sign-in…"
                : paused && !error
                  ? "Your AgentID sign-in did not finish. You can try again."
                  : error
                    ? `AgentID sign-in failed: ${error}`
                    : null}
            </p>
          )}
          <div className="auth-actions">
            <button
              type="button"
              disabled={!isLoaded || waiting}
              onClick={() => void start()}
            >
              {error || paused
                ? "Try AgentID sign-in again"
                : "Continue with AgentID"}
            </button>
            <a href="/console/">Use Google or other sign-in options</a>
          </div>
          <p className="muted">
            AgentID may ask the agent to enroll first. Keep this tab open until
            the sign-in completes.
          </p>
        </>
      )}
    </AuthCardFrame>
  );
}

/**
 * Consent screen for the ol CLI connection request. Shown after sign-in when
 * the console was opened with cli_callback/cli_state/cli_challenge parameters.
 * Approving never places a session or agent token in the redirect URL — only
 * a short-lived connection code and the CLI's own state value.
 */
export function AgentIdCliConsent() {
  const { getToken } = useAuth();
  const [request] = useState(() => readCliRequest());
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [accountEpoch, setAccountEpoch] = useState(0);

  const problem = request ? cliRequestProblem(request) : null;

  useEffect(() => {
    if (!request) return;
    let active = true;
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch("/v1/account", {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.workspace
              ? { "x-openlaunch-target-workspace": request.workspace }
              : {}),
          },
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body?.error?.message ?? "Unable to load workspace details",
          );
        if (active) {
          setAccount(body.data);
          setLoadError("");
        }
      } catch (error) {
        if (active)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load workspace",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [getToken, request, accountEpoch]);

  if (!request) {
    return (
      <AuthCardFrame signedIn>
        <h1>Connect the ol CLI</h1>
        <p role="alert" aria-live="assertive">
          This connection link is missing its CLI parameters. Start the command
          from your terminal again.
        </p>
        <div className="auth-actions">
          <a href="/console/">Continue to the console</a>
        </div>
      </AuthCardFrame>
    );
  }

  const role = account
    ? account.principal.owner
      ? roleLabels.owner
      : (roleLabels[
          account.principal.administrator ? "administrator" : "operator"
        ] ?? "Operator")
    : null;

  const connect = async () => {
    if (!request || problem) return;
    setConnecting(true);
    setError("");
    try {
      const token = await getToken();
      const response = await fetch("/v1/cli-login/authorize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(request.workspace
            ? { "x-openlaunch-target-workspace": request.workspace }
            : {}),
        },
        body: JSON.stringify({
          callbackUrl: request.callbackUrl,
          state: request.state,
          challenge: request.challenge,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body?.error?.message ??
            body?.error?.code ??
            `The server refused the connection (HTTP ${response.status}).`,
        );
      const result = body.data as {
        code?: string;
        state?: string;
        callbackUrl?: string;
      };
      if (
        !result?.code ||
        !/^ol_login_[a-f0-9]{64}_[A-Za-z0-9_-]{43}$/.test(result.code) ||
        result.callbackUrl !== request.callbackUrl ||
        result.state !== request.state
      )
        throw new Error("The server returned an invalid CLI handshake.");
      const target = new URL(request.callbackUrl);
      target.searchParams.set("code", result.code);
      target.searchParams.set("state", request.state);
      window.location.assign(target.toString());
    } catch (thrown) {
      setConnecting(false);
      setError(
        thrown instanceof Error ? thrown.message : "Connecting the CLI failed.",
      );
    }
  };

  return (
    <AuthCardFrame signedIn>
      <h1>Connect the ol CLI</h1>
      <p>
        The ol CLI on this device is asking to connect to the openlaunch
        workspace shown below. An agent's own workspace already has all device
        functions enabled; a workspace it joined was approved by that owner, and
        the credential carries the access your role allows there. No session or
        agent token is placed in the redirect — only a short-lived connection
        code and the CLI's own state value.
      </p>
      <dl className="cli-consent-details">
        <div>
          <dt>Workspace</dt>
          <dd>
            {account ? (
              <code>{account.workspace}</code>
            ) : loadError ? (
              "Unavailable"
            ) : (
              "Loading workspace…"
            )}
          </dd>
        </div>
        <div>
          <dt>Your role</dt>
          <dd>{role ?? "—"}</dd>
        </div>
        <div>
          <dt>CLI callback</dt>
          <dd>
            <code>{request.callbackUrl}</code>
          </dd>
        </div>
        <div>
          <dt>Handshake</dt>
          <dd>
            PKCE S256 challenge ({request.challenge.length} characters) and
            random state ({request.state.length} characters), both validated
          </dd>
        </div>
      </dl>
      {problem && (
        <p role="alert" aria-live="assertive">
          This connection request is not valid: {problem}
        </p>
      )}
      {loadError && (
        <>
          <p role="alert" aria-live="assertive" className="agentid-error">
            Could not load the workspace for this connection: {loadError}
          </p>
          <div className="auth-actions">
            <button
              type="button"
              disabled={connecting}
              onClick={() => setAccountEpoch((n) => n + 1)}
            >
              Retry loading workspace
            </button>
            <a href="/console/">Continue to the console</a>
          </div>
        </>
      )}
      {!loadError && error && (
        <p role="alert" aria-live="assertive" className="agentid-error">
          {error}
        </p>
      )}
      {!loadError && (
        <div className="auth-actions">
          <button
            type="button"
            disabled={connecting || !!problem || !account}
            onClick={() => void connect()}
          >
            {connecting ? "Connecting…" : "Connect CLI"}
          </button>
          <a href="/console/">Continue to the console</a>
        </div>
      )}
      {error && !loadError && (
        <p className="muted">
          Check that the ol CLI is still waiting, then try again.
        </p>
      )}
    </AuthCardFrame>
  );
}
