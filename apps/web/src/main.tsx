import React, { useState, useEffect, useRef } from "react";
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
const quoteShellValue = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
type Connection = {
  id: string;
  principal: string;
  name: string;
  expiresAt: number;
  access: "read" | "act";
};
type Grant = {
  id?: string;
  principal: string;
  deviceId: string;
  capabilities: string[];
  expiresAt: number;
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
  const [page, setPage] = useState<"Devices" | "Agents" | "Activity" | "Build">(
    "Devices",
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<
    "Functions" | "Access" | "Details"
  >("Functions");
  const [addOpen, setAddOpen] = useState(false);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [pairingBaseline, setPairingBaseline] = useState<string[] | null>(null);
  const [enrollmentRevealed, setEnrollmentRevealed] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const connectDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (addOpen) connectDialog.current?.showModal();
    else connectDialog.current?.close();
  }, [addOpen]);
  useEffect(() => {
    if (confirmation) confirmationDialog.current?.showModal();
    else confirmationDialog.current?.close();
  }, [confirmation]);
  const confirmAction = (message: string) =>
    new Promise<boolean>((resolve) => setConfirmation({ message, resolve }));
  const finishConfirmation = (approved: boolean) => {
    confirmation?.resolve(approved);
    setConfirmation(null);
  };
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionName, setConnectionName] = useState("My agent");
  const [connectionLifetime, setConnectionLifetime] = useState(86400);
  const [connectionAccess, setConnectionAccess] = useState<"read" | "act">(
    "act",
  );
  const [connectionSecret, setConnectionSecret] = useState<string | null>(null);
  const adapterSetupCommand =
    enrollment && /^[a-f0-9]{64}$/.test(enrollment.workspace ?? "")
      ? `OPENLAUNCH_WORKSPACE=${enrollment.workspace} npx --yes --package=https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz openlaunch-device setup --url ${quoteShellValue(enrollment.origin)}`
      : null;
  const piSetupCommand =
    enrollment && /^[a-f0-9]{64}$/.test(enrollment.workspace ?? "")
      ? `curl -fsSL https://www.openlaunch.dev/install-pi.sh | OPENLAUNCH_WORKSPACE_ID=${enrollment.workspace} bash`
      : "curl -fsSL https://www.openlaunch.dev/install-pi.sh | bash";
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
        kind: (data as { kind: string }).kind,
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
  useEffect(() => {
    if (!session && !token) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const inventory = await api("/v1/devices");
        if (!cancelled) {
          setDevices(inventory);
          const paired =
            pairingBaseline !== null
              ? (inventory as Device[]).find(
                  (device) => !pairingBaseline.includes(device.id),
                )
              : undefined;
          if (paired) {
            setSelectedDeviceId(paired.id);
            setPage("Devices");
            setDetailTab("Access");
            setEnrollment(null);
            setEnrollmentRevealed(false);
            setPairingBaseline(null);
            setAddOpen(false);
            setNotice(
              `${paired.name} is paired. Review its saved access before connecting an agent.`,
            );
          }
        }
      } catch {
        /* Explicit operations show errors; background refresh stays quiet. */
      }
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [!!session, token, pairingBaseline]);
  useEffect(() => {
    if (!action || !["queued", "received"].includes(action.status)) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const current = await api(`/v1/actions/${action.id}`);
        if (!cancelled) {
          setAction(current);
          setReceipts((items) =>
            [current, ...items.filter((item) => item.id !== current.id)].slice(
              0,
              100,
            ),
          );
          setSelectedReceipt((receipt: any) =>
            receipt?.id === current.id ? current : receipt,
          );
        }
      } catch {
        /* Keep the last known receipt rather than inventing an outcome. */
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [action?.id, action?.status]);
  const refresh = () =>
    run(async () => {
      const [inventory, agentConnections, activity, savedGrants] =
        await Promise.all([
          api("/v1/devices"),
          api("/v1/agent-connections"),
          api("/v1/actions"),
          api("/v1/grants"),
        ]);
      setDevices(inventory);
      setConnections(agentConnections);
      setReceipts(activity);
      setGrants(savedGrants);
      if (pairingBaseline !== null) {
        const paired = (inventory as Device[]).find(
          (device) => !pairingBaseline.includes(device.id),
        );
        if (paired) {
          setSelectedDeviceId(paired.id);
          setPage("Devices");
          setDetailTab("Access");
          setEnrollment(null);
          setEnrollmentRevealed(false);
          setPairingBaseline(null);
          setAddOpen(false);
          setNotice(
            `${paired.name} is paired. Review its saved access before connecting an agent.`,
          );
        } else {
          setNotice(
            "Inventory refreshed. Your device has not appeared yet; keep its adapter running and refresh again.",
          );
        }
        return;
      }
      setNotice(
        "Device inventory refreshed. Online means seen within 45 seconds.",
      );
    });
  const request = (d: Device, capability: string, args: unknown) =>
    run(async () => {
      if (
        capability !== "device.health" &&
        !(await confirmAction(`Apply ${capability} to ${d.name}?`))
      )
        return;
      const a = await api(`/v1/devices/${d.id}/actions`, "POST", {
        capability,
        arguments: args,
        idempotencyKey: crypto.randomUUID(),
        ttlSeconds: 60,
      });
      setAction(a);
      setReceipts((items) =>
        [a, ...items.filter((item) => item.id !== a.id)].slice(0, 100),
      );
      setNotice("Queued. Waiting for the device result…");
    });
  const chosenDevices = devices.filter((device) =>
    broadcastDevices.includes(device.id),
  );
  const selectedDevice =
    devices.find((device) => device.id === selectedDeviceId) ?? null;
  const principalLabel = (value: string) =>
    value === "https://chatgpt.com/oauth/codex/client.json"
      ? "Codex"
      : value === "https://chatgpt.com/oauth/client.json"
        ? "ChatGPT"
        : (connections.find((connection) => connection.principal === value)
            ?.name ?? "Custom agent");
  const grantPrincipalLabel = principalLabel(principal);
  const commonFunctions = chosenDevices.length
    ? chosenDevices[0]!.capabilities.filter((name) =>
        chosenDevices.every((device) => device.capabilities.includes(name)),
      )
    : [];
  const broadcastDefinition =
    chosenDevices[0]?.functions?.find((fn) => fn.name === broadcastFunction) ??
    builtInFunctions.find((fn) => fn.name === broadcastFunction);
  return (
    <div className="console-shell">
      <header className="console-header">
        <a className="brand" href="/" aria-label="openlaunch home">
          <img src="/icon.svg" width="30" height="27" alt="" />
          <span>openlaunch</span>
        </a>
        <div className="console-header-tools">
          <nav className="console-nav mobile-nav" aria-label="Console sections">
            {(["Devices", "Agents", "Activity", "Build"] as const).map(
              (item) => (
                <button
                  key={item}
                  className={page === item ? "active" : ""}
                  aria-current={page === item ? "page" : undefined}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ),
            )}
          </nav>
          {!session && <span className="badge">Local owner session</span>}
          {session ? <UserButton /> : null}
        </div>
      </header>
      <div className="console-layout">
        <aside className="console-sidebar" aria-label="Console sections">
          <nav className="console-nav">
            {(["Devices", "Agents", "Activity", "Build"] as const).map(
              (item) => (
                <button
                  key={item}
                  className={page === item ? "active" : ""}
                  aria-current={page === item ? "page" : undefined}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ),
            )}
          </nav>
          <div className="sidebar-bottom">
            <a href="/docs">Documentation</a>
            {session && <UserButton />}
          </div>
        </aside>
        <main className="console-main">
          {!session && (
            <section className="panel session">
              <div>
                <h2>Owner session</h2>
                <p>
                  Your development token stays in this page and clears on
                  reload.
                </p>
              </div>
              <input
                aria-label="Development owner bearer token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Owner bearer token"
              />
              <button disabled={busy || !token} onClick={refresh}>
                Connect
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setToken("");
                  setDevices([]);
                  setEnrollment(null);
                  setAction(null);
                  setNotice(
                    "Disconnected locally. Saved server grants are unchanged.",
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

          {page === "Devices" && (
            <>
              <div className="page-header">
                <div>
                  <h1>Devices</h1>
                  <p>
                    Connect hardware, inspect its functions, and control saved
                    access.
                  </p>
                </div>
                <div className="row">
                  <button
                    className="secondary"
                    disabled={busy || (!session && !token)}
                    onClick={refresh}
                  >
                    Refresh
                  </button>
                  <button
                    disabled={busy || (!session && !token)}
                    onClick={() => {
                      setEnrollment(null);
                      setEnrollmentRevealed(false);
                      setAddOpen(true);
                    }}
                  >
                    Add device
                  </button>
                </div>
              </div>
              {devices.length === 0 ? (
                <section className="empty-state panel">
                  <h2>Connect your first device</h2>
                  <p>
                    Choose a device type to get its setup instructions. Pairing
                    does not give an agent permission to control it.
                  </p>
                  <button
                    disabled={busy || (!session && !token)}
                    onClick={() => setAddOpen(true)}
                  >
                    Add a device
                  </button>
                </section>
              ) : (
                <div className="device-grid">
                  {devices.map((d) => (
                    <article
                      className={`device-card ${selectedDeviceId === d.id ? "selected" : ""}`}
                      key={d.id}
                    >
                      <div className="device-card-top">
                        <span>
                          {d.online
                            ? "Online · seen recently"
                            : "Offline · last seen may be stale"}
                        </span>
                        <span>{d.kind}</span>
                      </div>
                      <h2>{d.name}</h2>
                      <p>
                        {d.capabilities.length}{" "}
                        {d.capabilities.length === 1 ? "function" : "functions"}
                      </p>
                      <button
                        className="secondary"
                        onClick={() => {
                          setSelectedDeviceId(d.id);
                          setDetailTab("Functions");
                        }}
                      >
                        Open device
                      </button>
                    </article>
                  ))}
                </div>
              )}
              {selectedDevice && (
                <section
                  className="device-detail panel"
                  aria-labelledby="device-detail-title"
                >
                  <div className="page-header">
                    <div>
                      <p>
                        {selectedDevice.kind} ·{" "}
                        {selectedDevice.online ? "Online" : "Offline"}
                      </p>
                      <h2 id="device-detail-title">{selectedDevice.name}</h2>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => setSelectedDeviceId(null)}
                    >
                      Close details
                    </button>
                  </div>
                  <div
                    className="detail-tabs"
                    role="tablist"
                    aria-label={`${selectedDevice.name} details`}
                  >
                    {(["Functions", "Access", "Details"] as const).map(
                      (tab) => (
                        <button
                          role="tab"
                          aria-selected={detailTab === tab}
                          className={detailTab === tab ? "active" : ""}
                          key={tab}
                          onClick={() => setDetailTab(tab)}
                        >
                          {tab}
                        </button>
                      ),
                    )}
                  </div>
                  {detailTab === "Functions" && (
                    <div className="function-list">
                      <p>
                        Functions this device currently advertises. Write
                        actions ask you to confirm before they are sent.
                      </p>
                      {selectedDevice.capabilities.map((name) => {
                        const definition =
                          selectedDevice.functions?.find(
                            (fn) => fn.name === name,
                          ) ?? builtInFunctions.find((fn) => fn.name === name);
                        return definition ? (
                          <FunctionForm
                            key={name}
                            definition={definition}
                            disabled={busy || !selectedDevice.online}
                            onRequest={(args) =>
                              request(selectedDevice, name, args)
                            }
                          />
                        ) : (
                          <p key={name}>
                            {name} · no input form is available for this
                            function.
                          </p>
                        );
                      })}
                    </div>
                  )}
                  {detailTab === "Access" && (
                    <div className="access-panel">
                      <h3>Saved agent access</h3>
                      <p>
                        Only saved, unexpired grants authorize an agent. Unsaved
                        selections below have no effect.
                      </p>
                      {grants.filter(
                        (grant) => grant.deviceId === selectedDevice.id,
                      ).length ? (
                        <ul className="grant-list">
                          {grants
                            .filter(
                              (grant) => grant.deviceId === selectedDevice.id,
                            )
                            .map((grant, i) => (
                              <li key={grant.id ?? `${grant.principal}-${i}`}>
                                <strong>
                                  {principalLabel(grant.principal)}
                                </strong>
                                <span>
                                  {grant.capabilities
                                    .map(
                                      (capability) =>
                                        selectedDevice.functions?.find(
                                          (fn) => fn.name === capability,
                                        )?.title ??
                                        builtInFunctions.find(
                                          (fn) => fn.name === capability,
                                        )?.title ??
                                        capability,
                                    )
                                    .join(", ")}
                                </span>
                                <span>
                                  Expires{" "}
                                  {new Date(grant.expiresAt).toLocaleString()}
                                </span>
                                <details>
                                  <summary>Agent ID</summary>
                                  <code>{grant.principal}</code>
                                </details>
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      await api("/v1/grants/revoke", "POST", {
                                        principal: grant.principal,
                                        deviceId: grant.deviceId,
                                      });
                                      setGrants(await api("/v1/grants"));
                                      setNotice(
                                        "Saved grant revoked; queued actions are cancelled.",
                                      );
                                    })
                                  }
                                >
                                  Revoke
                                </button>
                              </li>
                            ))}
                        </ul>
                      ) : (
                        <p>No saved grants for this device.</p>
                      )}
                      <details className="grant-editor">
                        <summary>Grant an agent access</summary>
                        <p>
                          Select only the functions this agent needs and set
                          when access expires.
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
                              {connections.map((c) => (
                                <option key={c.id} value={c.principal}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <label>
                            Agent principal
                            <input
                              value={principal}
                              onChange={(e) => setPrincipal(e.target.value)}
                            />
                          </label>
                        )}
                        <fieldset>
                          <legend>Functions to allow</legend>
                          {selectedDevice.capabilities.map((capability) => (
                            <label className="permission" key={capability}>
                              <input
                                type="checkbox"
                                checked={(
                                  grantCapabilities[selectedDevice.id] ?? []
                                ).includes(capability)}
                                onChange={(e) =>
                                  setGrantCapabilities((current) => ({
                                    ...current,
                                    [selectedDevice.id]: e.target.checked
                                      ? [
                                          ...(current[selectedDevice.id] ?? []),
                                          capability,
                                        ]
                                      : (
                                          current[selectedDevice.id] ?? []
                                        ).filter((c) => c !== capability),
                                  }))
                                }
                              />
                              {selectedDevice.functions?.find(
                                (fn) => fn.name === capability,
                              )?.title ?? capability}
                            </label>
                          ))}
                        </fieldset>
                        <label>
                          Access expires
                          <select
                            value={grantLifetime}
                            onChange={(e) =>
                              setGrantLifetime(Number(e.target.value))
                            }
                          >
                            <option value={900}>In 15 minutes</option>
                            <option value={3600}>In one hour</option>
                            <option value={86400}>In 24 hours</option>
                          </select>
                        </label>
                        <button
                          disabled={
                            busy ||
                            !(grantCapabilities[selectedDevice.id] ?? []).length
                          }
                          onClick={() =>
                            run(async () => {
                              const selectedCapabilities =
                                grantCapabilities[selectedDevice.id] ?? [];
                              const capabilityNames = selectedCapabilities.map(
                                (capability) =>
                                  selectedDevice.functions?.find(
                                    (fn) => fn.name === capability,
                                  )?.title ??
                                  builtInFunctions.find(
                                    (fn) => fn.name === capability,
                                  )?.title ??
                                  capability,
                              );
                              if (
                                !(await confirmAction(
                                  `Allow ${grantPrincipalLabel} to use ${capabilityNames.join(", ")} on ${selectedDevice.name} for ${grantLifetime / 60} minutes?`,
                                ))
                              )
                                return;
                              await api("/v1/grants", "POST", {
                                principal,
                                deviceId: selectedDevice.id,
                                capabilities: selectedCapabilities,
                                ttlSeconds: grantLifetime,
                              });
                              setGrants(await api("/v1/grants"));
                              setNotice("Agent grant saved.");
                            })
                          }
                        >
                          Save grant
                        </button>
                      </details>
                    </div>
                  )}
                  {detailTab === "Details" && (
                    <div className="device-metadata">
                      <p>
                        <strong>Device ID</strong>
                        <code>{selectedDevice.id}</code>
                      </p>
                      <p>
                        <strong>Last seen</strong>
                        {selectedDevice.lastSeen
                          ? new Date(selectedDevice.lastSeen).toLocaleString()
                          : "Not reported"}
                      </p>
                      <p>
                        <strong>Advertised functions</strong>
                        {selectedDevice.capabilities.join(", ") || "None"}
                      </p>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            if (
                              !(await confirmAction(
                                `Revoke ${selectedDevice.name}? Its credential will stop working and it must pair again.`,
                              ))
                            )
                              return;
                            await api(
                              `/v1/devices/${selectedDevice.id}/revoke`,
                              "POST",
                              {},
                            );
                            setDevices(await api("/v1/devices"));
                            setGrants(await api("/v1/grants"));
                            setSelectedDeviceId(null);
                            setNotice("Device revoked.");
                          })
                        }
                      >
                        Revoke device
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {page === "Agents" && (
            <>
              <div className="page-header">
                <div>
                  <h1>Agents</h1>
                  <p>
                    Connect through OAuth or create a short-lived SDK
                    connection, then grant specific device functions.
                  </p>
                </div>
              </div>
              <section className="panel help-panel">
                <h2>ChatGPT and Codex</h2>
                <p>
                  Sign in with Google here, then connect ChatGPT or Codex
                  through their openlaunch OAuth flow. Their access is
                  controlled by the saved device grants shown on each device.
                </p>
                <a href="/docs">Read agent setup documentation</a>
              </section>
              <section className="panel">
                <h2>Create an SDK connection</h2>
                <p>
                  For another agent or application, create a token. The token
                  appears once; copy it into your app's secret settings.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      const connection = await api(
                        "/v1/agent-connections",
                        "POST",
                        {
                          name: connectionName,
                          ttlSeconds: connectionLifetime,
                          access: connectionAccess,
                        },
                      );
                      setConnectionSecret(connection.token);
                      setPrincipal(connection.principal);
                      setConnections(await api("/v1/agent-connections"));
                      setNotice(
                        "Connection created. Choose its device functions under Devices → Access.",
                      );
                    });
                  }}
                >
                  <label>
                    Connection name
                    <input
                      value={connectionName}
                      maxLength={64}
                      required
                      onChange={(e) => setConnectionName(e.target.value)}
                    />
                  </label>
                  <label>
                    Token expires
                    <select
                      value={connectionLifetime}
                      onChange={(e) =>
                        setConnectionLifetime(Number(e.target.value))
                      }
                    >
                      <option value={3600}>In one hour</option>
                      <option value={86400}>In 24 hours</option>
                      <option value={604800}>In 7 days</option>
                      <option value={2592000}>In 30 days</option>
                    </select>
                  </label>
                  <label>
                    Access
                    <select
                      value={connectionAccess}
                      onChange={(e) =>
                        setConnectionAccess(e.target.value as "read" | "act")
                      }
                    >
                      <option value="act">Request granted functions</option>
                      <option value="read">
                        Read granted health and results
                      </option>
                    </select>
                  </label>
                  <button disabled={busy || !connectionName.trim()}>
                    Create SDK token
                  </button>
                </form>
                {connectionSecret && (
                  <div className="connection-secret">
                    <label>
                      SDK token (shown once)
                      <textarea readOnly value={connectionSecret} />
                    </label>
                    <p>
                      Save this token in your app now. It clears when you hide
                      it or reload.
                    </p>
                    <button
                      className="secondary"
                      onClick={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(connectionSecret);
                          setNotice("SDK token copied.");
                        })
                      }
                    >
                      Copy SDK token
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setConnectionSecret(null)}
                    >
                      Hide token
                    </button>
                  </div>
                )}
              </section>
              <section className="panel">
                <h2>Active SDK connections</h2>
                {connections.length ? (
                  <ul className="connection-list">
                    {connections.map((c) => (
                      <li key={c.id}>
                        <div>
                          <strong>{c.name}</strong>
                          <span>
                            Expires {new Date(c.expiresAt).toLocaleString()}
                          </span>
                          <details>
                            <summary>Connection details</summary>
                            <span>{c.principal}</span>
                            <code>{c.id}</code>
                          </details>
                        </div>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api(
                                `/v1/agent-connections/${c.id}/revoke`,
                                "POST",
                                {},
                              );
                              setConnectionSecret(null);
                              setConnections(
                                await api("/v1/agent-connections"),
                              );
                              setGrants(await api("/v1/grants"));
                              setNotice(
                                "Connection revoked. Its grants and queued actions are cancelled.",
                              );
                            })
                          }
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No active SDK connections.</p>
                )}
              </section>
            </>
          )}

          {page === "Activity" && (
            <>
              <div className="page-header">
                <div>
                  <h1>Activity</h1>
                  <p>
                    Inspect action receipts from the owner API. “Queued” means
                    accepted for delivery, not completed.
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={busy || (!session && !token)}
                  onClick={refresh}
                >
                  Refresh activity
                </button>
              </div>
              {devices.length > 1 && (
                <section className="panel">
                  <h2>Send a function to several devices</h2>
                  <p>Each device receives its own action and receipt.</p>
                  <fieldset>
                    <legend>Devices</legend>
                    {devices.map((device) => (
                      <label className="permission" key={device.id}>
                        <input
                          type="checkbox"
                          checked={broadcastDevices.includes(device.id)}
                          onChange={(e) =>
                            setBroadcastDevices((current) =>
                              e.target.checked
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
                      onChange={(e) => setBroadcastFunction(e.target.value)}
                    >
                      <option value="">Choose a shared function</option>
                      {commonFunctions.map((name) => (
                        <option key={name} value={name}>
                          {name}
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
                              !(await confirmAction(
                                `Send ${broadcastDefinition.title} to ${chosenDevices.length} devices?`,
                              ))
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
                            setReceipts(await api("/v1/actions"));
                          })
                        }
                      />
                    )}
                  {broadcastResults.map((result) => (
                    <p key={result.deviceId}>
                      {devices.find((device) => device.id === result.deviceId)
                        ?.name ?? result.deviceId}
                      : {result.error?.message ?? result.action.status}
                    </p>
                  ))}
                </section>
              )}
              <section className="panel">
                <h2>Action receipts</h2>
                {receipts.length ? (
                  <ul className="activity-list">
                    {receipts.map((receipt) => (
                      <li className="action-row" key={receipt.id}>
                        <button
                          className="receipt-open"
                          onClick={() => setSelectedReceipt(receipt)}
                        >
                          <strong>
                            {receipt.capability ?? "Device action"}
                          </strong>
                          <span>
                            {devices.find((d) => d.id === receipt.deviceId)
                              ?.name ?? receipt.deviceId}
                          </span>
                          <span>
                            {receipt.status === "queued"
                              ? "Queued · waiting for device"
                              : receipt.status === "received"
                                ? "Received · device is processing"
                                : `Finished · ${receipt.status}`}
                          </span>
                          <time>
                            {receipt.createdAt
                              ? new Date(receipt.createdAt).toLocaleString()
                              : receipt.updatedAt
                                ? new Date(receipt.updatedAt).toLocaleString()
                                : "Time unavailable"}
                          </time>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No actions recorded yet.</p>
                )}
              </section>
              {selectedReceipt && (
                <section className="panel receipt-detail">
                  <div className="page-header">
                    <div>
                      <h2>Action receipt</h2>
                      <p>
                        {selectedReceipt.status === "queued"
                          ? "The server accepted this action. The device has not confirmed receipt yet."
                          : selectedReceipt.status === "received"
                            ? "The device confirmed receipt. Its final result is not available yet."
                            : `The action reached a terminal state: ${selectedReceipt.status}.`}
                      </p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => setSelectedReceipt(null)}
                    >
                      Close
                    </button>
                  </div>
                  <details>
                    <summary>Raw receipt data</summary>
                    <pre>{JSON.stringify(selectedReceipt, null, 2)}</pre>
                  </details>
                  {selectedReceipt.status === "queued" && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const updated = await api(
                            `/v1/actions/${selectedReceipt.id}/cancel`,
                            "POST",
                            {},
                          );
                          setSelectedReceipt(updated);
                          setReceipts(await api("/v1/actions"));
                        })
                      }
                    >
                      Cancel queued action
                    </button>
                  )}
                </section>
              )}
            </>
          )}

          {page === "Build" && (
            <>
              <div className="page-header">
                <div>
                  <h1>Build</h1>
                  <p>
                    Extend the device SDK with a function your adapter actually
                    implements.
                  </p>
                </div>
              </div>
              <section className="panel help-panel">
                <h2>Custom device functions</h2>
                <p>
                  Define a function name, title, description, JSON input schema,
                  and handler in your adapter. The handler must enforce
                  device-local limits and report what the hardware actually did.
                  Publishing a changed function manifest revokes existing
                  grants, so review access again afterward.
                </p>
                <a href="/docs/sdk">Read the SDK guide</a>
              </section>
              <section className="panel">
                <h2>Start a custom adapter</h2>
                <p>
                  Run the SDK setup command on the machine connected to your
                  hardware. It creates a starter adapter and asks for the
                  one-time enrollment code.
                </p>
                <button
                  disabled={busy || (!session && !token)}
                  onClick={() => {
                    setEnrollment(null);
                    setEnrollmentRevealed(false);
                    setAddOpen(true);
                  }}
                >
                  Get an enrollment command
                </button>
              </section>
              <section className="panel">
                <h2>SDK command</h2>
                <pre>
                  npx --yes
                  --package=https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz
                  openlaunch-device setup
                </pre>
                <p>
                  Pair an adapter with an enrollment code, edit its function
                  manifest and handlers, then publish and run it.
                </p>
              </section>
            </>
          )}
          <footer>
            openlaunch ·{" "}
            <a href="https://www.openlaunch.dev/docs">Documentation</a>
          </footer>
        </main>
      </div>

      <dialog
        ref={connectDialog}
        className="connect-dialog"
        aria-labelledby="connect-title"
        onCancel={(event) => {
          event.preventDefault();
          setAddOpen(false);
          setEnrollment(null);
        }}
      >
        <div className="page-header">
          <div>
            <h2 id="connect-title">
              {enrollment ? "Finish device setup" : "Add a device"}
            </h2>
            <p>
              {enrollment
                ? "Follow the setup steps, then refresh inventory to find the paired device."
                : "Choose what you want to connect."}
            </p>
          </div>
          <button
            className="secondary"
            onClick={() => {
              setAddOpen(false);
              setEnrollment(null);
            }}
          >
            Close
          </button>
        </div>
        {!enrollment ? (
          <div className="connect-options">
            {(
              [
                [
                  "raspberry-pi-4",
                  "Raspberry Pi 4",
                  "Run the adapter on your Pi.",
                ],
                [
                  "uno-r4-wifi",
                  "Arduino Uno R4 WiFi",
                  "Use the supported board setup guide.",
                ],
                [
                  "custom.device",
                  "Custom device",
                  "Connect an adapter using the openlaunch SDK.",
                ],
              ] as const
            ).map(([kind, title, description]) => (
              <button
                key={kind}
                className="connect-option"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setPairingBaseline(devices.map((d) => d.id));
                    setEnrollment(
                      await api("/v1/enrollments", "POST", { kind }),
                    );
                    setEnrollmentRevealed(false);
                  })
                }
              >
                <strong>{title}</strong>
                <span>{description}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="enrollment-steps">
            <h3>
              {enrollment.kind === "raspberry-pi-4"
                ? "On your Raspberry Pi"
                : enrollment.kind === "uno-r4-wifi"
                  ? "On your Uno R4 WiFi"
                  : "On the machine connected to your device"}
            </h3>
            {enrollment.kind === "raspberry-pi-4" ? (
              <>
                <p>
                  Run the installer in a terminal on the Pi, then follow its
                  prompts.
                </p>
                <div className="setup-command">
                  <code>{piSetupCommand}</code>
                </div>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(piSetupCommand);
                      setNotice("Installer command copied.");
                    })
                  }
                >
                  Copy installer command
                </button>
              </>
            ) : enrollment.kind === "custom.device" ? (
              <>
                <p>
                  Run the setup command on the machine hosting your adapter.
                  Enter the one-time code when prompted.
                </p>
                {adapterSetupCommand ? (
                  <>
                    <div className="setup-command">
                      <code>{adapterSetupCommand}</code>
                    </div>
                    <button
                      className="secondary"
                      onClick={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(
                            adapterSetupCommand,
                          );
                          setNotice("Setup command copied.");
                        })
                      }
                    >
                      Copy setup command
                    </button>
                  </>
                ) : (
                  <p>
                    Setup command is unavailable. Do not run a partial command.
                  </p>
                )}
              </>
            ) : (
              <>
                <p>
                  Connect the board by USB, then follow the provisioning guide
                  for your stock or repaired board profile.
                </p>
                <a href="/docs/uno-r4">Open Uno R4 setup guide</a>
              </>
            )}
            {enrollment.kind !== "custom.device" && enrollment.workspace && (
              <label>
                Workspace ID
                <input readOnly value={enrollment.workspace} />
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(
                        enrollment.workspace!,
                      );
                      setNotice("Workspace ID copied.");
                    })
                  }
                >
                  Copy workspace ID
                </button>
              </label>
            )}
            <p>
              Enrollment code expires in 10 minutes and works once. It does not
              grant agent access.
            </p>
            {enrollmentRevealed ? (
              <>
                <label>
                  One-time enrollment code
                  <textarea readOnly value={enrollment.token} />
                </label>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(enrollment.token);
                      setNotice(
                        "Enrollment code copied. Keep it private; it works once.",
                      );
                    })
                  }
                >
                  Copy enrollment code
                </button>
                <button
                  className="secondary"
                  onClick={() => setEnrollmentRevealed(false)}
                >
                  Hide code
                </button>
              </>
            ) : (
              <button onClick={() => setEnrollmentRevealed(true)}>
                Show one-time enrollment code
              </button>
            )}
            <div className="row">
              <button className="secondary" disabled={busy} onClick={refresh}>
                Refresh inventory
              </button>
              <a href="/docs/sdk">Setup help</a>
            </div>
          </div>
        )}
      </dialog>
      <dialog
        ref={confirmationDialog}
        className="confirmation-dialog"
        aria-labelledby="confirmation-title"
        onCancel={(event) => {
          event.preventDefault();
          finishConfirmation(false);
        }}
      >
        <h2 id="confirmation-title">Review request</h2>
        <p>{confirmation?.message}</p>
        <div className="row">
          <button
            className="secondary"
            autoFocus
            onClick={() => finishConfirmation(false)}
          >
            Cancel
          </button>
          <button onClick={() => finishConfirmation(true)}>Confirm</button>
        </div>
      </dialog>
    </div>
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
