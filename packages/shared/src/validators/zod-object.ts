import { z } from "zod";

// zod 3 → zod 4 object semantics this repo relies on, kept in one place.

/**
 * The object schema without its refinements — what zod 3's
 * `refined.innerType()` returned. zod 4 keeps `.refine()` / `.superRefine()`
 * as checks on the object itself, so a refined object has no `innerType()`,
 * and `.extend()` over its keys, `.omit()`, `.pick()` and `.partial()` refuse it.
 */
export function withoutRefinements<T extends z.ZodObject>(schema: T): T {
  return schema.clone({ ...schema._zod.def, checks: [] }) as T;
}

// A wrapper's own metadata (e.g. a `.describe()` applied after `.default()`)
// moves onto whatever replaces it.
function keepMeta(from: z.ZodType, to: z.ZodType): z.ZodType {
  const meta = z.globalRegistry.get(from);
  return meta ? to.meta(meta) : to;
}

function withoutDefault(schema: z.ZodType): z.ZodType {
  const def = schema._zod.def as z.core.$ZodTypeDef & { innerType?: z.ZodType; checks?: unknown[] };
  if (def.type === "default" || def.type === "prefault") return keepMeta(schema, withoutDefault(def.innerType!));
  if (def.type === "optional" || def.type === "nullable") {
    const inner = withoutDefault(def.innerType!);
    if (inner === def.innerType) return schema;
    if (def.checks?.length) throw new Error("partialWithoutDefaults: a refined optional/nullable wrapper cannot be rebuilt");
    return keepMeta(schema, def.type === "optional" ? inner.optional() : inner.nullable());
  }
  return schema;
}

/**
 * zod 3's `.partial()`: every key optional, and a key the caller omits stays
 * omitted.
 *
 * zod 4's `.partial()` keeps an inner `.default()` live —
 * `z.object({ a: x.default(v) }).partial().parse({})` is `{ a: v }` — so an
 * update schema derived from a create schema would write the create-time
 * defaults over every field a PATCH did not send. This strips those defaults
 * (through optional/nullable wrappers) before making each key optional, and
 * fails at module load if a default is nested somewhere it cannot reach.
 */
export function partialWithoutDefaults<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
) {
  const partial = schema.partial();
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(partial.shape as Record<string, z.ZodOptional>)) {
    // "defaulted" is zod 4's mark for "fills a value in for an absent key".
    if (field._zod.optin !== "defaulted") continue;
    const optional = withoutDefault(field.unwrap() as z.ZodType).optional();
    if (optional._zod.optin === "defaulted") {
      throw new Error(`partialWithoutDefaults: cannot strip the default from "${key}"`);
    }
    shape[key] = optional;
  }
  if (Object.keys(shape).length === 0) return partial;
  return partial.extend(shape) as unknown as typeof partial;
}
