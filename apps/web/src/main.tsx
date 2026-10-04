import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
  useSignIn,
  HandleSSOCallback,
} from "@clerk/react";
import type { FunctionDefinition } from "../../../packages/core/src/functions.ts";
type Device = {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  online: boolean;
  lastSeen: number;
  functions?: FunctionDefinition[];
};
function App({ session }: { session?: () => Promise<string | null> }) {
  const [token, setToken] = useState(""),
    [devices, setDevices] = useState<Device[]>([]),
    [notice, setNotice] = useState("Connect to see your devices."),
    [busy, setBusy] = useState(false),
    [enrollment, setEnrollment] = useState<any>(null),
    [action, setAction] = useState<any>(null),
    [text, setText] = useState("hello openlaunch"),
    [principal, setPrincipal] = useState(
      session ? "https://chatgpt.com/oauth/codex/client.json" : "local-agent",
    ),
    [grantCapabilities, setGrantCapabilities] = useState<
      Record<string, string[]>
    >({}),
    [grantLifetime, setGrantLifetime] = useState(3600),
    [broadcastDevices, setBroadcastDevices] = useState<string[]>([]),
    [broadcastFunction, setBroadcastFunction] = useState("device.health"),
    [broadcastResults, setBroadcastResults] = useState<any[]>([]);
  async function api(path: string, method = "GET", data?: unknown) {
    const r = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${session ? await session() : token}`,
        "Content-Type": "application/json",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const b = await r.json();
    if (!r.ok)
      throw Error(b.error?.message ?? b.error?.code ?? `HTTP ${r.status}`);
    if (path === "/v1/enrollments")
      return {
        ...b.data,
        workspace: r.headers.get("x-openlaunch-workspace"),
        origin: window.location.origin,
      };
    return b.data;
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (session) refresh();
  }, []);
  const refresh = () =>
    run(async () => {
      setDevices(await api("/v1/devices"));
      setNotice(
        "Device inventory refreshed. Online means seen within 45 seconds.",
      );
    });
  const request = (d: Device, capability: string, args: unknown) =>
    run(async () => {
      if (
        capability !== "device.health" &&
        !confirm(`Apply ${capability} to ${d.name}?`)
      )
        return;
      const a = await api(`/v1/devices/${d.id}/actions`, "POST", {
        capability,
        arguments: args,
        idempotencyKey: crypto.randomUUID(),
        ttlSeconds: 60,
      });
      setAction(a);
      setNotice(
        "Queued. This is not yet a device success. Refresh the action result after the device polls.",
      );
    });
  const chosenDevices = devices.filter((device) =>
    broadcastDevices.includes(device.id),
  );
  const commonFunctions = chosenDevices.length
    ? chosenDevices[0]!.capabilities.filter((name) =>
        chosenDevices.every((device) => device.capabilities.includes(name)),
      )
    : [];
  const broadcastDefinition =
    chosenDevices[0]?.functions?.find((fn) => fn.name === broadcastFunction) ??
    builtInFunctions.find((fn) => fn.name === broadcastFunction);
  return (
    <>
      <header>
        <a className="brand" href="/">
          openlaunch<span> / device console</span>
        </a>
        {session ? (
          <UserButton />
        ) : (
          <span className="badge">local console</span>
        )}
      </header>
      <main>
        <section className="hero">
          <h1>Your devices</h1>
          <p>
            Pair a device, grant a capability, and see what actually happened.
          </p>
        </section>
        {!session && (
          <section className="session panel">
            <div>
              <h2>Owner session</h2>
              <p>Token stays in page memory and clears on reload.</p>
            </div>
            <input
              aria-label="Development owner bearer token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Development owner bearer token"
            />
            <button disabled={busy || !token} onClick={refresh}>
              Connect / refresh
            </button>
            <button
              className="secondary"
              onClick={() => {
                setToken("");
                setDevices([]);
                setEnrollment(null);
                setAction(null);
                setNotice(
                  "Disconnected locally. Server grants remain unchanged.",
                );
              }}
            >
              Disconnect
            </button>
          </section>
        )}
        <div role="status" className="notice">
          {notice}
        </div>
        <section className="section-head">
          <h2>
            Devices <span>{devices.length}</span>
          </h2>
          <div className="row">
            {(["raspberry-pi-4", "uno-r4-wifi"] as const).map((kind) => (
              <button
                key={kind}
                className="secondary"
                disabled={(!token && !session) || busy}
                onClick={() =>
                  run(async () => {
                    setEnrollment(
                      await api("/v1/enrollments", "POST", { kind }),
                    );
                    setNotice(
                      "Enrollment is single-use and expires in 10 minutes. Keep it private.",
                    );
                  })
                }
              >
                Pair {kind === "raspberry-pi-4" ? "Pi 4" : "Uno R4"}
              </button>
            ))}
          </div>
        </section>
        {enrollment && (
          <section className="panel enrollment">
            <h3>One-time enrollment token</h3>
            <p>Bridge: {enrollment.origin}</p>
            <p>
              Workspace:{" "}
              <code>
                {enrollment.workspace ?? "Unavailable: do not provision yet"}
              </code>
            </p>
            <p>
              Use the device CLI or USB provisioning flow. It does not grant an
              agent access.
            </p>
            <textarea
              readOnly
              aria-label="Enrollment token"
              value={enrollment.token}
            />
            <button className="secondary" onClick={() => setEnrollment(null)}>
              Hide token
            </button>
          </section>
        )}
        <div className="grid">
          {devices.length === 0 ? (
            <section className="empty panel">
              <h3>No connected devices to show</h3>
              <p>
                Start with a Pi 4 or Uno R4 WiFi. Pairing and permission grants
                are separate steps.
              </p>
            </section>
          ) : (
            devices.map((d) => (
              <article className="panel device" key={d.id}>
                <div className="row">
                  <span className={"dot " + (d.online ? "online" : "")} />
                  <span>{d.online ? "Recently seen" : "Offline / stale"}</span>
                </div>
                <h3>{d.name}</h3>
                <p>{d.kind}</p>
                <code>{d.id}</code>
                <div className="tags">
                  {d.capabilities.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <div className="row">
                  <button
                    disabled={busy || !d.online}
                    onClick={() => request(d, "device.health", {})}
                  >
                    Read health
                  </button>
                  {d.capabilities.includes("led.set") && (
                    <>
                      <button
                        className="secondary"
                        disabled={busy || !d.online}
                        onClick={() => request(d, "led.set", { on: true })}
                      >
                        LED on
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !d.online}
                        onClick={() => request(d, "led.set", { on: false })}
                      >
                        LED off
                      </button>
                    </>
                  )}
                </div>
                {d.capabilities.includes("display.text") && (
                  <div className="row">
                    <input
                      aria-label={"Display text for " + d.name}
                      maxLength={96}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button
                      disabled={busy || !d.online}
                      onClick={() => request(d, "display.text", { text })}
                    >
                      Show text
                    </button>
                  </div>
                )}
                {d.functions?.map((fn) => (
                  <FunctionForm
                    key={fn.name}
                    definition={fn}
                    disabled={busy || !d.online}
                    onRequest={(args) => request(d, fn.name, args)}
                  />
                ))}
                <details>
                  <summary>Agent permission</summary>
                  <p>
                    Choose the functions this agent can use and when access
                    expires.
                  </p>
                  {session ? (
                    <label>
                      Agent
                      <select
                        value={principal}
                        onChange={(e) => setPrincipal(e.target.value)}
                      >
                        <option value="https://chatgpt.com/oauth/codex/client.json">
                          Codex
                        </option>
                        <option value="https://chatgpt.com/oauth/client.json">
                          ChatGPT
                        </option>
                      </select>
                    </label>
                  ) : (
                    <input
                      aria-label="Agent principal"
                      value={principal}
                      onChange={(e) => setPrincipal(e.target.value)}
                    />
                  )}
                  <fieldset>
                    <legend>Allowed functions</legend>
                    {d.capabilities.map((capability) => (
                      <label key={capability} className="permission">
                        <input
                          type="checkbox"
                          checked={(grantCapabilities[d.id] ?? []).includes(
                            capability,
                          )}
                          onChange={(e) =>
                            setGrantCapabilities((current) => ({
                              ...current,
                              [d.id]: e.target.checked
                                ? [...(current[d.id] ?? []), capability]
                                : (current[d.id] ?? []).filter(
                                    (c) => c !== capability,
                                  ),
                            }))
                          }
                        />
                        {d.functions?.find((fn) => fn.name === capability)
                          ?.title ?? capability}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    Access expires
                    <select
                      value={grantLifetime}
                      onChange={(e) => setGrantLifetime(Number(e.target.value))}
                    >
                      <option value={900}>In 15 minutes</option>
                      <option value={3600}>In one hour</option>
                      <option value={86400}>In 24 hours</option>
                    </select>
                  </label>
                  <button
                    disabled={busy || !(grantCapabilities[d.id] ?? []).length}
                    onClick={() =>
                      run(async () => {
                        if (
                          !confirm(
                            `Allow ${principal} to use ${(grantCapabilities[d.id] ?? []).join(", ")} for ${grantLifetime / 60} minutes?`,
                          )
                        )
                          return;
                        await api("/v1/grants", "POST", {
                          principal,
                          deviceId: d.id,
                          capabilities: grantCapabilities[d.id] ?? [],
                          ttlSeconds: grantLifetime,
                        });
                        setNotice("Agent permission saved.");
                      })
                    }
                  >
                    Save permission
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api("/v1/grants/revoke", "POST", {
                          principal,
                          deviceId: d.id,
                        });
                        setNotice(
                          "Agent grant revoked; queued actions cancelled.",
                        );
                      })
                    }
                  >
                    Revoke grant
                  </button>
                </details>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (
                        !confirm(
                          `Revoke ${d.name}? Its credential will stop working and it must pair again.`,
                        )
                      )
                        return;
                      await api(`/v1/devices/${d.id}/revoke`, "POST", {});
                      setDevices(await api("/v1/devices"));
                      setNotice("Device revoked.");
                    })
                  }
                >
                  Revoke device
                </button>
              </article>
            ))
          )}
        </div>
        {devices.length > 1 && (
          <section className="panel result">
            <h2>Broadcast a function</h2>
            <p>
              Choose devices and send the same request to each. Every device has
              its own action and result.
            </p>
            <fieldset>
              <legend>Devices</legend>
              {devices.map((device) => (
                <label className="permission" key={device.id}>
                  <input
                    type="checkbox"
                    checked={broadcastDevices.includes(device.id)}
                    onChange={(event) =>
                      setBroadcastDevices((current) =>
                        event.target.checked
                          ? [...current, device.id]
                          : current.filter((id) => id !== device.id),
                      )
                    }
                  />
                  {device.name}
                </label>
              ))}
            </fieldset>
            <label>
              Function
              <select
                value={broadcastFunction}
                onChange={(event) => setBroadcastFunction(event.target.value)}
              >
                <option value="">Choose a function</option>
                {commonFunctions.map((name) => (
                  <option key={name} value={name}>
                    {chosenDevices[0]?.functions?.find((fn) => fn.name === name)
                      ?.title ?? name}
                  </option>
                ))}
              </select>
            </label>
            {broadcastDefinition &&
              commonFunctions.includes(broadcastFunction) && (
                <FunctionForm
                  key={broadcastFunction}
                  definition={broadcastDefinition}
                  disabled={busy || !chosenDevices.length}
                  onRequest={(args) =>
                    run(async () => {
                      if (
                        !confirm(
                          `Send ${broadcastDefinition.title} to ${chosenDevices.length} devices?`,
                        )
                      )
                        return;
                      setBroadcastResults(
                        await api("/v1/broadcasts", "POST", {
                          deviceIds: broadcastDevices,
                          capability: broadcastFunction,
                          arguments: args,
                          idempotencyKey: crypto.randomUUID(),
                          ttlSeconds: 60,
                        }),
                      );
                    })
                  }
                />
              )}
            {broadcastResults.map((result) => (
              <div className="row" key={result.deviceId}>
                <span>
                  {devices.find((device) => device.id === result.deviceId)
                    ?.name ?? result.deviceId}
                  : {result.error?.message ?? result.action.status}
                </span>
                {result.action && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setAction(await api(`/v1/actions/${result.action.id}`)),
                      )
                    }
                  >
                    Inspect result
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        {action && (
          <section className="panel result">
            <div className="section-head">
              <h2>Action receipt</h2>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setAction(await api(`/v1/actions/${action.id}`)),
                  )
                }
              >
                Refresh result
              </button>
            </div>
            <p className="badge">{action.status}</p>
            <pre>{JSON.stringify(action, null, 2)}</pre>
            {action.status === "queued" && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setAction(
                      await api(`/v1/actions/${action.id}/cancel`, "POST", {}),
                    ),
                  )
                }
              >
                Cancel queued action
              </button>
            )}
          </section>
        )}
        <footer>
          openlaunch ·{" "}
          <a href="https://www.openlaunch.dev/docs">Documentation</a>
        </footer>
      </main>
    </>
  );
}
const builtInFunctions: FunctionDefinition[] = [
  {
    name: "device.health",
    title: "Read health",
    description: "Ask the device for a fresh health result.",
    access: "read",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "led.set",
    title: "Set LED",
    description: "Choose whether the built-in LED is on.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
      additionalProperties: false,
    },
  },
  {
    name: "display.text",
    title: "Show text",
    description: "Send text to the device display.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 96 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
function FunctionForm({
  definition,
  disabled,
  onRequest,
}: {
  definition: FunctionDefinition;
  disabled: boolean;
  onRequest: (args: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      Object.entries(definition.inputSchema.properties)
        .filter(([, schema]) => schema.type === "boolean")
        .map(([name]) => [name, false]),
    ),
  );
  const required = definition.inputSchema.required;
  return (
    <form
      className="function-form"
      onSubmit={(event) => {
        event.preventDefault();
        onRequest(values);
      }}
    >
      <h4>{definition.title}</h4>
      <p>{definition.description}</p>
      {Object.entries(definition.inputSchema.properties).map(
        ([name, schema]) => (
          <label key={name}>
            {schema.description ?? name}
            {schema.type === "boolean" ? (
              <input
                type="checkbox"
                checked={values[name] === true}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [name]: event.target.checked,
                  }))
                }
              />
            ) : schema.type === "string" && schema.enum ? (
              <select
                required={required.includes(name)}
                value={String(values[name] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [name]: event.target.value,
                  }))
                }
              >
                <option value="">Choose a value</option>
                {schema.enum.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            ) : (
              <input
                required={required.includes(name)}
                type={schema.type === "string" ? "text" : "number"}
                min={schema.type !== "string" ? schema.minimum : undefined}
                max={schema.type !== "string" ? schema.maximum : undefined}
                step={schema.type === "integer" ? 1 : "any"}
                minLength={
                  schema.type === "string" ? schema.minLength : undefined
                }
                maxLength={
                  schema.type === "string" ? schema.maxLength : undefined
                }
                value={String(values[name] ?? "")}
                onChange={(event) =>
                  setValues((current) => {
                    const next = { ...current };
                    if (event.target.value === "") delete next[name];
                    else
                      next[name] =
                        schema.type === "string"
                          ? event.target.value
                          : Number(event.target.value);
                    return next;
                  })
                }
              />
            )}
          </label>
        ),
      )}
      <button disabled={disabled}>Run {definition.title}</button>
    </form>
  );
}
function GoogleSignIn() {
  const { signIn, fetchStatus } = useSignIn();
  const [error, setError] = useState("");
  const callback = new URLSearchParams(window.location.search).get("sso");
  if (callback === "callback")
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <p>Finishing your sign-in…</p>
          <HandleSSOCallback
            navigateToApp={({ decorateUrl }) => {
              window.location.assign(decorateUrl("/console/"));
            }}
            navigateToSignIn={() =>
              window.location.assign("/console/?sso=verify")
            }
            navigateToSignUp={() =>
              window.location.assign("/console/?sso=verify")
            }
          />
        </div>
      </main>
    );
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <a className="auth-brand" href="/">
          <img src="/icon.svg" width="48" height="42" alt="ol" />
          <span>openlaunch</span>
        </a>
        <h1>Sign in to openlaunch</h1>
        <p>Sign in to connect a device and choose what your agents can do.</p>
        {callback === "verify" ? (
          <SignIn
            routing="hash"
            fallbackRedirectUrl="/console/"
            signUpFallbackRedirectUrl="/console/"
          />
        ) : (
          <button
            className="google-sign-in"
            disabled={fetchStatus === "fetching"}
            onClick={async () => {
              setError("");
              try {
                const result = await signIn.sso({
                  strategy: "oauth_google",
                  redirectUrl: "/console/",
                  redirectCallbackUrl: "/console/?sso=callback",
                });
                if (result.error)
                  setError(
                    result.error.longMessage ??
                      result.error.message ??
                      "Google sign-in could not start.",
                  );
              } catch {
                setError("Google sign-in could not start. Please try again.");
              }
            }}
          >
            Continue with Google
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        <a className="auth-docs" href="/docs">
          Read the docs
        </a>
      </section>
    </main>
  );
}
function HostedApp() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [account, setAccount] = useState<{
    deviceControlsEnabled: boolean;
  } | null>(null);
  const [accountError, setAccountError] = useState("");
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch("/v1/account", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error?.message ?? "Unable to load account");
        if (active) setAccount(body.data);
      } catch (error) {
        if (active)
          setAccountError(
            error instanceof Error ? error.message : "Unable to load account",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [isLoaded, isSignedIn, getToken]);
  if (!isLoaded) return <main>Loading your account…</main>;
  if (!isSignedIn) return <GoogleSignIn />;
  if (accountError)
    return (
      <main>
        <h1>Account connection</h1>
        <p role="alert">{accountError}</p>
        <UserButton />
        <a href="/docs/troubleshooting">Get help</a>
      </main>
    );
  if (!account) return <main>Connecting your account…</main>;
  if (!account.deviceControlsEnabled)
    return (
      <>
        <header>
          <a className="brand" href="/">
            openlaunch
          </a>
          <UserButton />
        </header>
        <main>
          <h1>Account connected</h1>
          <p>
            Your sign-in has been verified. Device linking opens after this
            deployment completes its connection checks.
          </p>
          <a href="/docs">Explore the docs</a>
        </main>
      </>
    );
  return <App session={getToken} />;
}
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
createRoot(document.getElementById("root")!).render(
  publishableKey ? (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl="/console/"
      signUpUrl="/console/"
      signInFallbackRedirectUrl="/console/"
      signUpFallbackRedirectUrl="/console/"
      appearance={{ variables: { colorPrimary: "#111111" } }}
    >
      <HostedApp />
    </ClerkProvider>
  ) : (
    <App />
  ),
);
