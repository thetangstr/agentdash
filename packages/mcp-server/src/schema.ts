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

function withDescription(schema: JsonSchema, zodSchema: z.ZodTypeAny): JsonSchema {
  const description = zodSchema._def.description;
  return typeof description === "string" && description.length > 0
    ? { ...schema, description }
    : schema;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
  const typeName = def.typeName;

  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return withDescription({ type: "string" }, schema);
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks as Array<{ kind: string }> | undefined) ?? [];
      const isInt = checks.some((check) => check.kind === "int");
      return withDescription({ type: isInt ? "integer" : "number" }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription({ type: "boolean" }, schema);
    case z.ZodFirstPartyTypeKind.ZodDate:
      return withDescription({ type: "string", format: "date-time" }, schema);
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDescription({ type: "string", enum: [...(def.values as string[])] }, schema);
    case z.ZodFirstPartyTypeKind.ZodNativeEnum: {
      const values = Object.values(def.values as Record<string, unknown>)
        .filter((value) => typeof value === "string" || typeof value === "number");
      return withDescription({ enum: values }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return withDescription({ const: def.value }, schema);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return withDescription(
        { type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) },
        schema,
      );
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
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
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return withDescription(
        { type: "object", additionalProperties: zodToJsonSchema(def.valueType as z.ZodTypeAny) },
        schema,
      );
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options as z.ZodTypeAny[];
      return withDescription({ anyOf: options.map((option) => zodToJsonSchema(option)) }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny);
      return withDescription({ anyOf: [inner, { type: "null" }] }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny);
      const defaultValue = (def.defaultValue as () => unknown)();
      return withDescription({ ...inner, default: defaultValue }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return withDescription({}, schema);
    default:
      // Permissive fallback for anything exotic — zod still validates on call.
      return {};
  }
}

/** Convert a tool's zod object schema into an MCP inputSchema. */
export function toolInputSchema(schema: z.AnyZodObject): JsonSchema {
  const converted = zodToJsonSchema(schema);
  return { type: "object", properties: {}, ...converted };
}
