import type { FunctionDefinition } from "./functions.ts";

type Kind = "uno-r4-wifi";
type SchemaShape = FunctionDefinition["inputSchema"];

interface FunctionGuide {
  kind: Kind;
  name: string;
  access: "read" | "write";
  schema: SchemaShape;
  text: string;
}

// This is a small, static catalog of verified SDK profiles. It adds language
// guidance only when both the device kind and the complete declared schema
// match. Function names, bounds, access levels and tool schemas always come
// from the live device definition.
const guides: readonly FunctionGuide[] = [
  {
    kind: "uno-r4-wifi",
    name: "roomba.clean",
    access: "write",
    schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          maxLength: 8,
          enum: ["standard", "spot", "max"],
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    text: `Use this function when the owner asks the Roomba to begin cleaning. Choose mode "standard" for a general cleaning request; choose "spot" or "max" only when that mode is requested. Examples: standard clean → {"mode":"standard"}; spot clean → {"mode":"spot"}; max clean → {"mode":"max"}. Examples illustrate arguments and do not grant authorization to act. This starts the robot's built-in routine; it does not accept a route or room selection. The device's local enable and stop-permit inputs still apply. A queued action is pending. A succeeded result confirms serial transmission only, not that cleaning started or finished.`,
  },
  {
    kind: "uno-r4-wifi",
    name: "roomba.dock",
    access: "write",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    text: `Use this function when the owner asks the Roomba to return to its dock. It asks the robot to seek its dock; it does not confirm that the robot reached or connected to the dock. The device's local enable and stop-permit inputs still apply. A queued action is pending. A succeeded result confirms serial transmission only, not docking. Example arguments: {}.`,
  },
  {
    kind: "uno-r4-wifi",
    name: "roomba.pause",
    access: "write",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    text: `Use this function when the owner asks to pause or stop the current Roomba behavior. It sends Safe followed by zero drive and brush outputs off. It is available without the local enable and stop-permit inputs so it can act as a stop. The routine does not save progress and there is no resume operation; a later clean request starts a new routine. A queued action is pending. A succeeded result confirms serial transmission only, not the robot's physical state. Example arguments: {}.`,
  },
  {
    kind: "uno-r4-wifi",
    name: "roomba.drive",
    access: "write",
    schema: {
      type: "object",
      properties: {
        velocityMmS: { type: "integer", minimum: -150, maximum: 150 },
        radiusMm: { type: "integer", minimum: -2000, maximum: 2000 },
        durationMs: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["velocityMmS", "radiusMm", "durationMs"],
      additionalProperties: false,
    },
    text: `Use this function only when the owner requests bounded manual movement. velocityMmS is signed millimeters per second; radiusMm 0 means straight, +1 or -1 means an in-place turn, and other signed values request an arc. durationMs is limited by the declared schema to 1–1000 ms. Example: a short straight movement at 100 mm/s → {"velocityMmS":100,"radiusMm":0,"durationMs":300}. Examples illustrate arguments and do not grant authorization to act. The local enable and stop-permit inputs and firmware lease stop still apply. A queued action is pending. A succeeded result confirms serial transmission only, not physical movement.`,
  },
  {
    kind: "uno-r4-wifi",
    name: "roomba.drive_direct",
    access: "write",
    schema: {
      type: "object",
      properties: {
        rightMmS: { type: "integer", minimum: -150, maximum: 150 },
        leftMmS: { type: "integer", minimum: -150, maximum: 150 },
        durationMs: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["rightMmS", "leftMmS", "durationMs"],
      additionalProperties: false,
    },
    text: `Use this function only when the owner explicitly requests bounded wheel-speed control. rightMmS and leftMmS are independent signed wheel speeds in millimeters per second; durationMs is limited by the declared schema to 1–1000 ms. Example: both wheels forward briefly → {"rightMmS":100,"leftMmS":100,"durationMs":300}. Examples illustrate arguments and do not grant authorization to act. The local enable and stop-permit inputs and firmware lease stop still apply. A queued action is pending. A succeeded result confirms serial transmission only, not physical movement.`,
  },
];

const MAX_GUIDE_CHARS = 4_200;
const MAX_CATALOG_ENTRIES = 16;

if (
  guides.length > MAX_CATALOG_ENTRIES ||
  guides.some((guide) => guide.text.length > MAX_GUIDE_CHARS)
)
  throw new Error("Hosted function guide catalog exceeds its metadata bounds");

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((value, i) => sameJson(value, b[i]))
    );
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = Object.keys(a as object).sort();
    const right = Object.keys(b as object).sort();
    return (
      left.length === right.length &&
      left.every(
        (key, i) =>
          key === right[i] && sameJson((a as any)[key], (b as any)[key]),
      )
    );
  }
  return false;
}

export function functionGuide(
  kind: string,
  definition: FunctionDefinition,
): string {
  const requirements = Object.entries(definition.inputSchema.properties).map(
    ([name, property]) => {
      const required = definition.inputSchema.required.includes(name);
      const prefix = `${name} (${required ? "required" : "optional"}; ${property.type}`;
      if (property.type === "string") {
        if (property.enum) {
          const choices = JSON.stringify(property.enum);
          return `${prefix}; ${property.minLength ?? 0}–${property.maxLength} characters${choices.length <= 120 ? `; choose one of ${choices}` : "; enum choices are shown in the input schema"})`;
        }
        return `${prefix}; ${property.minLength ?? 0}–${property.maxLength} characters)`;
      }
      if (property.type === "number" || property.type === "integer")
        return `${prefix}; ${property.minimum}–${property.maximum})`;
      return `${prefix})`;
    },
  );
  const example: Record<string, unknown> = {};
  for (const name of definition.inputSchema.required) {
    const property = definition.inputSchema.properties[name];
    if (property.type === "string") {
      example[name] = property.enum?.[0] ?? "x".repeat(property.minLength ?? 0);
    } else if (property.type === "boolean") {
      example[name] = false;
    } else {
      example[name] = Math.min(Math.max(0, property.minimum), property.maximum);
      if (property.type === "integer")
        example[name] = Math.ceil(example[name] as number);
    }
  }
  const exampleText = JSON.stringify(example);
  const profile = guides.find(
    (item) =>
      item.kind === kind &&
      item.name === definition.name &&
      item.access === definition.access &&
      sameJson(item.schema, definition.inputSchema),
  );
  const guide = [
    `Schema guide: this capability is declared with ${definition.access} access and accepts only the declared arguments. ${requirements.length ? `Required and optional fields: ${requirements.join("; ")}.` : "It accepts an empty arguments object."}`,
    exampleText.length <= 400
      ? `Example arguments: ${exampleText}.`
      : "Use the declared input schema to construct arguments; its values are too long to repeat as an example.",
    "Examples illustrate valid argument shapes and do not grant authorization. Call only on an explicit owner request. Use a fresh idempotencyKey for each new request. Retries should reuse that key with the same arguments to avoid duplicate work. The optional ttlSeconds defaults to 30 seconds and is bounded by the tool schema. A queued action is pending, not completed; inspect get_action for its status and result. A succeeded result is the device-reported result and does not by itself verify physical state.",
    profile?.text,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (guide.length <= MAX_GUIDE_CHARS) return guide;
  return `Schema guide: this ${definition.access}-access function accepts only the fields, choices and bounds in its input schema. Use a fresh idempotencyKey for a new request and reuse it with the same arguments for retries. ttlSeconds defaults to 30 seconds and is bounded by the tool schema. A queued action is pending; inspect get_action for status and result. A succeeded result is device-reported and does not by itself verify physical state.`;
}
