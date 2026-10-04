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
  canAttach?: boolean;
  deviceLimit?: number;
  attachedDeviceCount?: number;
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
  const [page, setPage] = useState<
    "Devices" | "Connections" | "Activity" | "Build"
  >("Devices");
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
  const [connectionName, setConnectionName] = useState("My app");
  const [connectionLifetime, setConnectionLifetime] = useState(604800);
  const [connectionAccess, setConnectionAccess] = useState<"read" | "act">(
    "act",
  );
  const [connectionCanAttach, setConnectionCanAttach] = useState(true);
  const [connectionDeviceLimit, setConnectionDeviceLimit] = useState(1);
  const [connectionSecret, setConnectionSecret] = useState<string | null>(null);
  const [secretContext, setSecretContext] = useState<"connections" | "device">(
    "connections",
  );
  const [deviceSetupTokenId, setDeviceSetupTokenId] = useState("new");
  const [deviceSetupName, setDeviceSetupName] = useState(
    "Device and agent token",
  );
  const [deviceSetupLifetime, setDeviceSetupLifetime] = useState(604800);
  const [deviceSetupKind, setDeviceSetupKind] = useState<
    "custom" | "pi" | "uno" | "esp32" | null
  >(null);
  const [deviceSetupPort, setDeviceSetupPort] = useState("");
  const [legacyKind, setLegacyKind] = useState("custom.device");
  const [setupConnection, setSetupConnection] = useState<Connection | null>(
    null,
  );
  const sdkArchiveUrl = `https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz${import.meta.env.VITE_OPENLAUNCH_BUILD_COMMIT ? `?commit=${import.meta.env.VITE_OPENLAUNCH_BUILD_COMMIT}` : ""}`;
  const adapterSetupCommand = `npx --yes --package=${quoteShellValue(sdkArchiveUrl)} openlaunch-device setup --url ${quoteShellValue(window.location.origin)}`;
  const codexConnectCommand =
    "codex mcp add openlaunch --url https://www.openlaunch.dev/mcp --oauth-client-registration cimd && codex mcp login openlaunch --scopes openid,openlaunch:read,openlaunch:act --oauth-client-registration cimd";
  const usbSetupCommand = (filename: string) =>
    `(ol_helper=$(mktemp) && trap 'rm -f "$ol_helper"' EXIT && curl -fsS --proto '=https' --max-redirs 0 ${quoteShellValue(`${window.location.origin}/downloads/${filename}`)} -o "$ol_helper" && python3 "$ol_helper" --port ${quoteShellValue(deviceSetupPort)} --origin ${quoteShellValue(window.location.origin)})`;
  const unoSetupCommand = usbSetupCommand("provision-uno.py");
  const esp32SetupCommand = usbSetupCommand("provision-esp32.py");
  const deviceSetupCommand =
    deviceSetupKind === "pi"
      ? "curl -fsSL https://www.openlaunch.dev/install-pi.sh | bash"
      : deviceSetupKind === "uno"
        ? unoSetupCommand
        : deviceSetupKind === "esp32"
          ? esp32SetupCommand
          : adapterSetupCommand;
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
  async function downloadHistory() {
    const history = await api("/v1/actions/export");
    const file = new Blob([JSON.stringify(history, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `openlaunch-activity-${new Date(history.exportedAt).toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`Downloaded ${history.actions.length} action receipts.`);
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
      if (document.visibilityState === "hidden") return;
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
            setSetupConnection(null);
            if (secretContext === "device") setConnectionSecret(null);
            setEnrollmentRevealed(false);
            setPairingBaseline(null);
            setAddOpen(false);
            setNotice(
              `${paired.name} is connected. Review its saved access; the SDK token does not grant itself permission to use functions.`,
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
    if (page !== "Activity" || (!session && !token)) return;
    let cancelled = false;
    const update = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const history = await api("/v1/actions");
        if (cancelled) return;
        setReceipts(history);
        setSelectedReceipt((receipt: any) =>
          receipt
            ? (history.find((item: any) => item.id === receipt.id) ?? receipt)
            : null,
        );
        setBroadcastResults((items: any[]) =>
          items.map((item) =>
            item.action
              ? {
                  ...item,
                  action:
                    history.find(
                      (receipt: any) => receipt.id === item.action.id,
                    ) ?? item.action,
                }
              : item,
          ),
        );
        const current =
          action && history.find((item: any) => item.id === action.id);
        if (current && current.status !== action.status) {
          setAction(current);
          setNotice(
            current.status === "queued"
              ? "Queued. Waiting for the device result…"
              : current.status === "received"
                ? "The device received the request. Waiting for its result…"
                : current.status === "succeeded"
                  ? "The device reported success. See the receipt for its result."
                  : current.status === "unknown"
                    ? "The outcome is unknown. Check the device before trying again."
                    : `Action ${current.status}. See the receipt for details.`,
          );
        }
      } catch {
        /* Keep the last known receipt rather than inventing an outcome. */
      }
    };
    update();
    const timer = setInterval(
      update,
      receipts.some((item) => ["queued", "received"].includes(item.status))
        ? 2000
        : 10000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    page,
    !!session,
    token,
    action?.id,
    action?.status,
    receipts.some((item) => ["queued", "received"].includes(item.status)),
  ]);
  const refresh = () =>
    run(async () => {
      const [inventory, agentConnections, activity, savedGrants] =
        await Promise.all([
          api("/v1/devices"),
          api("/v1/sdk-tokens"),
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
          setSetupConnection(null);
          if (secretContext === "device") setConnectionSecret(null);
          setEnrollmentRevealed(false);
          setPairingBaseline(null);
          setAddOpen(false);
          setNotice(
            `${paired.name} is connected. Review its saved access; the SDK token does not grant itself permission to use functions.`,
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
  const startDeviceSetup = () =>
    run(async () => {
      if (!deviceSetupKind) throw new Error("Choose a device type first.");
      if (
        (deviceSetupKind === "uno" || deviceSetupKind === "esp32") &&
        !deviceSetupPort.trim()
      )
        throw new Error("Enter the confirmed USB serial port first.");
      setEnrollment(null);
      setEnrollmentRevealed(false);
      if (deviceSetupTokenId === "new") {
        if (connectionSecret) {
          throw new Error(
            "Copy or finish the SDK token already being shown before creating another one.",
          );
        }
        setSecretContext("device");
        const created = await api("/v1/sdk-tokens", "POST", {
          name: deviceSetupName,
          ttlSeconds: deviceSetupLifetime,
          access: "act",
          canAttach: true,
          deviceLimit: 1,
        });
        setPairingBaseline(devices.map((device) => device.id));
        const { token: newSecret, ...safeConnection } = created;
        setSetupConnection(safeConnection);
        setConnectionSecret(newSecret);
        setConnections(await api("/v1/sdk-tokens"));
        setPrincipal(created.principal);
        setNotice(
          "One-device SDK token created. Copy it now, then enter it when the setup command prompts.",
        );
      } else {
        const connection = connections.find(
          (item) => item.id === deviceSetupTokenId,
        );
        if (!connection || !connection.canAttach)
          throw new Error(
            "Choose an active token that can attach devices, or create a new one.",
          );
        setPairingBaseline(devices.map((device) => device.id));
        setSetupConnection(connection);
        setPrincipal(connection.principal);
        setNotice(
          "Use the selected token when the setup command prompts. New device access still needs a saved grant.",
        );
      }
    });
  const request = (d: Device, capability: string, args: unknown) =>
    run(async () => {
      const definition =
        d.functions?.find((fn) => fn.name === capability) ??
        builtInFunctions.find((fn) => fn.name === capability);
      if (
        definition?.access === "write" &&
        !(await confirmAction(
          `Run ${d.functions?.find((fn) => fn.name === capability)?.title ?? builtInFunctions.find((fn) => fn.name === capability)?.title ?? capability} on ${d.name}?`,
        ))
      )
        return;
      const a = await api(`/v1/devices/${d.id}/actions`, "POST", {
        capability,
        arguments: args,
        idempotencyKey: crypto.randomUUID(),
        ttlSeconds: 60,
      });
      setAction(a);
      setSelectedReceipt(a);
      setPage("Activity");
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
            {(["Devices", "Connections", "Activity", "Build"] as const).map(
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
            {(["Devices", "Connections", "Activity", "Build"] as const).map(
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
                      setSetupConnection(null);
                      setEnrollmentRevealed(false);
                      setDeviceSetupTokenId("new");
                      setDeviceSetupKind(null);
                      setDeviceSetupPort("");
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
                    Connect an SDK adapter with a token. Function access is
                    approved separately for each device.
                  </p>
                  <button
                    disabled={busy || (!session && !token)}
                    onClick={() => {
                      setSetupConnection(null);
                      setEnrollment(null);
                      setDeviceSetupTokenId("new");
                      setDeviceSetupKind(null);
                      setDeviceSetupPort("");
                      setAddOpen(true);
                    }}
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
                    role="group"
                    aria-label={`${selectedDevice.name} detail views`}
                  >
                    {(["Functions", "Access", "Details"] as const).map(
                      (tab) => (
                        <button
                          type="button"
                          aria-pressed={detailTab === tab}
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
                            key={`${selectedDevice.id}:${name}:${JSON.stringify(definition.inputSchema)}`}
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
                              )?.title ??
                                builtInFunctions.find(
                                  (fn) => fn.name === capability,
                                )?.title ??
                                capability}
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

          {page === "Connections" && (
            <>
              <div className="page-header">
                <div>
                  <h1>Connections</h1>
                  <p>
                    One SDK token can connect an adapter and act as an agent,
                    within the access you approve.
                  </p>
                </div>
              </div>
              <section className="panel help-panel">
                <h2>Connect ChatGPT or Codex</h2>
                <p>
                  Use OAuth for ChatGPT and Codex. These connections do not need
                  an SDK token; control each one's access with the saved grants
                  on a device.
                </p>
                <div className="setup-command">
                  <code>https://www.openlaunch.dev/mcp</code>
                </div>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(
                          "https://www.openlaunch.dev/mcp",
                        );
                        setNotice("MCP URL copied.");
                      })
                    }
                  >
                    Copy MCP URL
                  </button>
                  <a href="/downloads/openlaunch-plugin.zip">Download plugin</a>
                  <a href="/docs/agents">Connection guide</a>
                </div>
                <details>
                  <summary>Connect Codex CLI</summary>
                  <div className="setup-command">
                    <code>{codexConnectCommand}</code>
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(
                          codexConnectCommand,
                        );
                        setNotice("Codex connection command copied.");
                      })
                    }
                  >
                    Copy Codex command
                  </button>
                </details>
              </section>
              <section className="panel">
                <h2>Create an SDK token</h2>
                <p>
                  Start with agent access and a one-device attachment limit.
                  Change its name and expiry below; advanced options can narrow
                  its access.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      const connection = await api("/v1/sdk-tokens", "POST", {
                        name: connectionName,
                        ttlSeconds: connectionLifetime,
                        access: connectionAccess,
                        canAttach: connectionCanAttach,
                        deviceLimit: connectionCanAttach
                          ? connectionDeviceLimit
                          : 0,
                      });
                      setConnectionSecret(connection.token);
                      setSecretContext("connections");
                      setPrincipal(connection.principal);
                      setConnections(await api("/v1/sdk-tokens"));
                      setNotice(
                        "SDK token created. Copy it now; it is shown only once.",
                      );
                    });
                  }}
                >
                  <label>
                    Token name
                    <input
                      value={connectionName}
                      maxLength={64}
                      required
                      onChange={(e) => setConnectionName(e.target.value)}
                    />
                  </label>
                  <label>
                    Expires
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
                  <details>
                    <summary>Advanced access and device options</summary>
                    <label>
                      Agent access
                      <select
                        value={connectionAccess}
                        onChange={(e) =>
                          setConnectionAccess(e.target.value as "read" | "act")
                        }
                      >
                        <option value="act">
                          Request functions approved for this token
                        </option>
                        <option value="read">
                          Read health and action results only
                        </option>
                      </select>
                    </label>
                    <label className="permission">
                      <input
                        type="checkbox"
                        checked={connectionCanAttach}
                        onChange={(e) =>
                          setConnectionCanAttach(e.target.checked)
                        }
                      />
                      Allow this token to attach devices
                    </label>
                    {connectionCanAttach && (
                      <label>
                        Device limit
                        <select
                          value={connectionDeviceLimit}
                          onChange={(e) =>
                            setConnectionDeviceLimit(Number(e.target.value))
                          }
                        >
                          {[1, 2, 5, 10, 20].map((limit) => (
                            <option key={limit} value={limit}>
                              {limit} {limit === 1 ? "device" : "devices"}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </details>
                  <button
                    disabled={
                      busy ||
                      !connectionName.trim() ||
                      connectionSecret !== null
                    }
                  >
                    Create SDK token
                  </button>
                </form>
                {connectionSecret && secretContext === "connections" && (
                  <div className="connection-secret">
                    <label>
                      SDK token · shown once
                      <textarea readOnly value={connectionSecret} />
                    </label>
                    <p>
                      Copy this token into your app's secret settings. The same
                      token can connect its allowed devices and request
                      functions you grant.
                    </p>
                    <div className="row">
                      <button
                        className="secondary"
                        onClick={() =>
                          run(async () => {
                            await navigator.clipboard.writeText(
                              connectionSecret,
                            );
                            setNotice("SDK token copied.");
                          })
                        }
                      >
                        Copy token
                      </button>
                      <button onClick={() => setConnectionSecret(null)}>
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <section className="panel">
                <h2>Active SDK tokens</h2>
                {connections.length ? (
                  <ul className="connection-list">
                    {connections.map((c) => (
                      <li key={c.id}>
                        <div>
                          <strong>{c.name}</strong>
                          <span>
                            Expires {new Date(c.expiresAt).toLocaleString()}
                          </span>
                          <span>
                            {c.access === "read"
                              ? "Read health and results"
                              : "Can request functions approved for this token"}
                          </span>
                          <span>
                            {c.canAttach
                              ? `${c.attachedDeviceCount ?? 0} of ${c.deviceLimit ?? 1} ${(c.deviceLimit ?? 1) === 1 ? "device" : "devices"} attached`
                              : "Cannot attach new devices"}
                          </span>
                        </div>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              if (
                                !(await confirmAction(
                                  `Revoke ${c.name}? Devices already attached with this token remain paired, but the token can no longer authorize agent requests or attach devices.`,
                                ))
                              )
                                return;
                              await api(
                                `/v1/sdk-tokens/${c.id}/revoke`,
                                "POST",
                                {},
                              );
                              if (principal === c.principal)
                                setPrincipal(
                                  session
                                    ? "https://chatgpt.com/oauth/codex/client.json"
                                    : "local-agent",
                                );
                              setConnectionSecret(null);
                              setConnections(await api("/v1/sdk-tokens"));
                              setGrants(await api("/v1/grants"));
                              setNotice(
                                "SDK token revoked. Previously attached devices remain paired and can be revoked individually.",
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
                  <p>No active SDK tokens.</p>
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
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={busy || (!session && !token)}
                    onClick={() =>
                      run(async () => {
                        setReceipts(await api("/v1/actions"));
                        setNotice("Activity refreshed.");
                      })
                    }
                  >
                    Refresh activity
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || (!session && !token)}
                    onClick={() => run(downloadHistory)}
                  >
                    Download full history
                  </button>
                </div>
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
                <p>
                  Showing the latest 100 actions. Download full history for all
                  saved receipts, including function arguments and results.
                </p>
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
                  {selectedReceipt.result !== undefined && (
                    <div className="receipt-result">
                      <h3>Device result</h3>
                      {selectedReceipt.result !== null &&
                      typeof selectedReceipt.result === "object" &&
                      !Array.isArray(selectedReceipt.result) ? (
                        <dl>
                          {Object.entries(selectedReceipt.result).map(
                            ([key, value]) => (
                              <React.Fragment key={key}>
                                <dt>
                                  {key
                                    .replace(/([a-z])([A-Z])/g, "$1 $2")
                                    .replaceAll("_", " ")}
                                </dt>
                                <dd>
                                  {typeof value === "boolean"
                                    ? value
                                      ? "Yes"
                                      : "No"
                                    : typeof value === "string" ||
                                        typeof value === "number"
                                      ? String(value)
                                      : JSON.stringify(value)}
                                </dd>
                              </React.Fragment>
                            ),
                          )}
                        </dl>
                      ) : (
                        <p>
                          {typeof selectedReceipt.result === "string"
                            ? selectedReceipt.result
                            : JSON.stringify(selectedReceipt.result)}
                        </p>
                      )}
                    </div>
                  )}
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
                  hardware. It creates a starter adapter and prompts for the SDK
                  token in the terminal.
                </p>
                <button
                  disabled={busy || (!session && !token)}
                  onClick={() => {
                    setEnrollment(null);
                    setSetupConnection(null);
                    setEnrollmentRevealed(false);
                    setDeviceSetupTokenId("new");
                    setDeviceSetupKind(null);
                    setDeviceSetupPort("");
                    setAddOpen(true);
                  }}
                >
                  Set up an SDK adapter
                </button>
              </section>
              <section className="panel">
                <h2>SDK command</h2>
                <pre>{adapterSetupCommand}</pre>
                <p>
                  The token is entered at the prompt and stays out of the
                  command. Create one under Connections, or start setup from
                  Devices to create a one-device token.
                </p>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(adapterSetupCommand);
                      setNotice("Setup command copied.");
                    })
                  }
                >
                  Copy SDK setup command
                </button>
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
          setSetupConnection(null);
          if (secretContext === "device") setConnectionSecret(null);
        }}
      >
        <div className="page-header">
          <div>
            <h2 id="connect-title">
              {setupConnection
                ? `Set up ${deviceSetupKind === "pi" ? "Raspberry Pi 4" : deviceSetupKind === "uno" ? "Uno R4 WiFi" : deviceSetupKind === "esp32" ? "ESP32" : "Node adapter"}`
                : enrollment
                  ? "Legacy enrollment"
                  : "Add a device"}
            </h2>
            <p>
              {setupConnection
                ? "Use the same SDK token for device attachment and later agent requests."
                : enrollment
                  ? "Compatibility flow for an adapter that already uses one-time enrollment."
                  : "Choose a board or adapter to see its setup command."}
            </p>
          </div>
          <button
            className="secondary"
            onClick={() => {
              setAddOpen(false);
              setEnrollment(null);
              setSetupConnection(null);
              if (secretContext === "device") setConnectionSecret(null);
            }}
          >
            Close
          </button>
        </div>
        {setupConnection ? (
          <div className="enrollment-steps">
            <h3>
              {deviceSetupKind === "pi"
                ? "Raspberry Pi 4"
                : deviceSetupKind === "uno"
                  ? "Arduino Uno R4 WiFi"
                  : deviceSetupKind === "esp32"
                    ? "Standalone ESP32"
                    : "Linux / desktop Node adapter"}
            </h3>
            {deviceSetupKind === "pi" ? (
              <p>
                Run this installer on Raspberry Pi OS. It prompts for the SDK
                token privately, downloads the matching runtime, and attaches
                the device.
              </p>
            ) : deviceSetupKind === "uno" ? (
              <>
                <p>
                  This helper sends Wi-Fi settings and the SDK token over USB
                  after you confirm. It does not flash firmware.
                </p>
                <p>
                  Flash the matching stock or console-mux profile first and
                  confirm the USB port. See the{" "}
                  <a href="/docs/uno-r4">Uno setup guide</a>.
                </p>
              </>
            ) : deviceSetupKind === "esp32" ? (
              <>
                <p>
                  Upload the ESP32 firmware first. The helper configures Wi-Fi
                  and the SDK token over USB; it does not flash firmware.
                </p>
                <p>
                  For the hosted openlaunch origin, it uses its embedded
                  verified public CA. Custom origins need an explicit CA
                  configured in firmware. See{" "}
                  <a href="/docs/sdk">ESP32 setup notes</a>.
                </p>
              </>
            ) : (
              <p>
                Run this command on a Linux or desktop machine with Node.js 22
                or newer and access to your hardware library.
              </p>
            )}
            <div className="setup-command">
              <code>{deviceSetupCommand}</code>
            </div>
            <button
              className="secondary"
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(deviceSetupCommand);
                  setNotice("Setup command copied.");
                })
              }
            >
              Copy setup command
            </button>
            {connectionSecret && secretContext === "device" && (
              <div className="connection-secret">
                <label>
                  SDK token · shown once
                  <textarea readOnly value={connectionSecret} />
                </label>
                <p>
                  Copy it now. The setup command prompts for this token without
                  placing it in shell history. This same token can later act as
                  an agent within the grants you approve.
                </p>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(connectionSecret);
                        setNotice("SDK token copied.");
                      })
                    }
                  >
                    Copy token
                  </button>
                  <button onClick={() => setConnectionSecret(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}
            {!(connectionSecret && secretContext === "device") && (
              <p>
                When prompted, enter this token from your password manager. The
                secret is shown once when created.
              </p>
            )}
            <p>
              Attaching the device does not approve any function grants. After
              it appears, review its Access tab.
            </p>
            <div className="row">
              <button className="secondary" disabled={busy} onClick={refresh}>
                Refresh inventory
              </button>
              <a
                href={
                  deviceSetupKind === "uno"
                    ? "/docs/uno-r4"
                    : deviceSetupKind === "pi"
                      ? "/docs/pi"
                      : "/docs/sdk"
                }
              >
                Setup guide
              </a>
            </div>
          </div>
        ) : enrollment ? (
          <div className="enrollment-steps">
            <h3>One-time enrollment · compatibility</h3>
            <p>
              This code is for an existing adapter that already supports the
              legacy enrollment endpoint. New installations should use an SDK
              token from the setup flow.
            </p>
            <p>
              {Date.now() >= enrollment.expiresAt
                ? "This code expired. Close setup and create another if your legacy adapter needs it."
                : `This code works once and expires at ${new Date(enrollment.expiresAt).toLocaleTimeString()}.`}
            </p>
            <details>
              <summary>Workspace routing value</summary>
              <code>{enrollment.workspace}</code>
            </details>
            {enrollmentRevealed ? (
              <>
                <label>
                  One-time enrollment code
                  <textarea readOnly value={enrollment.token} />
                </label>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(enrollment.token);
                        setNotice("Legacy enrollment code copied.");
                      })
                    }
                  >
                    Copy code
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setEnrollmentRevealed(false)}
                  >
                    Hide code
                  </button>
                </div>
              </>
            ) : (
              <button
                disabled={Date.now() >= enrollment.expiresAt}
                onClick={() => setEnrollmentRevealed(true)}
              >
                Show one-time code
              </button>
            )}
            <div className="row">
              <button className="secondary" disabled={busy} onClick={refresh}>
                Refresh inventory
              </button>
              <a href="/docs/api">Legacy API reference</a>
            </div>
          </div>
        ) : (
          <div className="connect-options">
            {connectionSecret && secretContext === "connections" && (
              <p>
                Finish copying the SDK token shown on Connections before
                creating another. You can continue with an existing token.
              </p>
            )}
            <section className="panel">
              <h3>Choose a device or adapter</h3>
              <div className="device-grid">
                {(
                  [
                    [
                      "custom",
                      "Linux / desktop Node adapter",
                      "Run the Node SDK beside your hardware or service.",
                    ],
                    [
                      "pi",
                      "Raspberry Pi 4",
                      "Install the native Linux runtime on Raspberry Pi OS.",
                    ],
                    [
                      "uno",
                      "Arduino Uno R4 WiFi",
                      "Configure matching flashed firmware over its confirmed USB port.",
                    ],
                    [
                      "esp32",
                      "Standalone ESP32",
                      "Configure uploaded firmware over its confirmed USB port.",
                    ],
                  ] as const
                ).map(([kind, title, description]) => (
                  <button
                    type="button"
                    key={kind}
                    className="connect-option"
                    aria-pressed={deviceSetupKind === kind}
                    onClick={() => {
                      setDeviceSetupKind(kind);
                      setDeviceSetupPort("");
                    }}
                  >
                    <strong>{title}</strong>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
              {deviceSetupKind && (
                <div className="enrollment-steps">
                  {deviceSetupKind === "uno" && (
                    <label>
                      Confirmed Uno USB serial port
                      <input
                        value={deviceSetupPort}
                        placeholder="/dev/cu.usbmodem… or /dev/ttyACM0"
                        onChange={(e) => setDeviceSetupPort(e.target.value)}
                      />
                    </label>
                  )}
                  {deviceSetupKind === "esp32" && (
                    <>
                      <label>
                        Confirmed ESP32 USB serial port
                        <input
                          value={deviceSetupPort}
                          placeholder="/dev/cu.usbserial… or /dev/ttyUSB0"
                          onChange={(e) => setDeviceSetupPort(e.target.value)}
                        />
                      </label>
                      <p>
                        The standalone ESP32 helper uses the embedded verified
                        public root for the hosted openlaunch origin.
                      </p>
                    </>
                  )}
                  <label>
                    SDK token
                    <select
                      value={deviceSetupTokenId}
                      onChange={(e) => setDeviceSetupTokenId(e.target.value)}
                    >
                      <option value="new">Create a new one-device token</option>
                      {connections
                        .filter((c) => c.canAttach && c.expiresAt > Date.now())
                        .map((c) => (
                          <option
                            key={c.id}
                            value={c.id}
                            disabled={
                              (c.attachedDeviceCount ?? 0) >=
                              (c.deviceLimit ?? 1)
                            }
                          >
                            {c.name} · {c.attachedDeviceCount ?? 0}/
                            {c.deviceLimit ?? 1} devices ·{" "}
                            {c.access === "read" ? "read-only" : "agent access"}{" "}
                            · expires{" "}
                            {new Date(c.expiresAt).toLocaleDateString()}
                          </option>
                        ))}
                    </select>
                  </label>
                  {deviceSetupTokenId === "new" ? (
                    <>
                      <label>
                        Token name
                        <input
                          value={deviceSetupName}
                          maxLength={64}
                          onChange={(e) => setDeviceSetupName(e.target.value)}
                        />
                      </label>
                      <label>
                        Token expires
                        <select
                          value={deviceSetupLifetime}
                          onChange={(e) =>
                            setDeviceSetupLifetime(Number(e.target.value))
                          }
                        >
                          <option value={86400}>In 24 hours</option>
                          <option value={604800}>In 7 days</option>
                          <option value={2592000}>In 30 days</option>
                        </select>
                      </label>
                      <button
                        disabled={
                          busy ||
                          !deviceSetupName.trim() ||
                          connectionSecret !== null ||
                          ((deviceSetupKind === "uno" ||
                            deviceSetupKind === "esp32") &&
                            !deviceSetupPort.trim())
                        }
                        onClick={startDeviceSetup}
                      >
                        Create token and continue
                      </button>
                    </>
                  ) : (
                    <>
                      <p>
                        The token secret is shown only when first created. Have
                        it ready for the helper prompt. Its device limit is
                        enforced when the adapter attaches.
                      </p>
                      <button
                        disabled={
                          busy ||
                          ((deviceSetupKind === "uno" ||
                            deviceSetupKind === "esp32") &&
                            !deviceSetupPort.trim())
                        }
                        onClick={startDeviceSetup}
                      >
                        Continue with selected token
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
            <details>
              <summary>Compatibility: existing one-time enrollment</summary>
              <p>
                For an already-installed adapter that implements the old
                one-time enrollment endpoint. This does not create an SDK token
                or grant agent permissions.
              </p>
              <label>
                Adapter type
                <select
                  value={legacyKind}
                  onChange={(e) => setLegacyKind(e.target.value)}
                >
                  <option value="custom.device">Custom adapter</option>
                  <option value="uno-r4-wifi">Uno R4 WiFi</option>
                  <option value="raspberry-pi-4">Raspberry Pi 4</option>
                </select>
              </label>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const legacy = await api("/v1/enrollments", "POST", {
                      kind: legacyKind,
                    });
                    setPairingBaseline(devices.map((d) => d.id));
                    setSetupConnection(null);
                    setEnrollment(legacy);
                    setEnrollmentRevealed(false);
                  })
                }
              >
                Create one-time code
              </button>
            </details>
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
  const required = definition.inputSchema.required;
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      Object.entries(definition.inputSchema.properties)
        .filter(
          ([name, schema]) =>
            required.includes(name) &&
            (schema.type === "boolean" ||
              (schema.type === "string" &&
                !schema.enum &&
                (schema.minLength ?? 0) === 0)),
        )
        .map(([name, schema]) => [
          name,
          schema.type === "boolean" ? false : "",
        ]),
    ),
  );
  return (
    <form
      className="function-form"
      onSubmit={(event) => {
        event.preventDefault();
        const properties = definition.inputSchema.properties;
        onRequest(
          Object.fromEntries(
            Object.entries(values).filter(([name]) =>
              Object.hasOwn(properties, name),
            ),
          ),
        );
      }}
    >
      <h4>{definition.title}</h4>
      <p>{definition.description}</p>
      {Object.entries(definition.inputSchema.properties).map(
        ([name, schema]) => (
          <label key={name}>
            {schema.description ?? name}
            {schema.type === "boolean" && required.includes(name) ? (
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
            ) : schema.type === "boolean" ? (
              <select
                aria-label={schema.description ?? name}
                value={
                  typeof values[name] === "boolean"
                    ? values[name]
                      ? "true"
                      : "false"
                    : ""
                }
                onChange={(event) =>
                  setValues((current) => {
                    const next = { ...current };
                    if (event.target.value === "") delete next[name];
                    else next[name] = event.target.value === "true";
                    return next;
                  })
                }
              >
                <option value="">Default</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            ) : schema.type === "string" && schema.enum ? (
              <select
                required={required.includes(name)}
                value={
                  Object.hasOwn(values, name)
                    ? (JSON.stringify(values[name]) ?? "")
                    : ""
                }
                onChange={(event) =>
                  setValues((current) => {
                    const next = { ...current };
                    if (event.target.value === "") delete next[name];
                    else next[name] = JSON.parse(event.target.value) as string;
                    return next;
                  })
                }
              >
                <option value="">Choose a value</option>
                {schema.enum.map((value) => (
                  <option key={value} value={JSON.stringify(value)}>
                    {value === "" ? "Empty" : value}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required={
                  schema.type === "string"
                    ? required.includes(name) && (schema.minLength ?? 0) > 0
                    : required.includes(name)
                }
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
                    if (event.target.value === "") {
                      if (
                        schema.type === "string" &&
                        required.includes(name) &&
                        (schema.minLength ?? 0) === 0
                      )
                        next[name] = "";
                      else delete next[name];
                    } else
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
