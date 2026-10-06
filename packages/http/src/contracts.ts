import { z } from "zod";
import {
  capabilityName,
  deviceKind,
  manifestSchema,
  functionDefinition,
} from "../../core/src/index.ts";
import { oauthClientConfig } from "../../core/src/oauth-clients.ts";

// These schemas are the request validators used by the HTTP handlers. Keep
// defaults and strictness here so the published contract cannot drift.
export const enrollRequestSchema = z
  .object({ token: z.string().length(64), manifest: z.unknown() })
  .strict();
export const manifestRequestSchema = z
  .object({ manifest: z.unknown() })
  .strict();
export const gatewayChildrenSchema = z
  .object({
    children: z
      .array(
        z
          .object({
            key: z
              .string()
              .min(1)
              .max(192)
              .regex(/^[a-zA-Z0-9_.:-]+$/),
            manifest: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const gatewayStatusSchema = z
  .object({
    online: z.boolean(),
    keys: z
      .array(
        z
          .string()
          .min(1)
          .max(192)
          .regex(/^[a-zA-Z0-9_.:-]+$/),
      )
      .max(2000)
      .optional(),
  })
  .strict();
export const heartbeatRequestSchema = z.object({}).strict();
export const resultRequestSchema = z
  .object({
    actionId: z.string().uuid(),
    status: z.enum(["succeeded", "failed"]),
    result: z.unknown(),
  })
  .strict();
export const attachRequestSchema = z
  .object({ requestId: z.string().uuid(), manifest: z.unknown() })
  .strict();
export const enrollmentRequestSchema = z.object({ kind: deviceKind }).strict();
export const createAgentConnectionSchema = z
  .object({
    name: z.string().min(1).max(64),
    ttlSeconds: z.number().int().min(60).max(2592000).nullable().default(86400),
    access: z.enum(["read", "act"]).default("act"),
    role: z.enum(["operator", "administrator"]).optional(),
  })
  .strict();
// Full-policy replacement for one principal. mode selected keeps the legacy
// per-device grant list; mode all covers every device with opt-out exclusions.
// Bounds mirror the core accessPolicySchema so the published contract cannot
// accept what the hub would reject.
export const accessPolicyRequestSchema = z
  .object({
    principal: z.string().min(1).max(128).regex(/^\S+$/),
    mode: z.enum(["all", "selected"]).default("all"),
    excludedDevices: z.array(z.string().min(1).max(128)).max(1000).default([]),
    excludedFunctions: z
      .array(
        z
          .object({
            deviceId: z.string().min(1).max(128).nullable(),
            capability: capabilityName,
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    role: z.enum(["operator", "administrator"]).default("operator"),
    expiresAt: z.number().int().nullable().default(null),
    delegatedFrom: z.string().min(1).max(128).regex(/^\S+$/).optional(),
  })
  .strict();
export const createSetupTokenSchema = z
  .object({
    name: z.string().min(1).max(64),
    ttlSeconds: z.number().int().min(60).max(86400).default(600),
    deviceLimit: z.number().int().min(1).max(20).default(1),
    gatewayDeviceLimit: z.number().int().min(0).max(2000).optional(),
  })
  .strict();
export const grantRequestSchema = z
  .object({
    principal: z.string().min(1).max(128),
    deviceId: z.string().uuid(),
    capabilities: z.array(capabilityName).min(1).max(64),
    ttlSeconds: z.number().int().min(1).max(86400).nullable().default(3600),
  })
  .strict();
export const gatewayGrantSchema = z
  .object({
    principal: z.string().min(1).max(128),
    mode: z.enum(["read", "control"]),
    includeServices: z.boolean().default(false),
    ttlSeconds: z.number().int().min(1).max(86400).nullable().default(3600),
  })
  .strict();
export const revokeGrantRequestSchema = z
  .object({ principal: z.string(), deviceId: z.string().uuid() })
  .strict();
export const broadcastRequestSchema = z
  .object({
    deviceIds: z.array(z.string().uuid()).min(1).max(20),
    capability: capabilityName,
    arguments: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).max(64),
    ttlSeconds: z.number().int().min(1).max(300).default(30),
  })
  .strict();
export const actionRequestSchema = z
  .object({
    capability: capabilityName,
    arguments: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).max(128),
    ttlSeconds: z.number().int().min(1).max(300).default(30),
  })
  .strict();
export const oauthClientConfigSchema = oauthClientConfig;

const uuid = { type: "string", format: "uuid" };
const ownerBearer = [{ OwnerAuth: [] }];
const deviceBearer = [{ DeviceAuth: [] }];
const j = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
const response = (description: string, schema?: object) => ({
  description,
  ...(schema ? { content: { "application/json": { schema } } } : {}),
});
const data = (schema: object) => ({
  type: "object",
  required: ["data"],
  properties: { data: schema },
  additionalProperties: false,
});
const ErrorEnvelope = {
  type: "object",
  properties: {
    error: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
      additionalProperties: true,
    },
  },
  required: ["error"],
  additionalProperties: false,
};
const actionStates = [
  "queued",
  "received",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "unknown",
];
const Action = {
  type: "object",
  properties: {
    id: uuid,
    deviceId: uuid,
    capability: { type: "string" },
    args: { type: "object", additionalProperties: true },
    status: { type: "string", enum: actionStates },
    createdAt: { type: "integer" },
    expiresAt: { type: "integer" },
    dispatchedAt: { type: "integer" },
    resultReceivedAt: {
      type: "integer",
      description:
        "Server time in Unix milliseconds when the first terminal device result was saved. Preserved on identical retries; absent for older receipts. This is receipt delivery, not physical completion.",
    },
    result: {},
    clientKey: {
      type: "string",
      description:
        "Internal idempotency key stored in the action ledger; included by request/get/result handler responses.",
    },
    fingerprint: {
      type: "string",
      description:
        "Internal canonical request fingerprint; included by request/get/result and action history responses.",
    },
    principalId: {
      type: "string",
      description: "Principal identifier associated with the action.",
    },
    ownerAuthorized: {
      type: "boolean",
      description:
        "Internal provenance: true for an owner-originated action. False is normal for an accepted agent action whose live grants authorize it; it is not a missing-approval status. MCP receipts omit this field.",
    },
    accessPolicy: {
      type: "string",
      description:
        "Policy principal that authorized this action when queued; dispatch re-checks the live chain for that policy before delivering.",
    },
    accessConstraints: {
      type: "array",
      items: { type: "string" },
      description:
        "Constraint principals (e.g. the original OAuth client of a linked membership) re-checked against their live policies at dispatch time.",
    },
  },
  required: [
    "id",
    "deviceId",
    "capability",
    "args",
    "status",
    "createdAt",
    "expiresAt",
  ],
  additionalProperties: false,
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (schema: object) => ({ type: "array", items: schema });
const schemas: Record<string, object> = {
  Error: ErrorEnvelope,
  ActionReceipt: {
    ...Action,
    required: [
      "id",
      "deviceId",
      "capability",
      "args",
      "status",
      "createdAt",
      "expiresAt",
      "clientKey",
      "fingerprint",
      "principalId",
      "ownerAuthorized",
    ],
  },
  ActionHistory: {
    ...Action,
    properties: Object.fromEntries(
      Object.entries(Action.properties).filter(
        ([name]) => name !== "clientKey",
      ),
    ),
    required: [
      "id",
      "deviceId",
      "capability",
      "args",
      "status",
      "createdAt",
      "expiresAt",
      "fingerprint",
      "principalId",
      "ownerAuthorized",
    ],
  },
  ActionExport: {
    ...Action,
    properties: Object.fromEntries(
      Object.entries(Action.properties).filter(
        ([name]) => !["clientKey", "fingerprint"].includes(name),
      ),
    ),
    required: [
      "id",
      "deviceId",
      "capability",
      "args",
      "status",
      "createdAt",
      "expiresAt",
      "principalId",
      "ownerAuthorized",
    ],
  },
  Device: {
    type: "object",
    properties: {
      id: uuid,
      name: { type: "string" },
      kind: { type: "string" },
      capabilities: { type: "array", items: { type: "string" } },
      functions: {
        type: "array",
        items: ref("FunctionDefinition"),
      },
      lastSeen: { type: "integer" },
      revoked: { type: "boolean" },
      online: { type: "boolean" },
      gatewayId: uuid,
      gatewayKey: { type: "string" },
      gatewayAvailable: { type: "boolean" },
      gatewayConnected: { type: "boolean" },
      gatewayDeviceLimit: { type: "integer", maximum: 2000 },
    },
    required: [
      "id",
      "name",
      "kind",
      "capabilities",
      "lastSeen",
      "revoked",
      "online",
    ],
    additionalProperties: true,
  },
  Manifest: j(manifestSchema),
  FunctionDefinition: j(functionDefinition),
  CapabilityGrant: {
    type: "object",
    properties: {
      principal: { type: "string" },
      deviceId: uuid,
      capabilities: { type: "array", items: { type: "string" } },
      expiresAt: { type: ["integer", "null"] },
    },
    required: ["principal", "deviceId", "capabilities", "expiresAt"],
  },
  AgentConnection: {
    type: "object",
    properties: {
      id: uuid,
      principal: { type: "string" },
      name: { type: "string" },
      expiresAt: { type: ["integer", "null"] },
      revoked: { type: "boolean" },
      access: { type: "string", enum: ["read", "act"] },
      purpose: { type: "string", enum: ["agent", "device-setup", "oauth"] },
      canAttach: { type: "boolean" },
      deviceLimit: { type: "integer" },
      gatewayDeviceLimit: { type: "integer" },
      attachedDeviceCount: { type: "integer" },
      oauth: {
        type: "object",
        properties: {
          applicationId: { type: "string" },
          clientId: { type: "string" },
          redirectUris: arr({ type: "string", format: "uri" }),
          public: { type: "boolean" },
        },
        required: ["applicationId", "clientId", "redirectUris", "public"],
        additionalProperties: false,
      },
    },
    required: ["id", "principal", "name", "expiresAt", "revoked", "access"],
  },
  Function: {
    type: "object",
    properties: {
      deviceId: uuid,
      deviceName: { type: "string" },
      kind: { type: "string" },
      definition: ref("FunctionDefinition"),
      guide: { type: "string" },
    },
    required: ["deviceId", "deviceName", "kind", "definition", "guide"],
  },
  AccessPolicy: {
    type: "object",
    properties: {
      principal: { type: "string" },
      mode: {
        type: "string",
        enum: ["all", "selected"],
        description:
          "selected keeps the legacy per-device grant list; all covers every workspace device with opt-out exclusions.",
      },
      excludedDevices: { type: "array", items: { type: "string" } },
      excludedFunctions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            deviceId: { type: ["string", "null"] },
            capability: { type: "string" },
          },
          required: ["deviceId", "capability"],
          additionalProperties: false,
        },
      },
      role: { type: "string", enum: ["operator", "administrator"] },
      expiresAt: { type: ["integer", "null"] },
      delegatedFrom: {
        type: "string",
        description:
          "Parent policy principal this policy was delegated from; a child is always intersected with the live parent chain, so delegated credentials can never escape parent exclusions, expiry or role changes.",
      },
    },
    required: [
      "principal",
      "mode",
      "excludedDevices",
      "excludedFunctions",
      "role",
      "expiresAt",
    ],
    additionalProperties: false,
  },
  EffectiveAccess: {
    type: "object",
    description:
      "The caller's effective current access: policy role and mode plus, for selected mode, the live legacy per-device grants.",
    properties: {
      principal: { type: "string" },
      role: {
        type: ["string", "null"],
        enum: ["operator", "administrator", null],
      },
      mode: { type: ["string", "null"], enum: ["all", "selected", null] },
      readOnly: { type: "boolean" },
      excludedDevices: { type: "array", items: { type: "string" } },
      excludedFunctions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            deviceId: { type: ["string", "null"] },
            capability: { type: "string" },
          },
          required: ["deviceId", "capability"],
          additionalProperties: false,
        },
      },
      expiresAt: { type: ["integer", "null"] },
      delegatedFrom: { type: "string" },
    },
    required: ["principal", "role"],
    additionalProperties: true,
  },
  Onboarding: {
    type: "object",
    properties: {
      devices: arr(ref("Device")),
      setup: {
        type: "object",
        properties: {
          attachmentConfigured: {
            type: "boolean",
            description:
              "Server-side device attachment credentials are configured.",
          },
          setupTokens: arr(ref("AgentConnection")),
          agentConnections: arr(ref("AgentConnection")),
        },
        required: ["attachmentConfigured", "setupTokens", "agentConnections"],
        additionalProperties: false,
      },
      nextSteps: { type: "array", items: { type: "string" } },
    },
    required: ["devices", "setup", "nextSteps"],
    additionalProperties: false,
  },
  WorkspaceMembership: {
    type: "object",
    properties: {
      workspace: { type: "string", pattern: "^[a-f0-9]{64}$" },
      principalId: { type: "string" },
      name: { type: "string" },
      role: { type: "string", enum: ["owner", "operator", "administrator"] },
    },
    required: ["workspace", "principalId", "name", "role"],
    additionalProperties: false,
  },
  WorkspaceAgent: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^agent:[a-f0-9]{64}$" },
      identityId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      name: { type: "string" },
      role: { type: "string", enum: ["operator", "administrator"] },
      joinedAt: { type: "integer" },
      revoked: { type: "boolean" },
    },
    required: ["id", "identityId", "name", "role", "joinedAt", "revoked"],
    additionalProperties: false,
  },
  WorkspaceInvitation: {
    type: "object",
    properties: {
      invitation: {
        type: "string",
        description:
          "One-time invitation secret; shown once, stored only as a hash, expires at expiresAt.",
      },
      expiresAt: { type: "integer" },
    },
    required: ["invitation", "expiresAt"],
    additionalProperties: false,
  },
  CliAuthorization: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "One-time login code; consumed by the exchange call.",
      },
      state: { type: "string" },
      callbackUrl: { type: "string", format: "uri" },
    },
    required: ["code", "state", "callbackUrl"],
    additionalProperties: false,
  },
  CliLoginExchange: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "Agent connection credential; shown once by this response. Store securely, never log or commit.",
      },
      workspace: { type: "string", pattern: "^[a-f0-9]{64}$" },
      connectionId: uuid,
      expiresAt: { type: ["integer", "null"] },
      access: { type: "string", enum: ["read", "act"] },
      role: { type: "string", enum: ["operator", "administrator"] },
    },
    required: [
      "token",
      "workspace",
      "connectionId",
      "expiresAt",
      "access",
      "role",
    ],
    additionalProperties: false,
  },
};
schemas.NewConnection = {
  type: "object",
  properties: {
    id: uuid,
    principal: { type: "string" },
    name: { type: "string" },
    expiresAt: { type: ["integer", "null"] },
    revoked: { type: "boolean" },
    access: { type: "string", enum: ["read", "act"] },
    oauth: {
      type: "object",
      properties: {
        applicationId: { type: "string" },
        clientId: { type: "string" },
        redirectUris: arr({ type: "string", format: "uri" }),
        public: { type: "boolean" },
      },
      required: ["applicationId", "clientId", "redirectUris", "public"],
      additionalProperties: false,
    },
    purpose: { type: "string", enum: ["agent", "device-setup"] },
    canAttach: { type: "boolean" },
    deviceLimit: { type: "integer" },
    gatewayDeviceLimit: { type: "integer" },
    attachedDeviceCount: { type: "integer" },
    token: {
      type: "string",
      description: "Returned once. Store securely; never log or commit.",
    },
  },
  required: [
    "id",
    "principal",
    "name",
    "expiresAt",
    "revoked",
    "access",
    "purpose",
    "canAttach",
    "deviceLimit",
    "token",
  ],
  additionalProperties: false,
};
schemas.AttachedDevice = {
  type: "object",
  properties: {
    deviceId: uuid,
    token: {
      type: "string",
      description:
        "Private child device credential. Returned only at enrollment/attachment; revoking the device invalidates it.",
    },
  },
  required: ["deviceId", "token"],
  additionalProperties: false,
};
schemas.Enrollment = {
  type: "object",
  properties: {
    token: { type: "string" },
    expiresInSeconds: { type: "integer", const: 600 },
    expiresAt: { type: "integer" },
  },
  required: ["token", "expiresInSeconds", "expiresAt"],
  additionalProperties: false,
};
schemas.Account = {
  type: "object",
  properties: {
    workspace: { type: "string" },
    principal: {
      type: "object",
      properties: {
        id: { type: "string", const: "owner" },
        owner: { type: "boolean", const: true },
      },
      required: ["id", "owner"],
      additionalProperties: false,
    },
    deviceControlsEnabled: { type: "boolean" },
    agentClients: arr({ type: "string" }),
    oauthClientRegistration: { type: "boolean" },
  },
  required: [
    "workspace",
    "principal",
    "deviceControlsEnabled",
    "agentClients",
    "oauthClientRegistration",
  ],
  additionalProperties: false,
};
schemas.HistoryExport = {
  type: "object",
  properties: {
    format: { type: "string", const: "openlaunch.actions.v1" },
    exportedAt: { type: "integer" },
    actions: arr(ref("ActionExport")),
  },
  required: ["format", "exportedAt", "actions"],
  additionalProperties: false,
};
schemas.BroadcastResult = {
  type: "object",
  properties: {
    deviceId: uuid,
    action: ref("ActionReceipt"),
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["deviceId"],
  additionalProperties: false,
};
schemas.DeviceNext = {
  anyOf: [
    {
      type: "object",
      properties: {
        id: uuid,
        deviceId: uuid,
        capability: { type: "string" },
        args: { type: "object", additionalProperties: true },
        status: { type: "string", const: "received" },
        createdAt: { type: "integer" },
        expiresAt: { type: "integer" },
        dispatchedAt: { type: "integer" },
        accessPolicy: {
          type: "string",
          description:
            "Policy principal that authorized this action when queued; dispatch re-checks the live chain for that policy before delivering.",
        },
        accessConstraints: {
          type: "array",
          items: { type: "string" },
          description:
            "Constraint principals re-checked against their live policies at dispatch time.",
        },
      },
      required: [
        "id",
        "deviceId",
        "capability",
        "args",
        "status",
        "createdAt",
        "expiresAt",
        "dispatchedAt",
      ],
      additionalProperties: false,
    },
    { type: "null" },
  ],
};
// Encode kind-dependent runtime limits in the published contract.
const manifestPropertyRule = (rule: object) => ({
  properties: {
    functions: {
      items: {
        properties: {
          inputSchema: {
            properties: { properties: { additionalProperties: rule } },
          },
        },
      },
    },
  },
});
Object.assign(schemas.Manifest, {
  allOf: [
    {
      if: { properties: { kind: { const: "linux" } }, required: ["kind"] },
      then: {
        properties: {
          capabilities: { maxItems: 24 },
          functions: { maxItems: 24 },
        },
      },
    },
    {
      if: {
        properties: {
          kind: {
            not: {
              anyOf: [{ const: "linux" }, { pattern: "^home-assistant\\." }],
            },
          },
        },
        required: ["kind"],
      },
      then: {
        properties: {
          capabilities: { maxItems: 16 },
          functions: { maxItems: 16 },
        },
      },
    },
    {
      if: {
        properties: { kind: { not: { const: "linux" } } },
        required: ["kind"],
      },
      then: manifestPropertyRule({
        if: { properties: { type: { const: "string" } }, required: ["type"] },
        then: {
          properties: {
            maxLength: { maximum: 1024 },
            minLength: { maximum: 1024 },
          },
        },
      }),
    },
    {
      if: {
        properties: { kind: { not: { pattern: "^home-assistant\\." } } },
        required: ["kind"],
      },
      then: manifestPropertyRule({
        not: { properties: { type: { const: "object" } }, required: ["type"] },
      }),
    },
  ],
});
schemas.ManifestUpdate = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    grantsRevoked: { type: "boolean" },
  },
  required: ["ok", "grantsRevoked"],
  additionalProperties: false,
};
schemas.Ok = {
  type: "object",
  properties: { ok: { type: "boolean", const: true } },
  required: ["ok"],
  additionalProperties: false,
};
schemas.OAuthRevocation = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    providerCleanupPending: { type: "boolean" },
  },
  required: ["ok", "providerCleanupPending"],
  additionalProperties: false,
};
schemas.OAuthRegistration = {
  type: "object",
  properties: {
    id: uuid,
    principal: { type: "string" },
    name: { type: "string" },
    expiresAt: { type: ["integer", "null"] },
    revoked: { type: "boolean" },
    access: { type: "string", enum: ["read", "act"] },
    purpose: { type: "string", const: "oauth" },
    canAttach: { type: "boolean", const: false },
    deviceLimit: { type: "integer", const: 0 },
    oauth: {
      type: "object",
      properties: {
        applicationId: { type: "string" },
        clientId: { type: "string" },
        redirectUris: arr({ type: "string", format: "uri" }),
        public: { type: "boolean" },
      },
      required: ["applicationId", "clientId", "redirectUris", "public"],
      additionalProperties: false,
    },
    clientSecret: {
      type: "string",
      description:
        "Returned only when the provider issued a secret; store securely and never log.",
    },
  },
  required: [
    "id",
    "principal",
    "name",
    "expiresAt",
    "revoked",
    "access",
    "purpose",
    "oauth",
  ],
  additionalProperties: false,
};
const op = (
  summary: string,
  tag: string,
  security: object[],
  responses: Record<string, object>,
  extra: Record<string, unknown> = {},
) => ({
  summary,
  tags: [tag],
  security,
  responses: Object.fromEntries(
    Object.entries(responses).map(([code, value]) => [code, value]),
  ),
  ...extra,
});
const ok = (schema: object, description = "Successful response") =>
  response(description, data(schema));
