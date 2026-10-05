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
