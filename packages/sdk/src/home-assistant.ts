/** Local Home Assistant adapter. Its credentials never enter an openlaunch manifest. */
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type { Action, DeviceManifest } from "./index.js";

export type HAState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
};
export type HAService = {
  name?: string;
  description?: string;
  fields?: Record<string, unknown>;
  target?: unknown;
  response?: { optional?: boolean };
};
export type HADevice = {
  id: string;
  name?: string;
  name_by_user?: string;
  manufacturer?: string;
  model?: string;
  area_id?: string | null;
};
export type HAEntityRegistry = {
  entity_id: string;
  platform?: string;
  device_id?: string | null;
  area_id?: string | null;
};
export type HASnapshot = {
  states: HAState[];
  services: Record<string, Record<string, HAService>>;
  name: string;
  version: string;
  observedAt: number;
  devices?: HADevice[];
  entityRegistry?: HAEntityRegistry[];
  areas?: { area_id: string; name: string }[];
  registryAvailable?: boolean;
};
export type HAChild = {
  key: string;
  manifest: DeviceManifest;
  entityId?: string;
  homeAssistantDeviceId?: string;
  service?: string;
  actions: Record<string, string>;
};
const empty = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const text = (value: unknown, limit = 240) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit)
    : "";
const identifier = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const jsonData = {
  type: "object",
  maxProperties: 32,
  additionalProperties: true,
  description:
    "Home Assistant service data. Supports nested objects and arrays; max 2048 UTF-8 bytes and six levels.",
};
const targetData = {
  ...jsonData,
  description:
    "Explicit HA target: entity_id, device_id, area_id, floor_id or label_id. IDs can be a string or an array.",
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 40);
const shortName = (service: string) =>
  service.length <= 61 && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(service)
    ? "ha." + service
    : "ha.call_" + digest(service).slice(0, 16);
const props = (
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});
export const gatewayManifest: DeviceManifest = {
  name: "Home Assistant",
  kind: "gateway.home-assistant",
  capabilities: ["device.health", "ha.inventory"],
  functions: [
    {
      name: "ha.inventory",
      title: "Discover Home Assistant inventory",
      description:
        "List entities and available services on this gateway. Values and commands require grants on the linked device. Empty inventory is valid.",
      access: "read",
      inputSchema: props({
        kind: {
          type: "string",
          enum: ["entities", "services", "devices"],
          maxLength: 8,
        },
        offset: { type: "integer", minimum: 0, maximum: 2000 },
      }),
    },
  ],
};

export function validServiceData(
  value: unknown,
): value is Record<string, unknown> {
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 6) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") return v.length <= 1024;
    if (Array.isArray(v))
      return v.length <= 32 && v.every((x) => visit(x, depth + 1));
    return (
      !!v &&
      typeof v === "object" &&
      Object.keys(v).length <= 32 &&
      Object.entries(v).every(
        ([key, x]) =>
          key.length <= 128 &&
          !["__proto__", "prototype", "constructor"].includes(key) &&
          visit(x, depth + 1),
      )
    );
  };
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    visit(value, 0) &&
    Buffer.byteLength(JSON.stringify(value)) <= 2048
  );
}
export function normalizeHAUrl(value: string): string {
  const u = new URL(value);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ipv4 =
    isIP(host) === 4 &&
    /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  const ipv6 =
    isIP(host) === 6 &&
    (host === "::1" || /^(?:fd|fc|fe[89ab][0-9a-f]:)/i.test(host));
  const local =
    host === "localhost" ||
    (!host.includes(".") && !host.includes(":")) ||
    host.endsWith(".local") ||
    ipv4 ||
    ipv6;
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["/", ""].includes(u.pathname) ||
    (u.protocol !== "https:" && !(u.protocol === "http:" && local))
  )
    throw Error(
      "Use your HA HTTPS origin or local HTTP address, without credentials or a path",
    );
  return u.origin;
}
function compact(value: unknown, budget = 2200): unknown {
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > 4) return "[nested value omitted]";
    if (typeof v === "string") return text(v, 512);
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => clean(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 24)
          .map(([k, x]) => [
            k,
            /token|password|secret|api_key|access_code/i.test(k)
              ? "[redacted]"
              : clean(x, depth + 1),
          ]),
      );
    return null;
  };
  const result = clean(value, 0);
  return Buffer.byteLength(JSON.stringify(result)) <= budget
    ? result
    : {
        truncated: true,
        message: "Response exceeds the receipt excerpt budget",
      };
}
const hasTarget = (service: HAService) =>
  service.target !== undefined ||
  Object.hasOwn(service.fields ?? {}, "entity_id");