const commonErrors = {
  "400": response("Invalid request or validation failure", ErrorEnvelope),
  "401": response("Missing or invalid credential", ErrorEnvelope),
  "403": response("Insufficient access or grant", ErrorEnvelope),
  "404": response("Resource not found", ErrorEnvelope),
  "413": response("Request body exceeds the 16 KiB limit", ErrorEnvelope),
  "429": response("Rate limit or workspace capacity limit", ErrorEnvelope),
  "503": response(
    "Service or required integration is not configured",
    ErrorEnvelope,
  ),
  "500": response("Internal error", ErrorEnvelope),
};

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  const add = (path: string, method: string, operation: object) => {
    paths[path] ??= {};
    paths[path][method] = operation;
  };
  const body = (schema: z.ZodType | object, example?: object) => ({
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: schema instanceof z.ZodType ? j(schema) : schema,
          ...(example ? { example } : {}),
        },
      },
    },
  });
  const manifestBody = (schema: z.ZodType, example: object) => ({
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            ...(j(schema) as any),
            properties: {
              ...(j(schema) as any).properties,
              manifest: ref("Manifest"),
            },
          },
          example,
        },
      },
    },
  });
  const authOp = (
    summary: string,
    tag: string,
    security: object[],
    success: object,
    description?: string,
    extras: any = {},
  ) =>
    op(
      summary,
      tag,
      security,
      { "200": ok(success), ...commonErrors },
      { ...(description ? { description } : {}), ...extras },
    );
  const agent = [{ AgentAuth: [] }, { OAuthAuth: [] }],
    owner = ownerBearer,
    device = deviceBearer;
  add(
    "/healthz",
    "get",
    op("Check service health", "System", [], {
      "200": response(
        "Health fields; hosted includes deployment configuration, transport-neutral handler returns service and protocolVersion.",
        {
          type: "object",
          properties: {
            service: { type: "string", const: "openlaunch" },
            protocolVersion: { type: "integer", const: 1 },
            commit: { type: "string" },
            authConfigured: { type: "boolean" },
            deviceControlsEnabled: { type: "boolean" },
          },
          required: ["service", "protocolVersion"],
        },
      ),
    }),
  );
  add(
    "/v1/account",
    "get",
    authOp(
      "Get signed-in owner account context",
      "Owner",
      owner,
      ref("Account"),
      "Hosted owner endpoint. Agent tokens are not accepted as owner sessions.",
    ),
  );
  add(
    "/v1/devices",
    "get",
    authOp(
      "List visible devices",
      "Owner and agent",
      [...owner, ...agent],
      arr(ref("Device")),
      "Owner receives workspace devices. Agent receives only devices covered by current grants, with grant-filtered capabilities.",
    ),
  );
  add(
    "/v1/actions",
    "get",
    authOp(
      "List action history",
      "Owner",
      owner,
      arr(ref("ActionHistory")),
      "Owner-only; returns the most recent 100 actions.",
    ),
  );
  add(
    "/v1/actions/export",
    "get",
    authOp("Export action history", "Owner", owner, ref("HistoryExport")),
  );
  add(
    "/v1/actions/{actionId}",
    "get",
    authOp(
      "Get action state",
      "Owner and agent",
      [...owner, ...agent],
      ref("ActionReceipt"),
      "Caller must be allowed the action's device function. The outcome can be unknown after disconnect; delivery is not exactly once.",
      {
        parameters: [
          { name: "actionId", in: "path", required: true, schema: uuid },
        ],
      },
    ),
  );
  add("/v1/actions/{actionId}/cancel", "post", {
    ...op(
      "Cancel queued action",
      "Owner and agent",
      [...owner, ...agent],
      {
        "200": ok(ref("ActionReceipt")),
        "409": response(
          "Only queued, undispatched actions can be cancelled",
          ErrorEnvelope,
        ),
        ...commonErrors,
      },
      {
        description:
          "Requires action access and a current device grant. Only undispatched queued actions can be cancelled; cancellation cannot undo an action already received by a device.",
        parameters: [
          { name: "actionId", in: "path", required: true, schema: uuid },
        ],
      },
    ),
    "x-codeSamples": codeSamples("cancel"),
  });
  add(
    "/v1/functions",
    "get",
    authOp(
      "List callable functions",
      "Owner and agent",
      [...owner, ...agent],
      arr(ref("Function")),
      "Returns built-in and custom functions the caller currently has grants to invoke; owner sees available workspace functions. Every invocation is checked again against current grants and device argument schema.",
    ),
  );
  add(
    "/v1/agent-connections",
    "get",
    authOp(
      "List agent connections",
      "Owner",
      owner,
      arr(ref("AgentConnection")),
    ),
  );
  add(
    "/v1/agent-connections",
    "post",
    op(
      "Create agent API connection",
      "Owner",
      owner,
      {
        "201": ok(
          ref("NewConnection"),
          "Created; bearer token is returned once",
        ),
        ...commonErrors,
      },
      {
        ...body(createAgentConnectionSchema, {
          name: "automation",
          ttlSeconds: 86400,
          access: "act",
          role: "operator",
        }),
        description:
          "Agent connections cannot attach devices. Access read/act is a ceiling; action calls also require a live per-device function grant. New connections are admitted with an all-devices operator access policy (opt-out exclusions can be set afterwards via /v1/access-policies); an explicit access read is preserved as the ceiling. Requesting role administrator requires an owner session. The token is returned once; if the access policy cannot be applied, the token is not issued and the pending connection is reconciled by the owner console.",
      },
    ),
  );
  for (const path of ["/v1/device-setup-tokens", "/v1/sdk-tokens"]) {
    const legacyAlias = path === "/v1/sdk-tokens";
    add(
      path,
      "get",
      authOp(
        legacyAlias
          ? "List setup tokens (legacy alias)"
          : "List device setup tokens",
        "Setup",
        owner,
        arr(ref("AgentConnection")),
        "The legacy sdk-tokens path aliases device-setup-tokens.",
      ),
    );
    add(
      path,
      "post",
      op(
        legacyAlias
          ? "Create setup token (legacy alias)"
          : "Create attach-only device setup token",
        "Setup",
        owner,
        {
          "201": ok(
            ref("NewConnection"),
            "Created; setup token is returned once",
          ),
          ...commonErrors,
        },
        {
          ...body(createSetupTokenSchema, {
            name: "bench device",
            ttlSeconds: 600,
            deviceLimit: 1,
          }),
          description:
            "Default lifetime is 10 minutes and default limit is one device. Setup credentials can only attach devices; attachment does not grant function access.",
        },
      ),
    );
  }
  for (const prefix of [
    "/v1/agent-connections",
    "/v1/device-setup-tokens",
    "/v1/sdk-tokens",
  ])
    add(
      `${prefix}/{connectionId}/revoke`,
      "post",
      authOp(
        prefix === "/v1/agent-connections"
          ? "Revoke agent connection"
          : prefix === "/v1/sdk-tokens"
            ? "Revoke setup token (legacy alias)"
            : "Revoke setup token",
        prefix === "/v1/agent-connections" ? "Owner" : "Setup",
        owner,
        ref("Ok"),
        undefined,
        {
          parameters: [
            { name: "connectionId", in: "path", required: true, schema: uuid },
          ],
        },
      ),
    );
  add(
    "/v1/oauth-clients",
    "get",
    authOp("List OAuth clients", "OAuth", owner, {
      type: "object",
      properties: {
        available: { type: "boolean" },
        clients: arr(ref("AgentConnection")),
      },
      required: ["available", "clients"],
    }),
  );
  add("/v1/oauth-clients", "post", {
    ...op(
      "Register OAuth client",
      "OAuth",
      owner,
      {
        "201": ok(
          ref("OAuthRegistration"),
          "Created; client secret, when issued, appears only in this response",
        ),
        ...commonErrors,
      },
      {
        ...body({
          ...j(oauthClientConfigSchema),
          properties: {
            ...(j(oauthClientConfigSchema) as any).properties,
            redirectUris: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string", format: "uri" },
            },
          },
        }),
        description:
          "Exact HTTPS callbacks or literal loopback HTTP callbacks only. OAuth read/act scopes cap access but do not create device grants.",
      },
    ),
  });
  add(
    "/v1/oauth-clients/{clientId}/revoke",
    "post",
    authOp(
      "Revoke OAuth client",
      "OAuth",
      owner,
      ref("OAuthRevocation"),
      undefined,
      {
        parameters: [
          { name: "clientId", in: "path", required: true, schema: uuid },
        ],
      },
    ),
  );
  add(
    "/v1/access-policies",
    "get",
    authOp(
      "List access policies",
      "Access",
      owner,
      arr(ref("AccessPolicy")),
      "Lists the workspace's delegation policies. The owner sees all; a delegated administrator sees the policies its live role permits. Legacy per-device grants are not listed here (see /v1/grants).",
    ),
  );
  add("/v1/access-policies", "post", {
    ...op(
      "Set one principal's access policy",
      "Access",
      owner,
      { "200": ok(ref("AccessPolicy")), ...commonErrors },
      {
        ...body(accessPolicyRequestSchema, {
          principal: "connection:00000000-0000-4000-8000-000000000001",
          mode: "all",
          excludedDevices: [],
          excludedFunctions: [],
          role: "operator",
          expiresAt: null,
        }),
        description:
          "Full-policy replacement for one principal. mode selected keeps the legacy per-device grant list; mode all covers every device with opt-out excludedDevices and excludedFunctions. Only the workspace owner can grant role administrator or set delegatedFrom ancestry; delegated administrators may update operator policies for other principals and can never modify their own policy.",
      },
    ),
  });
  add(
    "/v1/access",
    "get",
    authOp(
      "Inspect effective current access",
      "Access",
      [...owner, ...agent],
      ref("EffectiveAccess"),
      "Returns the caller's effective policy after OAuth admission and policy application: role, device mode, opt-out exclusions and expiry. For mode selected the result reflects the live legacy per-device grants. Every request re-evaluates this before any handler or tool runs.",
    ),
  );
  add(
    "/v1/onboarding",
    "get",
    authOp(
      "Get onboarding status",
      "Access",
      [...owner, ...agent],
      ref("Onboarding"),
      "Current devices, setup-token and agent-connection readiness, and suggested next steps computed from live hub state. Operators receive forbidden with the required next step.",
    ),
  );
  add(
    "/v1/workspaces",
    "get",
    authOp(
      "List workspaces for the signed-in identity",
      "Workspace",
      owner,
      arr(ref("WorkspaceMembership")),
      "Hosted identity endpoint: workspaces this identity owns or has joined, with the role in each.",
    ),
  );
  add("/v1/workspaces/select", "post", {
    ...op(
      "Select active workspace",
      "Workspace",
      owner,
      { "200": ok({ type: "object", properties: { workspace: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["workspace"], additionalProperties: false }), ...commonErrors },
      {
        ...body({
          type: "object",
          properties: { workspace: { type: "string", pattern: "^[a-f0-9]{64}$" } },
          required: ["workspace"],
          additionalProperties: false,
        }),
        description:
          "Switches the signed-in identity's active workspace. Membership is required; agent API credentials are bound to one workspace and cannot switch.",
      },
    ),
  });
  add("/v1/workspaces/accept", "post", {
    ...op(
      "Accept workspace invitation",
      "Workspace",
      owner,
      { "200": ok(ref("WorkspaceMembership")), ...commonErrors },
      {
        ...body({
          type: "object",
          properties: { invitation: { type: "string" } },
          required: ["invitation"],
          additionalProperties: false,
        }),
        description:
          "Redeems a one-time invitation secret and joins that workspace with the invited role. The invitation expires and records its redeemer; revoked members need explicit owner restoration.",
      },
    ),
  });
  add(
    "/v1/workspace/agents",
    "get",
    authOp(
      "List workspace members",
      "Workspace",
      owner,
      arr(ref("WorkspaceAgent")),
      "Owner or workspace administrator. Lists member identities with role and revoked status.",
    ),
  );
  add("/v1/workspace/invitations", "post", {
    ...op(
      "Invite a workspace member",
      "Workspace",
      owner,
      { "201": ok(ref("WorkspaceInvitation")), ...commonErrors },
      {
        ...body({
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            role: { type: "string", enum: ["operator", "administrator"], default: "operator" },
            ttlSeconds: { type: "integer", minimum: 60, maximum: 3600, default: 600 },
          },
          required: ["name"],
          additionalProperties: false,
        }),
        description:
          "Creates a one-time invitation. Only the workspace owner can delegate administration (role administrator). The invitation secret is shown once and stored only as a hash.",
      },
    ),
  });
  add("/v1/workspace/agents/{agentId}/revoke", "post", {
    ...op(
      "Revoke workspace member",
      "Workspace",
      owner,
      { "200": ok(ref("Ok")), ...commonErrors },
      {
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string", pattern: "^agent:[a-f0-9]{64}$" } },
        ],
        description:
          "Owner or workspace administrator; a member cannot revoke itself. The member's live policy denies all functions immediately and its bound credentials are revoked.",
      },
    ),
  });
  add("/v1/cli-login/authorize", "post", {
    ...op(
      "Authorize CLI login",
      "Workspace",
      owner,
      { "200": ok(ref("CliAuthorization")), ...commonErrors },
      {
        ...body({
          type: "object",
          properties: {
            callbackUrl: {
              type: "string",
              format: "uri",
              description: "Exact 127.0.0.1 loopback callback URL with a port.",
            },
            state: { type: "string" },
            challenge: { type: "string", description: "PKCE S256 challenge." },
          },
          required: ["callbackUrl", "state", "challenge"],
          additionalProperties: false,
        }),
        description:
          "Starts a CLI login for the signed-in identity: returns a one-time code delivered to the loopback callback, valid for 60 seconds.",
      },
    ),
  });
  add("/v1/cli-login/exchange", "post", {
    ...op(
      "Exchange CLI login code",
      "Workspace",
      [],
      { "200": ok(ref("CliLoginExchange")), ...commonErrors },
      {
        ...body({
          type: "object",
          properties: {
            code: { type: "string" },
            verifier: { type: "string", description: "PKCE verifier." },
          },
          required: ["code", "verifier"],
          additionalProperties: false,
        }),
        description:
          "Unauthenticated exchange: the one-time code plus PKCE verifier is the credential. Returns the agent connection token once, bound to the caller's workspace with a policy delegated from the parent principal (persistent ancestry enforced server-side). Owner review covers privilege amplification.",
      },
    ),
  });
  add(
    "/v1/grants",
    "get",
    authOp(
      "List grants",
      "Owner",
      owner,
      arr(ref("CapabilityGrant")),
      "Owner-only; lists active grants for non-revoked devices.",
    ),
  );
  add("/v1/grants", "post", {
    ...op(
      "Grant device functions",
      "Owner",
      owner,
      { "200": ok(ref("Ok")), ...commonErrors },
      {
        ...body(grantRequestSchema),
        description:
          "Only an owner can grant. Grants are per principal and device, limited to 64 capabilities for Home Assistant linked devices, 24 for Linux and 16 for other kinds, default to one hour and may be made persistent with null expiry.",
      },
    ),
  });
  add("/v1/grants/revoke", "post", {
    ...op(
      "Revoke device function grant",
      "Owner",
      owner,
      { "200": ok(ref("Ok")), ...commonErrors },
      body(revokeGrantRequestSchema),
    ),
  });
  add("/v1/enrollments", "post", {
    ...op(
      "Create legacy board enrollment",
      "Setup",
      owner,
      {
        "201": ok(ref("Enrollment")),
        ...commonErrors,
      },
      {
        ...body(enrollmentRequestSchema),
        description:
          "Legacy board-bound enrollment code is single use and expires after 10 minutes.",
      },
    ),
  });
  add("/v1/device/enroll", "post", {
    ...op(
      "Enroll legacy board",
      "Setup",
      [],
      { "201": ok(ref("AttachedDevice")), ...commonErrors },
      {
        ...manifestBody(enrollRequestSchema, {
          token: "<single-use enrollment token>",
          manifest: {
            name: "board",
            kind: "uno-r4-wifi",
            capabilities: ["device.health"],
          },
        }),
        description:
          "Legacy enrollment route; code is single use and expires after 10 minutes.",
      },
    ),
  });
  add("/v1/sdk/devices", "post", {
    ...op(
      "Attach SDK device",
      "Setup",
      [{ SetupAuth: [] }],
      {
        "201": ok(ref("AttachedDevice")),
        "409": response(
          "Attachment retry expired or request ID reused with a different manifest",
          ErrorEnvelope,
        ),
        ...commonErrors,
      },
      {
        ...manifestBody(attachRequestSchema, {
          requestId: "00000000-0000-4000-8000-000000000001",
          manifest: {
            name: "board",
            kind: "uno-r4-wifi",
            capabilities: ["device.health"],
          },
        }),
        description:
          "Requires an attach-only setup token. requestId enables recovery of a lost response for 10 minutes when the manifest fingerprint is unchanged. It creates no function grants.",
      },
    ),
  });
  add(
    "/v1/devices/{deviceId}/revoke",
    "post",
    authOp(
      "Revoke device",
      "Owner",
      owner,
      ref("Ok"),
      "Revokes the child device credential and cancels queued actions.",
      {
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
      },
    ),
  );
  add("/v1/devices/{deviceId}/actions", "post", {
    ...op(
      "Request device action",
      "Agent",
      [...owner, ...agent],
      {
        "202": ok(ref("ActionReceipt"), "Accepted into queue"),
        "409": response(
          "Idempotency key conflict, device offline, or action cannot proceed",
          ErrorEnvelope,
        ),
        ...commonErrors,
      },
      {
        ...body(actionRequestSchema, {
          capability: "device.health",
          arguments: {},
          idempotencyKey: "request-001",
          ttlSeconds: 30,
        }),
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Requires action scope for OAuth callers and a current per-device capability grant. Idempotency key is 1–128 characters; TTL defaults to 30 seconds and is at most 300 seconds. Duplicate retries with the same key and identical request return the existing receipt; key reuse with a different request conflicts. Physical execution is not exactly once.",
      },
    ),
    "x-codeSamples": codeSamples("action"),
  });
  add("/v1/broadcasts", "post", {
    ...op(
      "Request action on multiple devices",
      "Agent",
      [...owner, ...agent],
      {
        "202": ok(
          {
            type: "array",
            items: ref("BroadcastResult"),
          },
          "Each device has an independent action or error",
        ),
        "409": response(
          "Individual device actions can conflict; inspect each result item",
          ErrorEnvelope,
        ),
        ...commonErrors,
      },
      {
        ...body(broadcastRequestSchema),
        description:
          "Up to 20 devices. Per-device authorization and schema checks apply. Results are independent; broadcast is not atomic. TTL defaults to 30 seconds and is at most 300 seconds.",
      },
    ),
    "x-codeSamples": codeSamples("broadcast"),
  });
  add("/v1/device/{deviceId}/manifest", "post", {
    ...op(
      "Publish device manifest",
      "Device",
      device,
      { "200": ok(ref("ManifestUpdate")), ...commonErrors },
      {
        ...manifestBody(manifestRequestSchema, {
          manifest: {
            name: "board",
            kind: "uno-r4-wifi",
            capabilities: ["device.health"],
          },
        }),
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Manifest changes require owner reapproval: prior grants are revoked, queued actions are cancelled, and received action outcomes remain uncertain.",
      },
    ),
  });
  add(
    "/v1/device/{deviceId}/next",
    "post",
    op(
      "Poll for next action",
      "Device",
      device,
      { "200": ok(ref("DeviceNext")), ...commonErrors },
      {
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Returns a queued command and marks it received, or null when no command is available. Device reports the correlated result over HTTPS.",
      },
    ),
  );
  add(
    "/v1/devices/{deviceId}/gateway-grants",
    "post",
    op(
      "Grant current gateway inventory",
      "Owner",
      owner,
      {
        "200": ok({
          type: "object",
          properties: { ok: { type: "boolean" }, devices: { type: "integer" } },
          required: ["ok", "devices"],
        }),
        ...commonErrors,
      },
      {
        ...body(gatewayGrantSchema),
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Owner-only convenience for current gateway and linked devices. Mode read grants read functions; control grants all. Integration-wide HA service devices require includeServices. Future devices remain ungranted. Replaces this principal’s grants for this gateway and its children; omitted service devices lose previous grants and their queued commands are cancelled. Other gateways are unaffected. Per-device grants remain independently revocable.",
      },
    ),
  );
  for (const [suffix, summary, requestSchema, responseSchema, description] of [
    [
      "children",
      "Discover gateway devices",
      gatewayChildrenSchema,
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            deviceId: uuid,
            revoked: { type: "boolean" },
            grantsRevoked: { type: "boolean" },
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["key"],
        },
      },
      "Upsert up to eight gateway-owned devices by stable key. Only a gateway admitted with an owner-set child limit may call this route. No grants or child credentials are issued. Changed manifests revoke grants; owner-revoked children cannot be revived. A batch returns an independent result/error per child. Authenticated gateway requests allow up to 64 KiB.",
    ],
    [
      "children/status",
      "Report gateway connectivity and inventory",
      gatewayStatusSchema,
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      "Report the upstream connection separately from gateway presence. Optional keys are the complete current inventory; missing children lose their grants and queued work is cancelled. Transient upstream disconnection without keys preserves grants. Revoking the gateway revokes all children. Authenticated gateway inventory reconciliation allows up to 512 KiB for a complete bounded key list.",
    ],
  ] as const)
    add(`/v1/device/{deviceId}/${suffix}`, "post", {
      ...op(
        summary,
        "Device",
        device,
        { "200": ok(responseSchema), ...commonErrors },
        {
          ...body(requestSchema),
          parameters: [
            { name: "deviceId", in: "path", required: true, schema: uuid },
          ],
          description,
        },
      ),
    });
  add("/v1/device/{deviceId}/heartbeat", "post", {
    ...op(
      "Refresh device presence",
      "Device",
      device,
      {
        "200": ok({
          type: "object",
          properties: { lastSeen: { type: "integer" } },
          required: ["lastSeen"],
        }),
        ...commonErrors,
      },
      {
        ...body(heartbeatRequestSchema),
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Authenticated presence only. Does not fetch, dispatch, complete or replay an action, extend its expiry, or change any grant. Used during long execution when ordinary device polling is paused.",
      },
    ),
  });
  add("/v1/device/{deviceId}/result", "post", {
    ...op(
      "Report action result",
      "Device",
      device,
      { "200": ok(ref("ActionReceipt")), ...commonErrors },
      {
        ...body(resultRequestSchema),
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Correlated outcome can be succeeded or failed. Request bodies are limited to 16 KiB, except authenticated Linux result uploads up to 64 KiB. Only desktop.screenshot may return up to 48 KiB of UTF-8 JSON; other results retain their 4096-character limit. Results must fit the workspace's 16 MiB logical storage budget. Exact repeats are idempotent; conflicting repeats are rejected. Delivery does not guarantee exactly-once physical execution.",
      },
    ),
  });
  add("/v1/device/{deviceId}/events-ticket", "post", {
    ...op(
      "Issue one-use WebSocket ticket",
      "Device",
      device,
      {
        "201": ok({
          type: "object",
          properties: {
            ticket: { type: "string" },
            expiresAt: { type: "integer" },
          },
          required: ["ticket", "expiresAt"],
        }),
        ...commonErrors,
      },
      {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                maxProperties: 0,
                additionalProperties: false,
              },
              example: {},
            },
          },
        },
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
        ],
        description:
          "Ticket expires after 30 seconds. Pass as the ticket.* WebSocket subprotocol during handshake; never put it in a URL query.",
      },
    ),
  });
  add(
    "/v1/device/{deviceId}/events",
    "get",
    op(
      "Open device wake WebSocket",
      "Device",
      [{ TicketSubprotocol: [] }],
      {
        "101": response(
          "WebSocket upgrade. Sends payload-free work hints; read actions and report outcomes over HTTPS.",
        ),
      },
      {
        parameters: [
          { name: "deviceId", in: "path", required: true, schema: uuid },
          {
            name: "workspace",
            in: "query",
            required: true,
            description:
              "Public workspace routing identifier; not a credential.",
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        ],
        description:
          "Interactive OpenAPI clients cannot establish this WebSocket upgrade. Offer subprotocols openlaunch.device-events.v1 and ticket.<one-use-ticket>; the ticket expires after 30 seconds and is consumed once. Do not send a bearer header or put the secret ticket in a URL query. The channel carries no action payload.",
      },
    ),
  );
  add(
    "/.well-known/oauth-protected-resource",
    "get",
    op("OAuth protected resource metadata", "OAuth", [], {
      "200": response("Protected resource metadata", {
        type: "object",
        properties: {
          resource: { type: "string" },
          authorization_servers: arr({ type: "string" }),
          scopes_supported: {
            type: "array",
            items: {
              type: "string",
              enum: ["openlaunch:read", "openlaunch:act"],
            },
          },
        },
        required: ["resource", "authorization_servers", "scopes_supported"],
      }),
    }),
  );
  add("/.well-known/oauth-protected-resource/mcp", "get", {
    ...paths["/.well-known/oauth-protected-resource"].get,
    summary: "MCP OAuth metadata path alias",
  });
  add(
    "/mcp",
    "post",
    op(
      "Call authenticated MCP endpoint",
      "MCP",
      agent,
      {
        "200": response("MCP JSON response or server-sent event stream"),
        "400": response("JSON-RPC or MCP protocol error"),
        "401": response("Authentication required", ErrorEnvelope),
        "403": response("Scope or live device grant required", ErrorEnvelope),
        "406": response(
          "Accept must include application/json and text/event-stream",
        ),
        "415": response("Content-Type must be application/json"),
      },
      {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description:
                  "MCP JSON-RPC request. 2026-07-28 per-request protocol requires matching MCP-Protocol-Version and MCP-Method headers plus matching metadata; legacy Streamable HTTP initialization handshake remains supported.",
                required: ["jsonrpc", "method"],
                properties: {
                  jsonrpc: { type: "string", const: "2.0" },
                  id: { type: ["integer", "string"] },
                  method: { type: "string" },
                  params: { type: "object", additionalProperties: true },
                },
              },
              example: {
                jsonrpc: "2.0",
                id: 1,
                method: "server/discover",
                params: {
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              },
            },
          },
        },
        description:
          "OAuth scopes read/act bound access but do not grant device functions. Every device tool also checks current owner grant. The separate public /docs-mcp service is read-only documentation.",
        parameters: [
          {
            name: "MCP-Protocol-Version",
            in: "header",
            schema: { type: "string" },
            example: "2026-07-28",
            description:
              "Required for modern requests; must match params._meta protocolVersion.",
          },
          {
            name: "Mcp-Method",
            in: "header",
            schema: { type: "string" },
            example: "server/discover",
            description:
              "Required for modern requests; must match the JSON-RPC method.",
          },
          {
            name: "Mcp-Name",
            in: "header",
            schema: { type: "string" },
            description:
              "Required for modern tools/call and resources/read; match tool name or resource URI. Unicode values use the protocol's base64 header encoding.",
          },
        ],
      },
    ),
  );
  const securitySchemes = {
    OwnerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Clerk owner session",
      description: "Owner identity required.",
    },
    AgentAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "ol_agent token",
      description:
        "Owner-issued agent API connection; access ceiling and live device grants are checked separately.",
    },
    OAuthAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "OAuth access token",
      description:
        "OAuth read/act scope is a ceiling. Scopes do not create device grants.",
    },
    SetupAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "ol_sdk setup token",
      description:
        "Attach-only credential with a finite device limit. Attachment does not grant functions.",
    },
    DeviceAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "device child credential",
      description:
        "Child device credential, independently revocable from its setup token.",
    },
    TicketSubprotocol: {
      type: "apiKey",
      in: "header",
      name: "Sec-WebSocket-Protocol",
      description:
        "Offer openlaunch.device-events.v1, ticket.<one-use ticket>. The ticket comes from the authenticated events-ticket endpoint, expires in 30 seconds, and is never a URL query parameter.",
    },
  };
  paths["/v1/devices"].get["x-codeSamples"] = codeSamples("devices");
  paths["/v1/functions"].get["x-codeSamples"] = codeSamples("functions");
  paths["/v1/actions/{actionId}"].get["x-codeSamples"] = codeSamples("get");
  paths["/v1/actions/{actionId}"].get["x-codeSamples"].push(
    ...codeSamples("watch"),
  );
  paths["/healthz"].get.description =
    "Inspect the hosted service and deployment configuration. Service health does not establish device health or physical execution. The local handler wraps its smaller health object in data.";
  paths["/v1/oauth-clients"].get.description =
    "List registered OAuth clients in the owner's workspace and whether provider registration is available. Client secrets are never returned by this read.";
  paths["/v1/agent-connections"].get.description =
    "List agent API connections in the owner's workspace, including their access ceiling and lifetime. Stored credential secrets are omitted.";
  paths["/v1/actions/export"].get.description =
    "Download all retained owner action receipts, up to 5,000 entries within the workspace storage budget. Exporting does not remove history or idempotency protection.";
  paths["/v1/grants/revoke"].post.description =
    "Remove this principal's device grant. Later agent requests are denied, queued commands are cancelled and already received outcomes remain uncertain.";
  for (const [path, methods] of Object.entries(paths))
    if (path === "/v1/device/enroll" || path.startsWith("/v1/device/"))
      for (const operation of Object.values(methods as Record<string, any>)) {
        operation.parameters ??= [];
        operation.parameters.push({
          name: "x-openlaunch-workspace",
          in: "header",
          required: true,
          description: path.endsWith("/events")
            ? "Workspace routing identifier for the device credential; not a secret. Must match the workspace query parameter."
            : "Workspace routing identifier for the device credential; not a secret.",
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
        });
      }
  for (const [path, methods] of Object.entries(paths))
    for (const [method, operation] of Object.entries(
      methods as Record<string, any>,
    )) {
      const words = `${method}_${path}`
        .replace(/[{}]/g, "")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
      operation.operationId = words
        .map((word, index) =>
          index ? word[0]!.toUpperCase() + word.slice(1) : word,
        )
        .join("");
    }
  return {
    openapi: "3.1.0",
    info: {
      title: "openlaunch API",
      version: "1.0.0",
      description:
        "Provider-independent API for owner-managed device functions. Device attachment, agent access and function grants are separate permissions. Timestamps use Unix milliseconds. Most HTTP responses wrap data or error; health and OAuth metadata are raw objects. MCP uses its own JSON-RPC envelopes and protocol headers.",
    },
    servers: [{ url: "https://www.openlaunch.dev", description: "Hosted API" }],
    tags: [
      "System",
      "Owner",
      "Setup",
      "OAuth",
      "Agent",
      "Owner and agent",
      "Access",
      "Workspace",
      "Device",
      "MCP",
    ].map((name) => ({ name })),
    paths,
    components: { securitySchemes, schemas },
    "x-mcp": {
      protocolVersion: "2026-07-28",
      legacyHandshake:
        "MCP SDK Streamable HTTP initialization remains supported",
      scopes: ["openlaunch:read", "openlaunch:act"],
      note: "Scopes do not create device grants. The separate /docs-mcp endpoint is public read-only documentation.",
    },
  };
}

