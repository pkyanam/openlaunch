import { z } from "zod";
import { Fault, type Hub, type Principal } from "../../core/src/index.ts";
import {
  createToolCatalog,
  instructions,
  runTool,
  serverInfo,
  toolAnnotations,
  toolNeedsActionScope,
} from "./index.ts";

export const MCP_VERSION = "2026-07-28";
export const MCP_SUPPORTED_VERSIONS = [
  MCP_VERSION,
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const prefix = "io.modelcontextprotocol/";
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const metaKey =
  /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/;
const object = z.object({}).passthrough();
const clientCapabilities = z
  .object({
    roots: object.optional(),
    sampling: z
      .object({ context: object.optional(), tools: object.optional() })
      .passthrough()
      .optional(),
    elicitation: z
      .object({ form: object.optional(), url: object.optional() })
      .passthrough()
      .optional(),
    experimental: z.record(z.string(), object).optional(),
    extensions: z
      .record(
        z
          .string()
          .regex(metaKey)
          .refine((key) => key.includes("/")),
        object,
      )
      .optional(),
  })
  .passthrough();
export const rpcError = (
  id: unknown,
  code: number,
  message: string,
  status = 400,
  data?: unknown,
) =>
  Response.json(
    {
      jsonrpc: "2.0",
      ...(typeof id === "string" || Number.isSafeInteger(id) ? { id } : {}),
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );

export function usesPerRequestProtocol(request: Request, body: any) {
  const version = request.headers.get("mcp-protocol-version");
  return (
    body?.params?._meta?.[prefix + "protocolVersion"] !== undefined ||
    (version !== null && !MCP_SUPPORTED_VERSIONS.slice(1).includes(version)) ||
    body?.method === "server/discover"
  );
}
function decodeHeader(value: string | null) {
  if (value === null) return null;
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    const encoded = value.slice(9, -2);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw Error("Invalid header encoding");
    const decoded = atob(encoded);
    if (btoa(decoded) !== encoded) throw Error("Invalid header encoding");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(decoded, (char) => char.charCodeAt(0)),
    );
  }
  if (!/^[\x20-\x7e\t]*$/.test(value) || value.trim() !== value)
    throw Error("Invalid header encoding");
  return value;
}
export function validatePerRequestMcp(
  request: Request,
  message: unknown,
):
  | Response
  | { id: string | number; method: string; params: Record<string, any> } {
  if (
    !record(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    !(typeof message.id === "string" || Number.isSafeInteger(message.id))
  )
    return rpcError(
      record(message) ? message.id : null,
      -32600,
      "Expected one JSON-RPC request with a string or integer id",
    );
  const { id, method } = message;
  const params = message.params;
  if (!record(params) || !record(params._meta))
    return rpcError(id, -32602, "Per-request metadata is required");
  if (Object.keys(params._meta).some((key) => !metaKey.test(key)))
    return rpcError(id, -32602, "Invalid metadata key");
  const version = params._meta[prefix + "protocolVersion"];
  if (typeof version !== "string")
    return rpcError(id, -32602, "Protocol version metadata is required");
  if (
    request.headers.get("mcp-protocol-version") !== version ||
    request.headers.get("mcp-method") !== method ||
    !/^[\x21-\x7e]+$/.test(version) ||
    !/^[\x21-\x7e]+$/.test(method)
  )
    return rpcError(
      id,
      -32020,
      "Required MCP headers are missing or do not match the request body",
    );
  if (version !== MCP_VERSION)
    return rpcError(
      id,
      -32022,
      "Unsupported per-request protocol version",
      400,
      { supported: MCP_SUPPORTED_VERSIONS, requested: version },
    );
  if (
    !clientCapabilities.safeParse(params._meta[prefix + "clientCapabilities"])
      .success
  )
    return rpcError(
      id,
      -32602,
      "Valid client capabilities metadata is required",
    );
  const progress = params._meta.progressToken;
  if (
    progress !== undefined &&
    typeof progress !== "string" &&
    !Number.isSafeInteger(progress)
  )
    return rpcError(id, -32602, "Invalid progress token");
  const logLevel = params._meta[prefix + "logLevel"];
  if (
    logLevel !== undefined &&
    ![
      "debug",
      "info",
      "notice",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ].includes(logLevel)
  )
    return rpcError(id, -32602, "Invalid log level");
  const clientInfo = params._meta[prefix + "clientInfo"];
  if (
    clientInfo !== undefined &&
    (!record(clientInfo) ||
      typeof clientInfo.name !== "string" ||
      typeof clientInfo.version !== "string")
  )
    return rpcError(id, -32602, "Invalid client information");
  if (
    method === "tools/call" &&
    (typeof params.name !== "string" ||
      (params.arguments !== undefined && !record(params.arguments)) ||
      (params.requestState !== undefined &&
        typeof params.requestState !== "string") ||
      (params.inputResponses !== undefined &&
        (!record(params.inputResponses) ||
          Object.keys(params.inputResponses).length > 0)))
  )
    return rpcError(
      id,
      -32602,
      "Invalid tool request or unsupported input continuation",
    );
  if (["tools/call", "resources/read", "prompts/get"].includes(method)) {
    try {
      const name = method === "resources/read" ? params.uri : params.name;
      if (
        typeof name !== "string" ||
        decodeHeader(request.headers.get("mcp-name")) !== name
      )
        return rpcError(
          id,
          -32020,
          "Mcp-Name is missing or does not match the request body",
        );
    } catch {
      return rpcError(id, -32020, "Invalid Mcp-Name header encoding");
    }
  }
  return { id, method, params };
}
export function handlePerRequestMcp(
  request: Request,
  message: unknown,
  hub: Hub,
  p: Principal,
): Response {
  const validated = validatePerRequestMcp(request, message);
  if (validated instanceof Response) return validated;
  const { id, method, params } = validated;
  const complete = (result: Record<string, unknown>) =>
    Response.json(
      {
        jsonrpc: "2.0",
        id,
        result: {
          ...result,
          resultType: "complete",
          _meta: { [prefix + "serverInfo"]: serverInfo },
        },
      },
      {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  if (method === "server/discover")
    return complete({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions,
      cacheScope: "private",
      ttlMs: 0,
    });
  if (method === "ping") return complete({});
  if (method === "tools/list") {
    if (params.cursor !== undefined)
      return rpcError(id, -32602, "This catalog has no continuation cursor");
    return complete({
      cacheScope: "private",
      ttlMs: 0,
      tools: createToolCatalog(hub, p).map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema, {
          target: "draft-2020-12",
          io: "input",
        }),
        annotations: toolAnnotations(tool.readOnlyHint),
      })),
    });
  }
  if (method === "tools/call") {
    if (
      p.readOnly &&
      toolNeedsActionScope(hub, p, params.name, params.arguments)
    )
      throw new Fault("insufficient_scope", 403, "Write scope required");
    const tool = createToolCatalog(hub, p).find(
      (tool) => tool.name === params.name,
    );
    if (!tool) return rpcError(id, -32602, "Unknown or unavailable tool");
    const parsed = tool.schema.safeParse(params.arguments ?? {});
    if (!parsed.success)
      return complete({
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Invalid tool arguments: " +
              parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; "),
          },
        ],
      });
    return complete(runTool(tool.fn, parsed.data));
  }
  // Optional resources, prompts, sampling, elicitation and extensions are not
  // advertised. Unsupported methods have the status mandated by this version.
  return rpcError(id, -32601, "Method not found", 404);
}
