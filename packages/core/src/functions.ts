import { z } from "zod";

// A deliberately bounded JSON Schema vocabulary; no remote references or executable code.
const label = { description: z.string().max(240).optional() };
const property = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("string"),
      ...label,
      minLength: z.number().int().min(0).max(1024).optional(),
      maxLength: z.number().int().min(0).max(1024),
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
  return z.fromJSONSchema(definition.inputSchema).parse(input) as Record<
    string,
    unknown
  >;
}
