import { z } from "zod";

// A deliberately bounded JSON Schema vocabulary; no remote references or executable code.
const label = { description: z.string().max(240).optional() };
const property = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("string"),
      ...label,
      minLength: z.number().int().min(0).max(8192).optional(),
      maxLength: z.number().int().min(0).max(8192),
      enum: z.array(z.string().max(1024)).min(1).max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["number", "integer"]),
      ...label,
      minimum: z.number().finite(),
      maximum: z.number().finite(),
    })
    .strict(),
  z.object({ type: z.literal("boolean"), ...label }).strict(),
  z
    .object({
      type: z.literal("object"),
      ...label,
      maxProperties: z.number().int().min(1).max(32),
      additionalProperties: z.literal(true),
    })
    .strict(),
]);
export const capabilityName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
export const functionDefinition = z
  .object({
    name: capabilityName,
    title: z.string().min(1).max(64),
    description: z.string().min(1).max(240),
    access: z.enum(["read", "write"]),
    inputSchema: z
      .object({
        type: z.literal("object"),
        properties: z.record(
          z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/),
          property,
        ),
        required: z.array(z.string()).max(16),
        additionalProperties: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const { properties, required } = definition.inputSchema;
    if (
      Object.keys(properties).length > 16 ||
      new Set(required).size !== required.length ||
      required.some((key) => !Object.hasOwn(properties, key))
    )
      ctx.addIssue({ code: "custom", message: "Invalid function parameters" });
    for (const value of Object.values(properties)) {
      if (value.type === "string" && (value.minLength ?? 0) > value.maxLength)
        ctx.addIssue({ code: "custom", message: "Invalid string bounds" });
      if (value.type === "string" && value.enum) {
        if (new Set(value.enum).size !== value.enum.length)
          ctx.addIssue({ code: "custom", message: "Duplicate string choices" });
        if (
          value.enum.some(
            (choice) =>
              choice.length < (value.minLength ?? 0) ||
              choice.length > value.maxLength,
          )
        )
          ctx.addIssue({
            code: "custom",
            message: "String choices must satisfy their length bounds",
          });
      }
      if (
        value.type === "integer" &&
        Math.max(Math.ceil(value.minimum), Number.MIN_SAFE_INTEGER) >
          Math.min(Math.floor(value.maximum), Number.MAX_SAFE_INTEGER)
      )
        ctx.addIssue({
          code: "custom",
          message: "Integer bounds must include a safe integer",
        });
      if (
        (value.type === "number" || value.type === "integer") &&
        value.minimum > value.maximum
      )
        ctx.addIssue({ code: "custom", message: "Invalid number bounds" });
    }
  });
export type FunctionDefinition = z.infer<typeof functionDefinition>;
export function functionArguments(
  definition: FunctionDefinition,
  input: unknown,
): Record<string, unknown> {
  // Compile the supported vocabulary explicitly. Generic JSON Schema
  // conversion can ignore length constraints when a string also has enum.
  const properties: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(
    definition.inputSchema.properties,
  )) {
    let schema: z.ZodType;
    if (property.type === "string") {
      const text = z
        .string()
        .min(property.minLength ?? 0)
        .max(property.maxLength);
      schema = property.enum
        ? text.refine(
            (value) => property.enum!.includes(value),
            "Unsupported string choice",
          )
        : text;
    } else if (property.type === "boolean") {
      schema = z.boolean();
    } else if (property.type === "object") {
      const canonicalData = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonicalData)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [
                    key,
                    canonicalData((value as Record<string, unknown>)[key]),
                  ]),
              )
            : value;
      schema = z
        .record(z.string(), z.unknown())
        .superRefine((value, ctx) => {
          if (
            Object.keys(value).length > property.maxProperties ||
            !boundedJson(value)
          )
            ctx.addIssue({
              code: "custom",
              message: "JSON data exceeds safe depth, size or value limits",
            });
        })
        .transform((value) => canonicalData(value) as Record<string, unknown>);
    } else {
      const number =
        property.type === "integer" ? z.number().int() : z.number();
      schema = number.min(property.minimum).max(property.maximum);
    }
    properties[name] = definition.inputSchema.required.includes(name)
      ? schema
      : schema.optional();
  }
  return z.object(properties).strict().parse(input);
}

/** Bounded service data, including arrays/nested objects, never executable schema. */
export function boundedJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 6) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 1024;
    if (Array.isArray(item))
      return item.length <= 32 && item.every((v) => visit(v, depth + 1));
    if (!item || typeof item !== "object") return false;
    return (
      Object.entries(item).length <= 32 &&
      Object.entries(item).every(
        ([k, v]) =>
          k.length <= 128 &&
          !["__proto__", "constructor", "prototype"].includes(k) &&
          visit(v, depth + 1),
      )
    );
  };
  if (!visit(value, 0)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2048;
  } catch {
    return false;
  }
}
