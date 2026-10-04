import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { ClerkProvider, SignIn, UserButton, useAuth } from "@clerk/react";
type Device = {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  online: boolean;
  lastSeen: number;
};
function App({ session }: { session?: () => Promise<string | null> }) {
  const [token, setToken] = useState(""),
    [devices, setDevices] = useState<Device[]>([]),
    [notice, setNotice] = useState("Connect to see your devices."),
    [busy, setBusy] = useState(false),
    [enrollment, setEnrollment] = useState<any>(null),
    [action, setAction] = useState<any>(null),
    [text, setText] = useState("hello openlaunch"),
    [principal, setPrincipal] = useState("local-agent");
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
                <details>
                  <summary>Agent permission</summary>
                  <p>
                    One-hour grant to this device’s displayed capabilities.
                    Owner approval only.
                  </p>
                  <input
                    aria-label="Agent principal"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        if (
                          !confirm(
                            `Grant ${principal} these capabilities for one hour?`,
                          )
                        )
                          return;
                        await api("/v1/grants", "POST", {
                          principal,
                          deviceId: d.id,
                          capabilities: d.capabilities,
                          ttlSeconds: 3600,
                        });
                        setNotice("Grant saved for one hour.");
                      })
                    }
                  >
                    Grant for 1 hour
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
  if (!isSignedIn)
    return (
      <main>
        <h1>Sign in to openlaunch</h1>
        <SignIn routing="hash" />
      </main>
    );
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
      appearance={{ variables: { colorPrimary: "#111111" } }}
    >
      <HostedApp />
    </ClerkProvider>
  ) : (
    <App />
  ),
);
