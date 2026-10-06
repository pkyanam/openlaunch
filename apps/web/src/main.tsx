import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { screenshotSource } from "./receipt";
import logoUrl from "../../site/public/icon.svg?url";
import { OAuthClients, type OAuthConnection } from "./OAuthClients";
import {
  ClerkProvider,
  SignIn,
  UserButton,
  useAuth,
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
  gatewayId?: string;
  gatewayKey?: string;
  gatewayDeviceLimit?: number;
  gatewayConnected?: boolean;
};
const quoteShellValue = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
type Connection = {
  id: string;
  principal: string;
  name: string;
  expiresAt: number | null;
  access: "read" | "act";
  canAttach?: boolean;
  deviceLimit?: number;
  attachedDeviceCount?: number;
  purpose?: "agent" | "legacy";
};
type DeviceSetupToken = {
  id: string;
  principal: string;
  name: string;
  expiresAt: number;
  canAttach: boolean;
  deviceLimit: number;
  gatewayDeviceLimit?: number;
  attachedDeviceCount?: number;
  purpose?: "device-setup" | "legacy";
};
type Grant = {
  id?: string;
  principal: string;
  deviceId: string;
  capabilities: string[];
  expiresAt: number | null;
};

const consolePages = ["Devices", "Connections", "Activity", "Build"] as const;
const consolePageFromHash = () =>
  consolePages.find(
    (item) => "#" + item.toLowerCase() === window.location.hash,
  ) ?? "Devices";
function DeviceIcon({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      {kind.includes("home-assistant") ? (
        <>
          <path d="m3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7" />
        </>
      ) : kind === "linux" || kind.includes("pi") ? (
        <>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4m-5-9 2-2-2-2m4 4h5" />
        </>
      ) : (
        <>
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" />
        </>
      )}
    </svg>
  );
}
const deviceKindLabel = (kind: string) =>
  kind === "gateway.home-assistant"
    ? "Home Assistant gateway"
    : kind === "home-assistant.entity"
      ? "Home Assistant entity"
      : kind === "home-assistant.device"
        ? "Home Assistant device"
        : kind === "home-assistant.service"
          ? "Home Assistant service"
          : kind === "linux"
            ? "Linux computer"
            : kind === "uno-r4-wifi"
              ? "Uno R4 WiFi"
              : kind === "raspberry-pi" || kind === "raspberry-pi-4"
                ? "Raspberry Pi"
                : kind === "esp32"
                  ? "ESP32"
                  : kind;
const connectionTabs = [
  "Prompt",
  "MCP URL",
  "Command",
  "OAuth clients",
  "API token",
] as const;
function NavigationIcon({ page }: { page: (typeof consolePages)[number] }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 20 20"
      width="17"
      height="17"
      aria-hidden="true"
      focusable="false"
      {...common}
    >
      {page === "Devices" ? (
        <>
          <rect x="2.75" y="2.75" width="5.5" height="5.5" rx="1" />
          <rect x="11.75" y="2.75" width="5.5" height="5.5" rx="1" />
          <rect x="2.75" y="11.75" width="5.5" height="5.5" rx="1" />
          <rect x="11.75" y="11.75" width="5.5" height="5.5" rx="1" />
        </>
      ) : page === "Connections" ? (
        <>
          <path d="m7.5 12.5 5-5" />
          <path d="M6.25 8.75 4.5 10.5a3 3 0 0 0 4.25 4.25l1.75-1.75" />
          <path d="m13.75 11.25 1.75-1.75a3 3 0 0 0-4.25-4.25L9.5 7" />
        </>
      ) : page === "Activity" ? (
        <path d="M2.5 10h3l2-5.5 4 11 2-5.5h4" />
      ) : (
        <>
          <path d="m6.5 5-4 5 4 5" />
          <path d="m13.5 5 4 5-4 5" />
          <path d="m11.5 3-3 14" />
        </>
      )}
    </svg>
  );
}