function applicable(
  state: HAState,
  serviceDomain: string,
  serviceName: string,
  definition: HAService,
  platform?: string,
): boolean {
  const domain = state.entity_id.split(".")[0];
  if (
    serviceDomain === "homeassistant" &&
    !["turn_on", "turn_off", "toggle", "update_entity"].includes(serviceName)
  )
    return false;
  if (!hasTarget(definition))
    return (
      serviceDomain === domain &&
      ["script", "scene"].includes(domain!) &&
      serviceName === state.entity_id.split(".")[1]
    );
  const target = definition.target as
    { entity?: unknown; device?: unknown; area?: unknown } | undefined;
  if (
    target?.entity === undefined &&
    (target?.device !== undefined || target?.area !== undefined)
  )
    return false;
  const raw =
    target?.entity ??
    (definition.fields?.entity_id as { selector?: { entity?: unknown } })
      ?.selector?.entity;
  const selectors = Array.isArray(raw) ? raw : [raw ?? {}];
  return selectors.some((value) => {
    if (!value || typeof value !== "object") return false;
    const selector = value as {
      domain?: string | string[];
      integration?: string | string[];
      supported_features?: unknown[];
    };
    const domains = selector.domain
      ? Array.isArray(selector.domain)
        ? selector.domain
        : [selector.domain]
      : [serviceDomain === "homeassistant" ? domain : serviceDomain];
    if (!domains.includes(domain!)) return false;
    if (
      selector.integration &&
      !(
        Array.isArray(selector.integration)
          ? selector.integration
          : [selector.integration]
      ).includes(platform ?? "")
    )
      return false;
    const supports = (feature: unknown) => {
      if (
        typeof feature !== "number" ||
        !Number.isSafeInteger(feature) ||
        feature < 0
      )
        return true;
      const flags = state.attributes.supported_features;
      if (
        typeof flags !== "number" ||
        !Number.isSafeInteger(flags) ||
        flags < 0
      )
        return false;
      return (BigInt(flags) & BigInt(feature)) === BigInt(feature);
    };
    return (
      !selector.supported_features?.length ||
      selector.supported_features.some((feature) =>
        Array.isArray(feature) ? feature.every(supports) : supports(feature),
      )
    );
  });
}
function actionDefinition(
  service: string,
  definition: HAService,
  entityId?: string,
): NonNullable<DeviceManifest["functions"]>[number] {
  const fields = Object.keys(definition.fields ?? {})
    .filter((key) => key !== "entity_id")
    .join(", ");
  return {
    name: shortName(service),
    title: text(definition.name || service, 64),
    description: text(
      `${service}${entityId ? " for " + entityId : " (integration-wide)"}. ${fields ? "Data: " + fields + ". " : ""}${entityId ? "Target is fixed. " : ""}Reports HA acceptance; no physical verification.`,
    ),
    access: "write",
    inputSchema: props(
      {
        data: jsonData,
        ...(!entityId && hasTarget(definition) ? { target: targetData } : {}),
      },
      !entityId && hasTarget(definition) ? ["target"] : [],
    ),
  };
}
export function discoverHA(snapshot: HASnapshot): HAChild[] {
  const services = Object.entries(snapshot.services)
    .flatMap(([domain, items]) =>
      Object.entries(items).map(([name, definition]) => ({
        service: domain + "." + name,
        domain,
        name,
        definition,
      })),
    )
    .filter((row) => identifier.test(row.service))
    .sort((a, b) => a.service.localeCompare(b.service));
  const children: HAChild[] = [];
  for (const state of [...snapshot.states].sort((a, b) =>
    a.entity_id.localeCompare(b.entity_id),
  )) {
    if (!identifier.test(state.entity_id)) continue;
    const domain = state.entity_id.split(".")[0]!;
    const actions = services.filter((s) =>
      applicable(
        state,
        s.domain,
        s.name,
        s.definition,
        snapshot.entityRegistry?.find((e) => e.entity_id === state.entity_id)
          ?.platform,
      ),
    );
    // A large custom domain is split into bounded action groups, never silently dropped.
    const groups = Math.max(1, Math.ceil(actions.length / 61));
    for (let group = 0; group < groups; group++) {
      const definitions: NonNullable<DeviceManifest["functions"]> = [
        {
          name: "ha.entity.read",
          title: "Read Home Assistant state",
          description: text(
            `Read a fresh state and bounded attributes for ${state.entity_id}. Online indicates gateway reachability, not physical device readiness.`,
          ),
          access: "read",
          inputSchema: empty,
        },
        {
          name: "ha.entity.actions",
          title: "Inspect Home Assistant actions",
          description: text(
            `Inspect applicable services and required data fields for ${state.entity_id}. Pass action to inspect one service.`,
          ),
          access: "read",
          inputSchema: props({ action: { type: "string", maxLength: 128 } }),
        },
        ...actions
          .slice(group * 61, (group + 1) * 61)
          .map((a) =>
            actionDefinition(a.service, a.definition, state.entity_id),
          ),
      ];
      children.push({
        actions: Object.fromEntries(
          actions
            .slice(group * 61, (group + 1) * 61)
            .map((a) => [shortName(a.service), a.service]),
        ),
        key: `entity:${digest(state.entity_id)}${group ? ":actions:" + group : ""}`,
        entityId: state.entity_id,
        manifest: {
          name: text(
            (state.attributes.friendly_name || state.entity_id) +
              (group ? ` · actions ${group + 1}` : ""),
            64,
          ),
          kind: "home-assistant.entity",
          capabilities: ["device.health", ...definitions.map((d) => d.name)],
          functions: definitions,
        },
      });
    }
  }
  for (const device of snapshot.devices ?? []) {
    const info = {
      name: "ha.device.info",
      title: "Inspect Home Assistant device",
      description:
        "Read the native HA device ID, model, manufacturer, area and registered entity IDs. Registry metadata is cached with its observation time; it does not prove physical readiness.",
      access: "read" as const,
      inputSchema: props({
        offset: { type: "integer", minimum: 0, maximum: 2000 },
      }),
    };
    children.push({
      key: "device:" + digest(device.id),
      homeAssistantDeviceId: device.id,
      actions: {},
      manifest: {
        name: text(
          device.name_by_user || device.name || device.model || device.id,
          64,
        ),
        kind: "home-assistant.device",
        capabilities: ["device.health", info.name],
        functions: [info],
      },
    });
  }
  for (const row of services) {
    const info = {
      name: "ha.service.info",
      title: "Inspect Home Assistant service",
      description: text(
        `Read the native data fields and selectors for ${row.service}. Integration-wide calls may affect other entities; grant deliberately.`,
      ),
      access: "read" as const,
      inputSchema: empty,
    };
    const action = actionDefinition(row.service, row.definition);
    children.push({
      actions: { [action.name]: row.service },
      key: "service:" + digest(row.service),
      service: row.service,
      manifest: {
        name: text("HA · " + row.service, 64),
        kind: "home-assistant.service",
        capabilities: [info.name, action.name],
        functions: [info, action],
      },
    });
  }
  return children;
}

