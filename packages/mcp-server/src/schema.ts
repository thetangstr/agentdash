import { z } from "zod";

/**
 * Minimal zod → JSON Schema converter for the shapes used by this server's
 * tool schemas (string / number / boolean / enum / literal / array / object /
 * record / union / optional / nullable / default / effects). We hand-roll
 * this because zod-to-json-schema is not a dependency, and zod re-validates
 * every call at execute time anyway — the JSON schema is advisory for the
 * MCP client.
 */
export type JsonSchema = Record<string, unknown>;

// zod 4 reading notes. Dispatch is on the public definition (`_zod.def.type`).
// Refinements are checks on the schema itself (zod 3 wrapped them in
// ZodEffects); `.transform()` is `pipe(schema, transform)` and `z.preprocess()`
// is `pipe(transform, schema)`, each rendered by the side a caller sends, as
// zod 3's ZodEffects was; any other `.pipe()` falls back to `{}` as zod 3's
// ZodPipeline did.
type Def = z.core.$ZodTypeDef & Record<string, unknown>;
type CheckDef = { check: string; [key: string]: unknown };

const DESCRIPTION_INHERITING_WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly"]);

/**
 * The schema's description, as zod 3 would have reported it. zod 3 copied a
 * description onto the wrapper `.optional()` / `.nullable()` / `.default()`
 * built around a described schema; zod 4 keeps it on the inner schema only.
 * A description set on the wrapper itself (even "") still wins.
 */
function descriptionOf(schema: z.ZodType): string | undefined {
  const meta = z.globalRegistry.get(schema);
  if (meta && "description" in meta) return meta.description;
  const def = schema._zod.def as Def;
  if (DESCRIPTION_INHERITING_WRAPPERS.has(def.type)) return descriptionOf(def.innerType as z.ZodType);
  return undefined;
}

function withDescription(schema: JsonSchema, zodSchema: z.ZodType): JsonSchema {
  const description = descriptionOf(zodSchema);
  return typeof description === "string" && description.length > 0
    ? { ...schema, description }
    : schema;
}

function checksOf(schema: z.ZodType): CheckDef[] {
  return ((schema._zod.def as { checks?: Array<{ _zod: { def: CheckDef } }> }).checks ?? []).map((check) => check._zod.def);
}

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const def = schema._zod.def as Def;

  switch (def.type) {
    case "string":
      return withDescription({ type: "string" }, schema);
    case "number": {
      const checks = checksOf(schema);
      const isInt = (typeof def.format === "string" && def.format.includes("int"))
        || checks.some((check) => check.check === "number_format" && String(check.format).includes("int"));
      // AgentDash: repeated Zod bounds are conjunctive. Advertise the strongest
      // bound on each side; an exclusive bound wins a tie at the same value.
      let lower: { value: number; inclusive: boolean } | undefined;
      let upper: { value: number; inclusive: boolean } | undefined;
      for (const check of checks) {
        const bound = { value: check.value as number, inclusive: check.inclusive === true };
        if (check.check === "greater_than" && (!lower || bound.value > lower.value ||
          (bound.value === lower.value && !bound.inclusive))) lower = bound;
        if (check.check === "less_than" && (!upper || bound.value < upper.value ||
          (bound.value === upper.value && !bound.inclusive))) upper = bound;
      }
      const result: JsonSchema = { type: isInt ? "integer" : "number" };
      if (lower) result[lower.inclusive ? "minimum" : "exclusiveMinimum"] = lower.value;
      if (upper) result[upper.inclusive ? "maximum" : "exclusiveMaximum"] = upper.value;
      return withDescription(result, schema);
    }
    case "boolean":
      return withDescription({ type: "boolean" }, schema);
    case "date":
      return withDescription({ type: "string", format: "date-time" }, schema);
    case "enum":
      return withDescription({ type: "string", enum: Object.values(def.entries as Record<string, string>) }, schema);
    case "literal":
      return withDescription({ const: (def.values as unknown[])[0] }, schema);
    case "array":
      return withDescription(
        { type: "array", items: zodToJsonSchema(def.element as z.ZodType) },
        schema,
      );
    case "object": {
      const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      const result: JsonSchema = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return withDescription(result, schema);
    }
    case "record":
      return withDescription(
        { type: "object", additionalProperties: zodToJsonSchema(def.valueType as z.ZodType) },
        schema,
      );
    case "union": {
      const options = def.options as z.ZodType[];
      return withDescription({ anyOf: options.map((option) => zodToJsonSchema(option)) }, schema);
    }
    case "optional":
      // AgentDash: as with nullable/default, an explicit wrapper description
      // takes precedence; otherwise retain the converted inner description.
      return withDescription(zodToJsonSchema(def.innerType as z.ZodType), schema);
    case "nullable": {
      const inner = zodToJsonSchema(def.innerType as z.ZodType);
      return withDescription({ anyOf: [inner, { type: "null" }] }, schema);
    }
    case "default":
    case "prefault": {
      const inner = zodToJsonSchema(def.innerType as z.ZodType);
      return withDescription({ ...inner, default: def.defaultValue }, schema);
    }
    case "pipe": {
      const input = def.in as z.ZodType;
      const output = def.out as z.ZodType;
      if (output._zod.def.type === "transform") return zodToJsonSchema(input);
      if (input._zod.def.type === "transform") return zodToJsonSchema(output);
      return {};
    }
    case "any":
    case "unknown":
      return withDescription({}, schema);
    default:
      // Permissive fallback for anything exotic — zod still validates on call.
      return {};
  }
}

/** Convert a tool's zod object schema into an MCP inputSchema. */
export function toolInputSchema(schema: z.ZodObject): JsonSchema {
  const converted = zodToJsonSchema(schema);
  return { type: "object", properties: {}, ...converted };
}