function codeSamples(kind: string) {
  const samples: Record<string, [string, string]> = {
    devices: [
      `ol devices list`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst devices = await agent.listDevices();`,
    ],
    functions: [
      `ol functions list`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst functions = await agent.listFunctions();`,
    ],
    get: [
      `ol actions get "$ACTION_ID"`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst action = await agent.getAction(actionId);`,
    ],
    watch: [
      `ol actions watch "$ACTION_ID"`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst terminal = new Set(["succeeded", "failed", "expired", "cancelled", "unknown"]);\nlet action; do { action = await agent.getAction(actionId); if (!terminal.has(action.status)) await new Promise(resolve => setTimeout(resolve, 1000)); } while (!terminal.has(action.status));`,
    ],
    action: [
      `ol call "$DEVICE_ID" device.health '{}' --key health-001`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst receipt = await agent.requestAction(deviceId, { capability: "device.health", arguments: {}, idempotencyKey: "health-001" });`,
    ],
    broadcast: [
      `curl -X POST "\${OPENLAUNCH_URL:-https://www.openlaunch.dev}/v1/broadcasts" -H "Authorization: Bearer $OPENLAUNCH_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"deviceIds":["00000000-0000-4000-8000-000000000001"],"capability":"device.health","arguments":{},"idempotencyKey":"broadcast-001"}'`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst results = await agent.broadcast({ deviceIds, capability: "device.health", arguments: {}, idempotencyKey: "broadcast-001" });`,
    ],
    cancel: [
      `ol actions cancel "$ACTION_ID"`,
      `import { createClient } from "@openlaunch/sdk";\nconst agent = createClient({ url: process.env.OPENLAUNCH_URL ?? "https://www.openlaunch.dev", token: process.env.OPENLAUNCH_AGENT_TOKEN! });\nconst action = await agent.cancelAction(actionId);`,
    ],
  };
  const [curl, ts] = samples[kind]!;
  return [
    {
      lang: "Shell",
      label: kind === "broadcast" ? "curl" : "ol CLI",
      source: curl,
    },
    { lang: "TypeScript", label: "openlaunch SDK", source: ts },
  ];
}