export class HomeAssistant {
  readonly url: string;
  constructor(
    url: string,
    private token: string,
    private fetchImpl: typeof fetch = globalThis.fetch,
    private supervisor = false,
  ) {
    this.url = normalizeHAUrl(url);
    if (!token || token.length > 8192)
      throw Error("Home Assistant token is required");
  }
  private async registries(): Promise<
    Pick<
      HASnapshot,
      "devices" | "entityRegistry" | "areas" | "registryAvailable"
    >
  > {
    if (
      this.fetchImpl !== globalThis.fetch ||
      typeof globalThis.WebSocket !== "function"
    )
      return { registryAvailable: false };
    const endpoint = new URL(
      this.supervisor ? "/core/websocket" : "/api/websocket",
      this.url,
    );
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      let finished = false;
      const rows: Record<string, unknown> = {};
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else
          resolve({
            devices: rows.devices as HADevice[],
            entityRegistry: rows.entityRegistry as HAEntityRegistry[],
            areas: rows.areas as HASnapshot["areas"],
            registryAvailable: true,
          });
      };
      const timer = setTimeout(
        () => finish(Error("ha_registry_unavailable")),
        5000,
      );
      socket.addEventListener("error", () =>
        finish(Error("ha_registry_unavailable")),
      );
      socket.addEventListener("close", () => {
        if (!finished) finish(Error("ha_registry_unavailable"));
      });
      socket.addEventListener("message", (event) => {
        try {
          if (
            typeof event.data !== "string" ||
            Buffer.byteLength(event.data) > 4 * 1024 * 1024
          )
            throw Error();
          const message = JSON.parse(event.data);
          if (message.type === "auth_required")
            socket.send(
              JSON.stringify({ type: "auth", access_token: this.token }),
            );
          else if (message.type === "auth_ok") {
            [
              "config/device_registry/list",
              "config/entity_registry/list",
              "config/area_registry/list",
            ].forEach((type, i) =>
              socket.send(JSON.stringify({ id: i + 1, type })),
            );
          } else if (message.type === "auth_invalid")
            finish(Error("ha_registry_unavailable"));
          else if (message.type === "result") {
            if (
              !message.success ||
              !Array.isArray(message.result) ||
              message.result.length > 10000
            )
              throw Error();
            const key = ["devices", "entityRegistry", "areas"][message.id - 1];
            if (!key) throw Error();
            rows[key] = message.result;
            if (Object.keys(rows).length === 3) finish();
          }
        } catch {
          finish(Error("ha_registry_unavailable"));
        }
      });
    });
  }
  private async request(
    path: string,
    body?: unknown,
    deadline = Date.now() + 20000,
  ): Promise<any> {
    const remaining = Math.min(
      body === undefined ? 20000 : 300000,
      deadline - Date.now(),
    );
    if (remaining <= 0) throw Error("action_expired");
    let response: Response;
    try {
      response = await this.fetchImpl(
        this.url + (this.supervisor ? "/core/api" : "/api") + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + this.token,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(remaining),
        },
      );
    } catch {
      throw Error("ha_unreachable_or_timeout");
    }
    if (!response.ok)
      throw Error(
        response.status === 401 || response.status === 403
          ? "ha_authentication_failed"
          : `ha_rejected_${response.status}`,
      );
    const reader = response.body?.getReader();
    if (!reader) throw Error("ha_invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw Error("ha_response_too_large");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("ha_invalid_response");
    }
  }
  async snapshot(): Promise<HASnapshot> {
    const [states, groups, config] = await Promise.all([
      this.request("/states"),
      this.request("/services"),
      this.request("/config"),
    ]);
    if (
      !Array.isArray(states) ||
      states.some(
        (s) =>
          !s ||
          typeof s.entity_id !== "string" ||
          typeof s.state !== "string" ||
          !s.attributes ||
          typeof s.attributes !== "object",
      ) ||
      !Array.isArray(groups) ||
      groups.some(
        (g) =>
          !g ||
          typeof g.domain !== "string" ||
          !g.services ||
          typeof g.services !== "object" ||
          Array.isArray(g.services),
      ) ||
      !config ||
      typeof config !== "object"
    )
      throw Error("ha_invalid_inventory");
    const registry = await this.registries().catch(() => ({
      registryAvailable: false,
    }));
    return {
      ...registry,
      states,
      services: Object.fromEntries(groups.map((g) => [g.domain, g.services])),
      name: text(config.location_name || "Home Assistant", 64),
      version: text(config.version, 32),
      observedAt: Date.now(),
    };
  }
  private deviceMetadata(entityId: string, snapshot: HASnapshot) {
    const registry = snapshot.entityRegistry?.find(
      (e) => e.entity_id === entityId,
    );
    const device = snapshot.devices?.find((d) => d.id === registry?.device_id);
    return device
      ? {
          homeAssistantDevice: {
            id: device.id,
            name: text(device.name_by_user || device.name, 64),
            model: text(device.model, 64),
            manufacturer: text(device.manufacturer, 64),
            area: text(
              snapshot.areas?.find(
                (a) => a.area_id === (registry?.area_id || device.area_id),
              )?.name,
              64,
            ),
            observedAt: snapshot.observedAt,
          },
        }
      : {};
  }
  async execute(
    action: Action,
    child: HAChild | undefined,
    snapshot: HASnapshot,
  ): Promise<unknown> {
    if (Date.now() >= action.expiresAt - 500) throw Error("action_expired");
    const args = action.args ?? {};
    if (!child) {
      if (action.capability === "device.health") {
        const config = await this.request(
          "/config",
          undefined,
          action.expiresAt - 500,
        );
        return {
          gateway: "home-assistant",
          connected: true,
          version: text(config.version, 32),
          entityCount: snapshot.states.length,
          serviceCount: Object.values(snapshot.services).reduce(
            (n, s) => n + Object.keys(s).length,
            0,
          ),
          physicalVerified: false,
        };
      }
      if (action.capability === "ha.inventory") {
        const kind = args.kind ?? "entities";
        if (kind === "devices" && !snapshot.registryAvailable)
          return {
            kind,
            registryAvailable: false,
            observedAt: snapshot.observedAt,
            message:
              "HA registry access is unavailable. Entity states and services remain discoverable.",
          };
        const rows =
          kind === "devices"
            ? (snapshot.devices ?? []).map((d) => ({
                homeAssistantDeviceId: d.id,
                name: text(d.name_by_user || d.name || d.model || d.id, 64),
                model: text(d.model, 64),
              }))
            : kind === "services"
              ? Object.entries(snapshot.services).flatMap(([domain, s]) =>
                  Object.keys(s).map((name) => ({
                    action: domain + "." + name,
                  })),
                )
              : snapshot.states.map((s) => ({
                  entityId: s.entity_id,
                  name: text(s.attributes.friendly_name || s.entity_id, 64),
                  homeAssistantDeviceId:
                    snapshot.entityRegistry?.find(
                      (e) => e.entity_id === s.entity_id,
                    )?.device_id ?? null,
                }));
        const offset = Number(args.offset ?? 0);
        const items: unknown[] = [];
        for (const row of rows.slice(offset, offset + 12)) {
          if (Buffer.byteLength(JSON.stringify([...items, row])) > 2800) break;
          items.push(row);
        }
        return {
          kind,
          total: rows.length,
          registryAvailable: snapshot.registryAvailable ?? false,
          observedAt: snapshot.observedAt,
          items,
          nextOffset:
            offset + items.length < rows.length ? offset + items.length : null,
        };
      }
      throw Error("unsupported_capability");
    }
    if (
      child.homeAssistantDeviceId &&
      ["device.health", "ha.device.info"].includes(action.capability)
    ) {
      const device = snapshot.devices?.find(
        (d) => d.id === child.homeAssistantDeviceId,
      );
      if (!device) throw Error("ha_device_no_longer_available");
      const entities =
        snapshot.entityRegistry
          ?.filter((e) => e.device_id === device.id)
          .map((e) => e.entity_id) ?? [];
      const offset = Number(args.offset ?? 0);
      return {
        source: "home-assistant",
        homeAssistantDeviceId: device.id,
        name: text(device.name_by_user || device.name, 64),
        model: text(device.model, 128),
        manufacturer: text(device.manufacturer, 128),
        area: text(
          snapshot.areas?.find((a) => a.area_id === device.area_id)?.name,
          64,
        ),
        entities: entities.slice(offset, offset + 8),
        entityCount: entities.length,
        nextOffset: offset + 8 < entities.length ? offset + 8 : null,
        observedAt: snapshot.observedAt,
        cached: true,
        physicalVerified: false,
      };
    }
    if (
      child.entityId &&
      (action.capability === "device.health" ||
        action.capability === "ha.entity.read")
    ) {
      const state = await this.request(
        "/states/" + encodeURIComponent(child.entityId),
        undefined,
        action.expiresAt - 500,
      );
      return {
        source: "home-assistant",
        entityId: child.entityId,
        state: text(state.state, 512),
        attributes: compact(state.attributes),
        ...this.deviceMetadata(child.entityId, snapshot),
        lastUpdated: state.last_updated,
        observedAt: Date.now(),
        physicalVerified: false,
      };
    }
    const serviceIds = Object.values(child.actions);
    if (
      action.capability === "ha.entity.actions" ||
      action.capability === "ha.service.info"
    ) {
      const requested =
        child.service ??
        (typeof args.action === "string" ? args.action : undefined);
      if (
        requested &&
        !serviceIds.includes(requested) &&
        requested !== child.service
      )
        throw Error("service_not_available");
      const rows = (requested ? [requested] : serviceIds).map((id) => {
        const [domain, name] = id.split(".");
        return { action: id, ...snapshot.services[domain!]?.[name!] };
      });
      return compact(
        { entityId: child.entityId, services: rows, physicalVerified: false },
        3000,
      );
    }
    const service = child.actions[action.capability];
    if (!service) throw Error("unsupported_capability");
    if (
      !child.manifest.capabilities.includes(action.capability) ||
      !serviceIds.includes(service)
    )
      throw Error("unsupported_capability");
    const [domain, name] = service.split(".");
    const definition = snapshot.services[domain!]?.[name!];
    if (!definition) throw Error("service_no_longer_available");
    const data = args.data ?? {};
    if (!validServiceData(data)) throw Error("invalid_service_data");
    const targeting = new Set([
      "entity_id",
      "device_id",
      "area_id",
      "floor_id",
      "label_id",
      "target",
      "entry_id",
      "config_entry_id",
      "entity_ids",
    ]);
    // Entity grants cannot be retargeted through service_data, even when nested.
    const override = (v: unknown): boolean =>
      !!v &&
      typeof v === "object" &&
      Object.entries(v).some(
        ([key, value]) => targeting.has(key) || override(value),
      );
    if (child.entityId && override(data))
      throw Error("fixed_target_cannot_be_overridden");
    const target: Record<string, unknown> =
      child.entityId && hasTarget(definition)
        ? { entity_id: child.entityId }
        : {};
    if (!child.entityId && hasTarget(definition)) {
      if (!validServiceData(args.target) || !Object.keys(args.target).length)
        throw Error("explicit_target_required");
      for (const [key, value] of Object.entries(args.target)) {
        if (
          !targeting.has(key) ||
          ["target", "entry_id", "config_entry_id", "entity_ids"].includes(
            key,
          ) ||
          !(
            (typeof value === "string" && value.length > 0) ||
            (Array.isArray(value) &&
              value.length > 0 &&
              value.every((v) => typeof v === "string" && v.length > 0))
          )
        )
          throw Error("invalid_target");
        target[key] = value;
      }
      if (override(data)) throw Error("put_target_in_target_field");
    }
    // No write retry: a lost HTTP response can mean HA already executed the call.
    let response: any;
    try {
      response = await this.request(
        `/services/${domain}/${name}${definition.response ? "?return_response" : ""}`,
        { ...data, ...target },
        action.expiresAt - 500,
      );
    } catch (error) {
      const code = (error as Error).message;
      if (
        [
          "action_expired",
          "ha_authentication_failed",
          "ha_rejected_400",
          "ha_rejected_404",
          "ha_rejected_422",
        ].includes(code)
      )
        throw error;
      throw Error("ha_write_outcome_unknown");
    }
    const result: Record<string, unknown> = {
      acceptedBy: "home-assistant",
      action: service,
      physicalVerified: false,
    };
    if (definition.response)
      result.response = compact(response.service_response ?? response, 1800);
    if (child.entityId) {
      try {
        const state = await this.request(
          "/states/" + encodeURIComponent(child.entityId),
          undefined,
          action.expiresAt - 500,
        );
        result.observedState = {
          entityId: child.entityId,
          state: text(state.state, 512),
          lastUpdated: state.last_updated,
        };
        result.stateObserved = true;
      } catch {
        result.stateObserved = false;
      }
    }
    return result;
  }
}