function ConsoleNavigation({
  page,
  onSelect,
}: {
  page: (typeof consolePages)[number];
  onSelect: (page: (typeof consolePages)[number]) => void;
}) {
  return (
    <>
      {consolePages.map((item) => (
        <button
          type="button"
          key={item}
          className={page === item ? "active" : ""}
          aria-current={page === item ? "page" : undefined}
          onClick={() => onSelect(item)}
        >
          <NavigationIcon page={item} />
          <span>{item}</span>
        </button>
      ))}
    </>
  );
}
function App({ session }: { session?: () => Promise<string | null> }) {
  const [token, setToken] = useState(""),
    [devices, setDevices] = useState<Device[]>([]),
    [deviceSearch, setDeviceSearch] = useState(""),
    [deviceStatusFilter, setDeviceStatusFilter] = useState<
      "all" | "online" | "offline"
    >("all"),
    [notice, setNoticeValue] = useState(""),
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
    [grantLifetime, setGrantLifetime] = useState<number | null>(null),
    [broadcastDevices, setBroadcastDevices] = useState<string[]>([]),
    [broadcastFunction, setBroadcastFunction] = useState("device.health"),
    [broadcastResults, setBroadcastResults] = useState<any[]>([]);
  const [page, setPage] = useState<
    "Devices" | "Connections" | "Activity" | "Build"
  >(consolePageFromHash);
  useEffect(() => {
    const sync = () => setPage(consolePageFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    const hash = "#" + page.toLowerCase();
    if (window.location.hash !== hash)
      window.history.replaceState(null, "", hash);
    document.title = page + " · openlaunch";
  }, [page]);
  const navigatePage = (next: (typeof consolePages)[number]) => {
    window.location.hash = next.toLowerCase();
    setPage(next);
  };
  const [devicesLoadState, setDevicesLoadState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [connectionTab, setConnectionTab] =
    useState<(typeof connectionTabs)[number]>("Prompt");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<
    "Functions" | "Access" | "Details"
  >("Functions");
  const [addOpen, setAddOpen] = useState(false);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const receiptImage = screenshotSource(selectedReceipt);
  const [pairingBaseline, setPairingBaseline] = useState<string[] | null>(null);
  const [enrollmentRevealed, setEnrollmentRevealed] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const connectDialog = useRef<HTMLDialogElement>(null);
  const [noticeError, setNoticeError] = useState(false);
  const setNotice = (value: string) => {
    setNoticeValue(value);
    setNoticeError(false);
  };
  const actionReceiptNotice =
    /^(Queued\.|The device received|The device reported success|The outcome is unknown|Action .*See the receipt)/.test(
      notice,
    );
  useEffect(() => {
    if (!notice || noticeError || actionReceiptNotice) return;
    const timer = window.setTimeout(() => setNoticeValue(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeError, actionReceiptNotice]);
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
  const [oauthConnections, setOAuthConnections] = useState<OAuthConnection[]>(
    [],
  );
  const [oauthRegistrationAvailable, setOAuthRegistrationAvailable] =
    useState(false);
  const [deviceSetupTokens, setDeviceSetupTokens] = useState<
    DeviceSetupToken[]
  >([]);
  const [connectionName, setConnectionName] = useState("My app");
  const [connectionLifetime, setConnectionLifetime] = useState<number | null>(
    null,
  );
  const [connectionAccess, setConnectionAccess] = useState<"read" | "act">(
    "act",
  );
  const [connectionSecret, setConnectionSecret] = useState<string | null>(null);
  const [secretContext, setSecretContext] = useState<"agents" | "device">(
    "agents",
  );
  const [deviceSetupTokenId, setDeviceSetupTokenId] = useState("new");
  const [deviceSetupName, setDeviceSetupName] = useState("Device setup token");
  const [deviceSetupLifetime, setDeviceSetupLifetime] = useState(600);
  const [deviceSetupKind, setDeviceSetupKind] = useState<
    "custom" | "pi" | "linux" | "uno" | "esp32" | "home-assistant" | null
  >(null);
  const [gatewayGrantMode, setGatewayGrantMode] = useState<"read" | "control">(
    "control",
  );
  const [gatewayIncludeServices, setGatewayIncludeServices] = useState(false);
  const [deviceSetupPort, setDeviceSetupPort] = useState("");
  const [legacyKind, setLegacyKind] = useState("custom.device");
  const [setupConnection, setSetupConnection] =
    useState<DeviceSetupToken | null>(null);
  const hostedSetupCommand = (mode: string, args = "") =>
    `curl -fsSL https://www.openlaunch.dev/setup.sh | bash -s -- ${mode}${args}`;
  const setupOriginOption =
    window.location.origin === "https://www.openlaunch.dev"
      ? ""
      : ` --origin ${quoteShellValue(window.location.origin)}`;
  const adapterSetupCommand = hostedSetupCommand(
    "adapter",
    window.location.origin === "https://www.openlaunch.dev"
      ? ""
      : ` setup --url ${quoteShellValue(window.location.origin)}`,
  );
  const mcpServerUrl = `${window.location.origin}/mcp`;
  const connectPrompt = `Connect to the openlaunch MCP server at ${mcpServerUrl} using OAuth. Use only functions I have granted. Check action results before reporting success.`;
  const codexConnectCommand = `codex mcp add openlaunch --url ${mcpServerUrl} --oauth-client-registration cimd`;
  const unoSetupCommand = hostedSetupCommand("uno", setupOriginOption);
  const esp32SetupCommand = hostedSetupCommand(
    "esp32",
    ` --port ${quoteShellValue(deviceSetupPort)}${setupOriginOption}`,
  );
  const deviceSetupCommand =
    deviceSetupKind === "home-assistant"
      ? hostedSetupCommand("home-assistant")
      : deviceSetupKind === "linux"
        ? hostedSetupCommand("linux")
        : deviceSetupKind === "pi"
          ? hostedSetupCommand("pi")
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
      setNoticeValue(e instanceof Error ? e.message : "Request failed");
      setNoticeError(true);
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
              `${paired.name} is connected. Review its saved access; device setup credentials do not grant permission to use functions.`,
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
                  ? current.result?.physicalVerified === false &&
                    current.result?.transport === "serial_command_sent"
                    ? "Serial command sent. Physical operation is unverified."
                    : "The device reported success. See the receipt for its result."
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
  const refresh = () => {
    setDevicesLoadState("loading");
    return run(async () => {
      try {
        const [
          inventory,
          agentConnections,
          setupTokens,
          activity,
          savedGrants,
          oauthClients,
        ] = await Promise.all([
          api("/v1/devices"),
          api("/v1/agent-connections"),
          api("/v1/device-setup-tokens"),
          api("/v1/actions"),
          api("/v1/grants"),
          api("/v1/oauth-clients"),
        ]);
        setDevices(inventory);
        setDevicesLoadState("loaded");
        setConnections(agentConnections);
        setOAuthConnections(oauthClients.clients);
        setOAuthRegistrationAvailable(oauthClients.available);
        setDeviceSetupTokens(setupTokens);
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
              `${paired.name} is connected. Review its saved access; device setup credentials do not grant permission to use functions.`,
            );
          } else {
            setNotice(
              "Inventory refreshed. Your device has not appeared yet; keep its adapter running and refresh again.",
            );
          }
          return;
        }
        setNotice("");
      } catch (error) {
        setDevicesLoadState("error");
        throw error;
      }
    });
  };
  const startDeviceSetup = () =>
    run(async () => {
      if (!deviceSetupKind) throw new Error("Choose a device type first.");
      if (deviceSetupKind === "esp32" && !deviceSetupPort.trim())
        throw new Error("Enter the confirmed USB serial port first.");
      setEnrollment(null);
      setEnrollmentRevealed(false);
      if (deviceSetupTokenId === "new") {
        if (connectionSecret) {
          throw new Error(
            "Copy or finish the token already being shown before creating another one.",
          );
        }
        setSecretContext("device");
        const created = await api("/v1/device-setup-tokens", "POST", {
          name: deviceSetupName,
          ttlSeconds: deviceSetupLifetime,
          deviceLimit: 1,
          ...(deviceSetupKind === "home-assistant"
            ? { gatewayDeviceLimit: 2000 }
            : {}),
        });
        setPairingBaseline(devices.map((device) => device.id));
        const { token: newSecret, ...safeConnection } = created;
        setSetupConnection(safeConnection);
        setConnectionSecret(newSecret);
        setDeviceSetupTokens(await api("/v1/device-setup-tokens"));
        setNotice(
          "One-device setup token created. Copy it now, then enter it when the setup command prompts.",
        );
      } else {
        const connection = deviceSetupTokens.find(
          (item) => item.id === deviceSetupTokenId,
        );
        if (!connection || !connection.canAttach)
          throw new Error(
            "Choose an active device setup token, or create a new one.",
          );
        setPairingBaseline(devices.map((device) => device.id));
        setSetupConnection(connection);
        setNotice(
          "Use the selected device setup token when prompted. It cannot make agent requests; device access still needs a saved grant.",
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
        : ([...connections, ...oauthConnections].find(
            (connection) => connection.principal === value,
          )?.name ?? "Custom agent");
  const grantPrincipalLabel = principalLabel(principal);
  const visibleDevices = devices.filter((device) => {
    const query = deviceSearch.trim().toLocaleLowerCase();
    const matchesQuery =
      !query ||
      device.name.toLocaleLowerCase().includes(query) ||
      device.kind.toLocaleLowerCase().includes(query) ||
      device.functions?.some((fn) =>
        fn.description.toLocaleLowerCase().includes(query),
      );
    const matchesStatus =
      deviceStatusFilter === "all" ||
      (deviceStatusFilter === "online" ? device.online : !device.online);
    return matchesQuery && matchesStatus && (!device.gatewayId || !!query);
  });
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
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="console-header">
        <a className="brand" href="/" aria-label="openlaunch home">
          <img src={logoUrl} width="30" height="27" alt="" />
          <span>openlaunch</span>
        </a>
        <div className="console-header-tools">
          <nav className="console-nav mobile-nav" aria-label="Console sections">
            <ConsoleNavigation page={page} onSelect={navigatePage} />
          </nav>
          {!session && (
            <span className="badge mobile-session-badge">
              Local owner session
            </span>
          )}
          {session ? (
            <span className="mobile-user-control">
              <UserButton />
            </span>
          ) : null}
        </div>
      </header>
      <div className="console-layout">
        <aside className="console-sidebar" aria-label="Console sections">
          <a
            className="brand sidebar-brand"
            href="/"
            aria-label="openlaunch home"
          >
            <img src={logoUrl} width="28" height="26" alt="" />
            <span>openlaunch</span>
          </a>
          <p className="sidebar-label">Your workspace</p>
          <nav className="console-nav" aria-label="Console sections">
            <ConsoleNavigation page={page} onSelect={navigatePage} />
          </nav>
          <nav className="sidebar-resources" aria-label="Developer resources">
            <p className="sidebar-label">Developers</p>
            <a href="/docs/agents">
              Connect an agent <span aria-hidden="true">↗</span>
            </a>
            <a href="/docs/home-assistant">
              Home Assistant <span aria-hidden="true">↗</span>
            </a>
            <a href="/docs/reference">
              API reference <span aria-hidden="true">↗</span>
            </a>
            <a href="/docs/cli">
              ol CLI <span aria-hidden="true">↗</span>
            </a>
          </nav>
          <div className="sidebar-bottom">
            <a href="/docs">
              <svg
                className="resource-icon"
                viewBox="0 0 20 20"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M4 3.5h8.5A2.5 2.5 0 0 1 15 6v10.5H6.5A2.5 2.5 0 0 1 4 14z" />
                <path d="M4 14a2.5 2.5 0 0 1 2.5-2.5H15M7 6.5h4.5" />
              </svg>
              Documentation
            </a>
            <a href="https://github.com/pkyanam/openlaunch">
              Source on GitHub <span aria-hidden="true">↗</span>
            </a>
            {!session && <span className="sidebar-session">Local owner</span>}
            {session && (
              <span className="sidebar-user-control">
                <UserButton />
              </span>
            )}
          </div>
        </aside>
        <main className="console-main" id="main" tabIndex={-1}>
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
                  setDevicesLoadState("idle");
                  setConnections([]);
                  setOAuthConnections([]);
                  setOAuthRegistrationAvailable(false);
                  setConnectionTab("Prompt");
                  setConnectionSecret(null);
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
          {notice && (
            <div
              role={noticeError ? "alert" : "status"}
              aria-live={noticeError ? "assertive" : "polite"}
              className={`notice ${noticeError ? "notice-error" : ""}`}
            >
              <span>{notice}</span>
              <button
                type="button"
                className="notice-dismiss"
                aria-label="Dismiss message"
                onClick={() => {
                  setNotice("");
                  setNoticeError(false);
                }}
              >
                ×
              </button>
            </div>
          )}

          {page === "Devices" && (
            <>
              <div className="page-header">
                <div>
                  <h1>
                    Devices{" "}
                    <span className="device-count">
                      {devices.filter((d) => !d.gatewayId).length}
                    </span>
                    {devices.some((d) => d.gatewayId) && (
                      <span className="device-count">
                        {devices.filter((d) => d.gatewayId).length} linked
                      </span>
                    )}
                  </h1>
                  <p>
                    Your connected hardware and gateways. Inspect functions and
                    choose what each agent can use.
                  </p>
                </div>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() => navigatePage("Connections")}
                  >
                    Connect an agent
                  </button>
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
              <div className="device-toolbar" role="search">
                <label className="device-search">
                  <span className="sr-only">
                    Search devices by name or type
                  </span>
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <circle cx="8.5" cy="8.5" r="5.5" />
                    <path d="m12.5 12.5 4 4" />
                  </svg>
                  <input
                    type="search"
                    value={deviceSearch}
                    onChange={(event) => setDeviceSearch(event.target.value)}
                    placeholder="Search devices"
                    disabled={devices.length === 0}
                  />
                </label>
                <label className="device-filter">
                  <span>Filters</span>
                  <select
                    aria-label="Filter devices by status"
                    value={deviceStatusFilter}
                    onChange={(event) =>
                      setDeviceStatusFilter(
                        event.target.value as "all" | "online" | "offline",
                      )
                    }
                    disabled={devices.length === 0}
                  >
                    <option value="all">All statuses</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </select>
                </label>
              </div>
              {devices.length === 0 && devicesLoadState === "error" ? (
                <section className="empty-state panel" role="alert">
                  <h2>Devices could not be loaded</h2>
                  <p>Check the connection and try again.</p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={refresh}
                  >
                    Retry
                  </button>
                </section>
              ) : devices.length === 0 &&
                (devicesLoadState === "loading" ||
                  (devicesLoadState === "idle" && !!session)) ? (
                <section
                  className="empty-state panel"
                  role="status"
                  aria-live="polite"
                >
                  <h2>Loading devices</h2>
                  <p>Retrieving the current device inventory.</p>
                </section>
              ) : devices.length === 0 &&
                !session &&
                devicesLoadState === "idle" ? (
                <section className="empty-state panel">
                  <h2>Connect to your server</h2>
                  <p>
                    Enter your development owner token above to load devices.
                  </p>
                </section>
              ) : devices.length === 0 ? (
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
              ) : visibleDevices.length === 0 ? (
                <section className="empty-state panel">
                  <h2>No devices match</h2>
                  <p>Try another name or status filter.</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setDeviceSearch("");
                      setDeviceStatusFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                </section>
              ) : (
                <div className="device-grid">
                  {visibleDevices.map((d) => (
                    <article
                      className={`device-card ${selectedDeviceId === d.id ? "selected" : ""}`}
                      key={d.id}
                    >
                      <div className="device-card-heading">
                        <span
                          className={
                            "device-card-icon" +
                            (d.kind.includes("home-assistant")
                              ? " ha-device-icon"
                              : "")
                          }
                          aria-hidden="true"
                        >
                          <DeviceIcon kind={d.kind} />
                        </span>
                        <div className="device-card-title">
                          <button
                            type="button"
                            className="device-card-open"
                            aria-label={`Open ${d.name}`}
                            onClick={() => {
                              setSelectedDeviceId(d.id);
                              setDetailTab("Functions");
                            }}
                          >
                            <span>{d.name}</span>
                            <svg
                              viewBox="0 0 20 20"
                              aria-hidden="true"
                              focusable="false"
                            >
                              <path d="m7 4 6 6-6 6" />
                            </svg>
                          </button>
                          <span className="device-kind">
                            {deviceKindLabel(d.kind)}
                          </span>
                        </div>
                      </div>
                      <div className="device-card-footer">
                        <span className="device-status">
                          <span className={`dot ${d.online ? "online" : ""}`} />
                          {d.online ? "Online" : "Offline"}
                        </span>
                        <span>
                          {d.gatewayDeviceLimit
                            ? devices.filter(
                                (child) => child.gatewayId === d.id,
                              ).length + " linked · "
                            : ""}
                          {d.capabilities.length}{" "}
                          {d.capabilities.length === 1
                            ? "function"
                            : "functions"}
                        </span>
                      </div>
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
                  {selectedDevice.gatewayId && (
                    <p>
                      Connected through{" "}
                      <button
                        className="secondary"
                        onClick={() =>
                          setSelectedDeviceId(selectedDevice.gatewayId!)
                        }
                      >
                        {devices.find((d) => d.id === selectedDevice.gatewayId)
                          ?.name ?? "gateway"}
                      </button>
                    </p>
                  )}
                  {selectedDevice.gatewayDeviceLimit && (
                    <details className="grant-editor">
                      <summary>
                        Linked devices ·{" "}
                        {
                          devices.filter(
                            (d) => d.gatewayId === selectedDevice.id,
                          ).length
                        }
                      </summary>
                      <p>
                        Entities include helpers, scripts and scenes.
                        Integration-wide services are separate virtual devices.
                      </p>
                      <label>
                        Inspect a linked entity or service
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              setSelectedDeviceId(e.target.value);
                          }}
                        >
                          <option value="">Choose a device</option>
                          {devices
                            .filter((d) => d.gatewayId === selectedDevice.id)
                            .map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name} ·{" "}
                                {d.kind === "home-assistant.service"
                                  ? "service"
                                  : "entity"}{" "}
                                · {d.online ? "online" : "offline"}
                              </option>
                            ))}
                        </select>
                      </label>
                    </details>
                  )}
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
                        Only saved grants that have not expired or been revoked
                        authorize an agent. Unsaved selections below have no
                        effect.
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
                                  {grant.expiresAt === null
                                    ? "Access until revoked"
                                    : grant.expiresAt <= Date.now()
                                      ? `Expired ${new Date(grant.expiresAt).toLocaleString()}`
                                      : `Expires ${new Date(grant.expiresAt).toLocaleString()}`}
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
                        <p role="status" aria-live="polite">
                          No saved grants for this device.
                        </p>
                      )}
                      <details className="grant-editor">
                        <summary>Grant an agent access</summary>
                        <p>
                          Select only the functions this agent needs and choose
                          when its grant expires.
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
                              {[...connections, ...oauthConnections].map(
                                (c) => (
                                  <option key={c.id} value={c.principal}>
                                    {c.name}
                                  </option>
                                ),
                              )}
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
                        {selectedDevice.gatewayDeviceLimit && (
                          <div className="panel">
                            <h4>Home Assistant access</h4>
                            <p>
                              Apply a grant to this gateway and its current
                              linked entities. New discoveries require approval.
                              Excluding integration-wide services removes their
                              existing grants. You can narrow or revoke each
                              device grant later.
                            </p>
                            <label>
                              Permissions
                              <select
                                value={gatewayGrantMode}
                                onChange={(e) =>
                                  setGatewayGrantMode(
                                    e.target.value as "read" | "control",
                                  )
                                }
                              >
                                <option value="control">
                                  Read and control entities
                                </option>
                                <option value="read">Read only</option>
                              </select>
                            </label>
                            <label className="permission">
                              <input
                                type="checkbox"
                                checked={gatewayIncludeServices}
                                onChange={(e) =>
                                  setGatewayIncludeServices(e.target.checked)
                                }
                              />
                              Include integration-wide services, which can
                              affect multiple entities and run workflows
                            </label>
                            <p>Uses the access expiry selected below.</p>
                            <button
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  if (
                                    !confirm(
                                      `Allow ${grantPrincipalLabel} ${gatewayGrantMode === "control" ? "read and control" : "read-only"} access to the current Home Assistant inventory${gatewayIncludeServices ? " including integration-wide services" : ""}?`,
                                    )
                                  )
                                    return;
                                  const saved = await api(
                                    `/v1/devices/${selectedDevice.id}/gateway-grants`,
                                    "POST",
                                    {
                                      principal,
                                      mode: gatewayGrantMode,
                                      includeServices: gatewayIncludeServices,
                                      ttlSeconds: grantLifetime,
                                    },
                                  );
                                  setGrants(await api("/v1/grants"));
                                  setNotice(
                                    `Saved access for ${saved.devices} devices. Future devices remain ungranted.`,
                                  );
                                })
                              }
                            >
                              Grant current Home Assistant devices
                            </button>
                          </div>
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
                            value={grantLifetime ?? "until-revoked"}
                            onChange={(e) =>
                              setGrantLifetime(
                                e.target.value === "until-revoked"
                                  ? null
                                  : Number(e.target.value),
                              )
                            }
                          >
                            <option value="until-revoked">Until revoked</option>
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
                                  `Allow ${grantPrincipalLabel} to use ${capabilityNames.join(", ")} on ${selectedDevice.name} ${grantLifetime === null ? "until you revoke access" : `for ${grantLifetime / 60} minutes`}?`,
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
                  <p>Connect an agent through MCP, OAuth, or an API token.</p>
                </div>
              </div>
              <section
                className="panel connection-panel"
                aria-labelledby="connection-panel-title"
              >
                <div className="connection-panel-heading">
                  <div>
                    <h2 id="connection-panel-title">Connect an agent</h2>
                    <p>
                      Choose a connection method. Function access stays under
                      your control.
                    </p>
                  </div>
                </div>
                <div
                  className="connection-tabs"
                  role="tablist"
                  aria-label="Connection method"
                >
                  {connectionTabs.map((tab) => (
                    <button
                      type="button"
                      role="tab"
                      id={`connection-tab-${tab.toLowerCase().replaceAll(" ", "-")}`}
                      tabIndex={connectionTab === tab ? 0 : -1}
                      aria-selected={connectionTab === tab}
                      aria-controls="connection-tab-content"
                      className={connectionTab === tab ? "active" : ""}
                      key={tab}
                      onClick={() => setConnectionTab(tab)}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "ArrowLeft" &&
                          event.key !== "ArrowRight" &&
                          event.key !== "Home" &&
                          event.key !== "End"
                        )
                          return;
                        event.preventDefault();
                        const current = connectionTabs.indexOf(tab);
                        const nextIndex =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? connectionTabs.length - 1
                              : (current +
                                  (event.key === "ArrowRight" ? 1 : -1) +
                                  connectionTabs.length) %
                                connectionTabs.length;
                        const next = connectionTabs[nextIndex]!;
                        setConnectionTab(next);
                        document
                          .getElementById(
                            `connection-tab-${next.toLowerCase().replaceAll(" ", "-")}`,
                          )
                          ?.focus();
                      }}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div
                  className="connection-tab-content"
                  id="connection-tab-content"
                  role="tabpanel"
                  aria-labelledby={`connection-tab-${connectionTab.toLowerCase().replaceAll(" ", "-")}`}
                  tabIndex={0}
                >
                  {connectionTab === "Prompt" && (
                    <div className="connection-method">
                      <p>
                        Paste this into ChatGPT or another MCP-capable assistant
                        to connect openlaunch with OAuth. Review function access
                        on each device before using it.
                      </p>
                      <pre className="connect-prompt">{connectPrompt}</pre>
                      <div className="row">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            run(async () => {
                              await navigator.clipboard.writeText(
                                connectPrompt,
                              );
                              setNotice("Connection prompt copied.");
                            })
                          }
                        >
                          Copy prompt
                        </button>
                        <a href="/docs/agents">Agent guide</a>
                        <a href="/docs/functions">Function permissions</a>
                      </div>
                    </div>
                  )}
                  {connectionTab === "MCP URL" && (
                    <div className="connection-method">
                      <p>
                        Use this server URL in an MCP client. OAuth sign-in is
                        handled by openlaunch.
                      </p>
                      <pre className="setup-command">
                        <code>{mcpServerUrl}</code>
                      </pre>
                      <div className="row">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            run(async () => {
                              await navigator.clipboard.writeText(mcpServerUrl);
                              setNotice("MCP URL copied.");
                            })
                          }
                        >
                          Copy URL
                        </button>
                        <a href="/docs/agents">MCP documentation</a>
                      </div>
                    </div>
                  )}
                  {connectionTab === "Command" && (
                    <div className="connection-method">
                      <p>
                        Paste this command into a terminal to connect Codex with
                        OAuth.
                      </p>
                      <pre className="setup-command">
                        <code>{codexConnectCommand}</code>
                      </pre>
                      <div className="row">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            run(async () => {
                              await navigator.clipboard.writeText(
                                codexConnectCommand,
                              );
                              setNotice("Codex command copied.");
                            })
                          }
                        >
                          Copy command
                        </button>
                        <a href="/docs/agents">Codex setup guide</a>
                      </div>
                    </div>
                  )}
                  {connectionTab === "OAuth clients" && (
                    <OAuthClients
                      available={oauthRegistrationAvailable}
                      clients={oauthConnections}
                      api={api}
                      run={run}
                      busy={busy}
                      onRefresh={(clients) => {
                        setOAuthConnections(clients);
                        if (
                          oauthConnections.some(
                            (c) => c.principal === principal,
                          ) &&
                          !clients.some((c) => c.principal === principal)
                        )
                          setPrincipal(
                            session
                              ? "https://chatgpt.com/oauth/codex/client.json"
                              : "local-agent",
                          );
                      }}
                      refreshGrants={async () =>
                        setGrants(await api("/v1/grants"))
                      }
                      notify={setNotice}
                      confirm={confirmAction}
                      grantAccess={(value) => {
                        setPrincipal(value);
                        setPage("Devices");
                        setDetailTab("Access");
                      }}
                    />
                  )}
                  {connectionTab === "API token" && (
                    <div className="connection-method api-token-method">
                      <p>
                        Agent API tokens can call MCP and the API, but cannot
                        attach devices. They remain limited by your saved
                        function grants.
                      </p>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
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
                            setSecretContext("agents");
                            setPrincipal(connection.principal);
                            setConnections(await api("/v1/agent-connections"));
                            setNotice(
                              "Agent API token created. Copy it now; it is shown only once.",
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
                            onChange={(event) =>
                              setConnectionName(event.target.value)
                            }
                          />
                        </label>
                        <label>
                          Expires
                          <select
                            value={connectionLifetime ?? "until-revoked"}
                            onChange={(event) =>
                              setConnectionLifetime(
                                event.target.value === "until-revoked"
                                  ? null
                                  : Number(event.target.value),
                              )
                            }
                          >
                            <option value="until-revoked">Until revoked</option>
                            <option value={3600}>In one hour</option>
                            <option value={86400}>In 24 hours</option>
                            <option value={604800}>In 7 days</option>
                            <option value={2592000}>In 30 days</option>
                          </select>
                        </label>
                        <details>
                          <summary>Agent access</summary>
                          <label>
                            Agent access
                            <select
                              value={connectionAccess}
                              onChange={(event) =>
                                setConnectionAccess(
                                  event.target.value as "read" | "act",
                                )
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
                        </details>
                        <button
                          type="submit"
                          disabled={
                            busy ||
                            !connectionName.trim() ||
                            connectionSecret !== null
                          }
                        >
                          Create agent token
                        </button>
                      </form>
                      {connectionSecret && secretContext === "agents" && (
                        <div className="connection-secret">
                          <label>
                            Agent API token · shown once
                            <textarea readOnly value={connectionSecret} />
                          </label>
                          <p>
                            Copy this token into your agent's secret settings.
                            It cannot attach devices.
                          </p>
                          <div className="row">
                            <button
                              type="button"
                              className="secondary"
                              onClick={() =>
                                run(async () => {
                                  await navigator.clipboard.writeText(
                                    connectionSecret,
                                  );
                                  setNotice("Agent API token copied.");
                                })
                              }
                            >
                              Copy token
                            </button>
                            <button
                              type="button"
                              onClick={() => setConnectionSecret(null)}
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      )}
                      <section
                        className="token-list-section"
                        aria-labelledby="agent-token-list-title"
                      >
                        <h3 id="agent-token-list-title">
                          Active agent API tokens
                        </h3>
                        {connections.some(
                          (connection) => connection.purpose === "agent",
                        ) ? (
                          <ul className="connection-list">
                            {connections
                              .filter(
                                (connection) => connection.purpose === "agent",
                              )
                              .map((connection) => (
                                <li key={connection.id}>
                                  <div>
                                    <strong>{connection.name}</strong>
                                    <span>
                                      {connection.expiresAt === null
                                        ? "Until revoked"
                                        : `Expires ${new Date(connection.expiresAt).toLocaleString()}`}
                                    </span>
                                    <span>
                                      {connection.access === "read"
                                        ? "Read health and results"
                                        : "Can request functions approved for this token"}
                                    </span>
                                    <span>Cannot attach devices</span>
                                  </div>
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      run(async () => {
                                        if (
                                          !(await confirmAction(
                                            `Revoke agent API token ${connection.name}? It can no longer authorize agent requests.`,
                                          ))
                                        )
                                          return;
                                        await api(
                                          `/v1/agent-connections/${connection.id}/revoke`,
                                          "POST",
                                          {},
                                        );
                                        if (principal === connection.principal)
                                          setPrincipal(
                                            session
                                              ? "https://chatgpt.com/oauth/codex/client.json"
                                              : "local-agent",
                                          );
                                        setConnectionSecret(null);
                                        setConnections(
                                          await api("/v1/agent-connections"),
                                        );
                                        setGrants(await api("/v1/grants"));
                                        setNotice("Agent API token revoked.");
                                      })
                                    }
                                  >
                                    Revoke
                                  </button>
                                </li>
                              ))}
                          </ul>
                        ) : (
                          <p role="status" aria-live="polite">
                            No active agent API tokens.
                          </p>
                        )}
                      </section>
                      <details className="advanced-token-settings">
                        <summary>Advanced · setup and legacy tokens</summary>
                        <section
                          className="token-list-section"
                          aria-labelledby="setup-token-list-title"
                        >
                          <h3 id="setup-token-list-title">
                            Device setup tokens
                          </h3>
                          <p>
                            Short-lived credentials used only to attach a
                            device.
                          </p>
                          {deviceSetupTokens.some(
                            (item) => item.purpose === "device-setup",
                          ) ? (
                            <ul className="connection-list">
                              {deviceSetupTokens
                                .filter(
                                  (item) => item.purpose === "device-setup",
                                )
                                .map((item) => (
                                  <li key={item.id}>
                                    <div>
                                      <strong>{item.name}</strong>
                                      <span>
                                        {item.attachedDeviceCount ?? 0} of{" "}
                                        {item.deviceLimit} devices attached
                                      </span>
                                      <span>
                                        Expires{" "}
                                        {new Date(
                                          item.expiresAt,
                                        ).toLocaleString()}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      className="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        run(async () => {
                                          if (
                                            !(await confirmAction(
                                              `Revoke device setup token ${item.name}? Devices already attached remain paired.`,
                                            ))
                                          )
                                            return;
                                          await api(
                                            `/v1/device-setup-tokens/${item.id}/revoke`,
                                            "POST",
                                            {},
                                          );
                                          setDeviceSetupTokens(
                                            await api(
                                              "/v1/device-setup-tokens",
                                            ),
                                          );
                                          setNotice(
                                            "Device setup token revoked.",
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
                            <p role="status" aria-live="polite">
                              No active device setup tokens.
                            </p>
                          )}
                        </section>
                        {connections.some(
                          (connection) =>
                            !connection.purpose ||
                            connection.purpose === "legacy",
                        ) && (
                          <section
                            className="token-list-section legacy-token-panel"
                            aria-labelledby="legacy-token-list-title"
                          >
                            <h3 id="legacy-token-list-title">
                              Legacy combined tokens
                            </h3>
                            <p>
                              Existing SDK tokens retain their combined behavior
                              until revoked. New credentials use separate setup
                              and agent flows.
                            </p>
                            <ul className="connection-list">
                              {connections
                                .filter(
                                  (connection) =>
                                    !connection.purpose ||
                                    connection.purpose === "legacy",
                                )
                                .map((connection) => (
                                  <li key={connection.id}>
                                    <div>
                                      <strong>{connection.name}</strong>
                                      <span>
                                        {connection.expiresAt === null
                                          ? "Until revoked"
                                          : `Expires ${new Date(connection.expiresAt).toLocaleString()}`}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      className="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        run(async () => {
                                          if (
                                            !(await confirmAction(
                                              `Revoke legacy token ${connection.name}? Devices already attached remain paired.`,
                                            ))
                                          )
                                            return;
                                          await api(
                                            `/v1/agent-connections/${connection.id}/revoke`,
                                            "POST",
                                            {},
                                          );
                                          const [agentRows, setupRows] =
                                            await Promise.all([
                                              api("/v1/agent-connections"),
                                              api("/v1/device-setup-tokens"),
                                            ]);
                                          setConnections(agentRows);
                                          setDeviceSetupTokens(setupRows);
                                          setNotice(
                                            "Legacy combined token revoked.",
                                          );
                                        })
                                      }
                                    >
                                      Revoke
                                    </button>
                                  </li>
                                ))}
                            </ul>
                          </section>
                        )}
                      </details>
                    </div>
                  )}
                </div>
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
                        setNotice("");
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
                                : receipt.status === "succeeded" &&
                                    receipt.result?.physicalVerified ===
                                      false &&
                                    receipt.result?.transport ===
                                      "serial_command_sent"
                                  ? "Serial command sent · operation unverified"
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
                  <p role="status" aria-live="polite">
                    No actions recorded yet.
                  </p>
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
                  {typeof selectedReceipt.dispatchedAt === "number" && (
                    <div className="receipt-result">
                      <h3>Timing</h3>
                      <dl>
                        <dt>Queue to dispatch</dt>
                        <dd>
                          {Math.max(
                            0,
                            selectedReceipt.dispatchedAt -
                              selectedReceipt.createdAt,
                          )}{" "}
                          ms
                        </dd>
                        {typeof selectedReceipt.resultReceivedAt ===
                          "number" && (
                          <>
                            <dt>Dispatch to result received</dt>
                            <dd>
                              {Math.max(
                                0,
                                selectedReceipt.resultReceivedAt -
                                  selectedReceipt.dispatchedAt,
                              )}{" "}
                              ms
                            </dd>
                            <dt>Total to result received</dt>
                            <dd>
                              {Math.max(
                                0,
                                selectedReceipt.resultReceivedAt -
                                  selectedReceipt.createdAt,
                              )}{" "}
                              ms
                            </dd>
                          </>
                        )}
                      </dl>
                      <p>
                        Receipt timing includes processing and delivery. It does
                        not confirm physical completion.
                      </p>
                    </div>
                  )}
                  {selectedReceipt.result !== undefined && (
                    <div className="receipt-result">
                      <h3>Device result</h3>
                      {receiptImage && (
                        <img
                          className="desktop-preview"
                          src={receiptImage}
                          alt="Captured device desktop"
                        />
                      )}
                      {selectedReceipt.result !== null &&
                      typeof selectedReceipt.result === "object" &&
                      !Array.isArray(selectedReceipt.result) ? (
                        <dl>
                          {Object.entries(selectedReceipt.result)
                            .filter(
                              ([key]) => !receiptImage || key !== "imageBase64",
                            )
                            .map(([key, value]) => (
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
                            ))}
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
            openlaunch · <a href="/docs/terms">Terms</a>
            {" · "}
            <a href="/docs/privacy">Privacy</a>
          </footer>
        </main>
      </div>

      <dialog
        ref={connectDialog}
        className="connect-dialog"
        aria-labelledby="connect-title"
        aria-describedby="connect-description"
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
                ? `Set up ${deviceSetupKind === "home-assistant" ? "Home Assistant" : deviceSetupKind === "linux" ? "Linux host" : deviceSetupKind === "pi" ? "Raspberry Pi 4" : deviceSetupKind === "uno" ? "Uno R4 WiFi" : deviceSetupKind === "esp32" ? "ESP32" : "Node adapter"}`
                : enrollment
                  ? "Legacy enrollment"
                  : "Add a device"}
            </h2>
            <p id="connect-description">
              {setupConnection
                ? "This short-lived setup token only attaches the device. Use a separate agent API token or OAuth connection for agent requests."
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
              {deviceSetupKind === "home-assistant"
                ? "Home Assistant gateway"
                : deviceSetupKind === "linux"
                  ? "Linux host harness"
                  : deviceSetupKind === "pi"
                    ? "Raspberry Pi 4"
                    : deviceSetupKind === "uno"
                      ? "Arduino Uno R4 WiFi"
                      : deviceSetupKind === "esp32"
                        ? "Standalone ESP32"
                        : "Linux / desktop Node adapter"}
            </h3>
            {deviceSetupKind === "home-assistant" ? (
              <>
                <p>
                  Home Assistant OS: install the openlaunch app (add-on), paste
                  this setup token in its configuration and start it. It
                  connects to HA automatically.{" "}
                  <a href="/docs/home-assistant">Open the setup guide</a>.
                </p>
                <p>
                  Home Assistant Container or another local computer: run the
                  command below with Node 24, Python 3 and curl installed. It
                  privately prompts for your HA URL and access token. Rerunning
                  keeps existing credentials. Installation discovers devices;
                  grant access separately here.
                </p>
              </>
            ) : deviceSetupKind === "linux" ? (
              <p>
                Run this installer as your normal Linux user. It installs the
                native host harness, prompts for the setup token privately, and
                starts with one dedicated file workspace. Configure additional
                directories, commands and user services locally. For shell,
                screenshots, mouse and keyboard, run openlaunch-host
                enable-control on the active desktop, then restart and approve
                agent functions in Access.
              </p>
            ) : deviceSetupKind === "pi" ? (
              <p>
                Run this installer on Raspberry Pi OS. It prompts for the SDK
                token privately, downloads the matching runtime, and attaches
                the device.
              </p>
            ) : deviceSetupKind === "uno" ? (
              <>
                <p>
                  This helper sends Wi-Fi settings and the device setup token
                  over USB after you confirm. It does not flash firmware.
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
                  and the device setup token over USB; it does not flash
                  firmware.
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
                Run this command on a Linux or desktop machine with Node.js 24
                or newer, Python 3, curl, and access to your hardware library.
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
                  Device setup token · shown once
                  <textarea readOnly value={connectionSecret} />
                </label>
                <p>
                  Copy it now. The setup command prompts for this short-lived
                  token without placing it in shell history. It can only attach
                  the device; it cannot make agent requests.
                </p>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(connectionSecret);
                        setNotice("Device setup token copied.");
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
                  deviceSetupKind === "home-assistant"
                    ? "/docs/home-assistant"
                    : deviceSetupKind === "linux"
                      ? "/docs/linux"
                      : deviceSetupKind === "uno"
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
            {connectionSecret && secretContext === "agents" && (
              <p>
                Finish copying the agent API token shown on Connections before
                creating another. You can continue with an existing token.
              </p>
            )}
            <section className="panel">
              <h3>Choose a device or adapter</h3>
              <div className="device-grid">
                {(
                  [
                    [
                      "home-assistant",
                      "Home Assistant",
                      "Connect HA entities, helpers, scripts, scenes and services.",
                    ],
                    [
                      "custom",
                      "Linux / desktop Node adapter",
                      "Run the Node SDK beside your hardware or service.",
                    ],
                    [
                      "linux",
                      "Linux host",
                      "Native host controls on ARM64, ARMv7 or x86-64 Linux.",
                    ],
                    [
                      "pi",
                      "Raspberry Pi 4",
                      "Install the native Linux runtime on Raspberry Pi OS.",
                    ],
                    [
                      "uno",
                      "Arduino Uno R4 WiFi",
                      "Connect by USB; setup detects your Uno automatically.",
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
                    <p>
                      Connect your Uno by USB. The setup helper detects it on
                      your computer; you don’t need to enter a port here.
                    </p>
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
                    Device setup token
                    <select
                      value={deviceSetupTokenId}
                      onChange={(e) => setDeviceSetupTokenId(e.target.value)}
                    >
                      <option value="new">Create a new one-device token</option>
                      {deviceSetupTokens
                        .filter(
                          (c) =>
                            c.purpose === "device-setup" &&
                            c.canAttach &&
                            (deviceSetupKind !== "home-assistant" ||
                              !!c.gatewayDeviceLimit) &&
                            c.expiresAt > Date.now(),
                        )
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
                            {c.deviceLimit ?? 1} devices · device setup only ·
                            expires {new Date(c.expiresAt).toLocaleDateString()}
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
                          <option value={600}>In 10 minutes</option>
                          <option value={3600}>In 1 hour</option>
                          <option value={86400}>In 24 hours</option>
                        </select>
                      </label>
                      <button
                        disabled={
                          busy ||
                          !deviceSetupName.trim() ||
                          connectionSecret !== null ||
                          (deviceSetupKind === "esp32" &&
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
                          (deviceSetupKind === "esp32" &&
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
                one-time enrollment endpoint. This does not create a device
                setup token or grant agent permissions.
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
        aria-describedby="confirmation-description"
        onCancel={(event) => {
          event.preventDefault();
          finishConfirmation(false);
        }}
      >
        <h2 id="confirmation-title">Review request</h2>
        <p id="confirmation-description">{confirmation?.message}</p>
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
  const [formError, setFormError] = useState("");
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
        try {
          const args = Object.fromEntries(
            Object.entries(values)
              .filter(([name]) => Object.hasOwn(properties, name))
              .map(([name, value]) => {
                if (properties[name]?.type !== "object") return [name, value];
                const parsed = JSON.parse(String(value));
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                )
                  throw Error(`${name} must be a JSON object`);
                return [name, parsed];
              }),
          );
          setFormError("");
          onRequest(args);
        } catch {
          setFormError("Enter valid JSON objects for service data and target.");
        }
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
            ) : schema.type === "object" ? (
              <textarea
                required={required.includes(name)}
                placeholder="{}"
                value={String(values[name] ?? "")}
                onChange={(event) =>
                  setValues((current) => {
                    const next = { ...current };
                    if (event.target.value.trim())
                      next[name] = event.target.value;
                    else delete next[name];
                    return next;
                  })
                }
              />
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
      {formError && <p role="alert">{formError}</p>}
      <button disabled={disabled}>Run {definition.title}</button>
    </form>
  );
}
function AuthFooter({
  includeLegalLinks = true,
}: {
  includeLegalLinks?: boolean;
}) {
  return (
    <nav className="auth-footer" aria-label="Account resources">
      <a href="/docs">Documentation</a>
      {includeLegalLinks && (
        <>
          <a href="/docs/terms">Terms</a>
          <a href="/docs/privacy">Privacy</a>
        </>
      )}
    </nav>
  );
}

function AuthCardFrame({
  children,
  signedIn = false,
  includeLegalLinks = true,
}: {
  children: React.ReactNode;
  signedIn?: boolean;
  includeLegalLinks?: boolean;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-card account-status-card">
        <a className="auth-brand" href="/">
          <img src={logoUrl} width="48" height="42" alt="" />
          <span>openlaunch</span>
        </a>
        {signedIn && (
          <div className="auth-account-control">
            <span>Signed in</span>
            <UserButton />
          </div>
        )}
        {children}
        <AuthFooter includeLegalLinks={includeLegalLinks} />
      </section>
    </main>
  );
}

function HostedSignIn() {
  const callback = new URLSearchParams(window.location.search).get("sso");
  if (callback === "callback")
    return (
      <AuthCardFrame>
        <p role="status" aria-live="polite">
          Finishing your sign-in…
        </p>
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
      </AuthCardFrame>
    );
  return (
    <AuthCardFrame includeLegalLinks={false}>
      <h1>Sign in to openlaunch</h1>
      <p>Sign in to connect a device and choose what your agents can do.</p>
      <p className="auth-policy">
        By continuing, you agree to the{" "}
        <a href="/docs/terms">Terms of Service</a>
        {" and acknowledge the "}
        <a href="/docs/privacy">Privacy Policy</a>.
      </p>
      <SignIn
        withSignUp
        routing="hash"
        fallbackRedirectUrl="/console/"
        signUpFallbackRedirectUrl="/console/"
        appearance={{
          elements: {
            rootBox: { width: "100%", marginTop: "24px" },
            cardBox: { width: "100%", boxShadow: "none" },
            card: {
              padding: 0,
              background: "transparent",
              boxShadow: "none",
              border: 0,
            },
            header: { display: "none" },
            footer: { background: "transparent" },
          },
        }}
      />
    </AuthCardFrame>
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
  if (!isLoaded)
    return (
      <AuthCardFrame>
        <section role="status" aria-live="polite" aria-busy="true">
          <h1>Loading your account</h1>
          <p>Checking your sign-in status.</p>
        </section>
      </AuthCardFrame>
    );
  if (!isSignedIn) return <HostedSignIn />;
  if (accountError)
    return (
      <AuthCardFrame signedIn>
        <h1>Account connection failed</h1>
        <p role="alert" aria-live="assertive">
          {accountError}
        </p>
        <p>Reload this page to retry the account check.</p>
        <div className="auth-actions">
          <button type="button" onClick={() => window.location.reload()}>
            Reload and retry
          </button>
          <a href="/docs/troubleshooting">Troubleshooting guide</a>
        </div>
      </AuthCardFrame>
    );
  if (!account)
    return (
      <AuthCardFrame signedIn>
        <section role="status" aria-live="polite" aria-busy="true">
          <h1>Connecting your account</h1>
          <p>Retrieving the account’s device-control status.</p>
        </section>
      </AuthCardFrame>
    );
  if (!account.deviceControlsEnabled)
    return (
      <AuthCardFrame signedIn>
        <h1>Device controls unavailable</h1>
        <p>
          Your account is signed in, but device controls are not enabled on this
          hosted service.
        </p>
      </AuthCardFrame>
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
