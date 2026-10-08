import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolInputSchema, zodToJsonSchema } from "./schema.js";

describe("zodToJsonSchema", () => {
  it("converts primitive types", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("converts int-checked numbers to integer", () => {
    expect(zodToJsonSchema(z.number().int())).toEqual({ type: "integer" });
    expect(zodToJsonSchema(z.number().int().positive().max(500))).toEqual({
      type: "integer", exclusiveMinimum: 0, maximum: 500,
    });
  });

  it.each([
    ["inclusive", z.number().min(-2.5).max(7.25), { minimum: -2.5, maximum: 7.25 }],
    ["exclusive", z.number().gt(-2.5).lt(7.25), { exclusiveMinimum: -2.5, exclusiveMaximum: 7.25 }],
    ["positive", z.number().positive(), { exclusiveMinimum: 0 }],
    ["negative", z.number().negative(), { exclusiveMaximum: 0 }],
    ["nonnegative", z.number().nonnegative(), { minimum: 0 }],
    ["nonpositive", z.number().nonpositive(), { maximum: 0 }],
    ["strongest repeated", z.number().min(4).min(1).max(9).max(12), { minimum: 4, maximum: 9 }],
    ["mixed repeated", z.number().gt(4).min(5).lt(9).max(8), { minimum: 5, maximum: 8 }],
    ["equal exclusive first", z.number().gt(4).min(4).lt(9).max(9), { exclusiveMinimum: 4, exclusiveMaximum: 9 }],
    ["equal exclusive last", z.number().min(4).gt(4).max(9).lt(9), { exclusiveMinimum: 4, exclusiveMaximum: 9 }],
  ])("advertises %s numeric bounds", (_name, schema, bounds) => {
    expect(zodToJsonSchema(schema)).toEqual({ type: "number", ...bounds });
  });

  it("preserves inner descriptions unless an outer optional description replaces them", () => {
    expect(zodToJsonSchema(z.string().describe("Inner").optional())).toEqual({
      type: "string", description: "Inner",
    });
    expect(zodToJsonSchema(z.string().describe("Inner").optional().describe("Outer"))).toEqual({
      type: "string", description: "Outer",
    });
    expect(zodToJsonSchema(z.string().describe("Inner").optional().describe(""))).toEqual({
      type: "string", description: "Inner",
    });
  });

  it("preserves wrapper descriptions through nested optional, nullable and default schemas", () => {
    expect(zodToJsonSchema(z.number().min(1).max(5).nullable().describe("Nullable").optional().describe("Optional").default(3).describe("Default"))).toEqual({
      anyOf: [{ type: "number", minimum: 1, maximum: 5 }, { type: "null" }],
      description: "Default", default: 3,
    });
  });

  it("converts enums", () => {
    expect(zodToJsonSchema(z.enum(["asc", "desc"]))).toEqual({
      type: "string",
      enum: ["asc", "desc"],
    });
  });

  it("converts literals to const", () => {
    expect(zodToJsonSchema(z.literal("markdown"))).toEqual({ const: "markdown" });
  });

  it("converts arrays with item schemas", () => {
    expect(zodToJsonSchema(z.array(z.string().uuid()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("converts records to additionalProperties objects", () => {
    expect(zodToJsonSchema(z.record(z.unknown()))).toEqual({
      type: "object",
      additionalProperties: {},
    });
  });

  it("converts unions to anyOf", () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("unwraps optional and drops the field from required", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        required: { type: "string" },
        optional: { type: "string" },
      },
      required: ["required"],
    });
  });

  it("represents nullable as anyOf with null", () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("treats optional+nullable fields as not required", () => {
    const schema = z.object({
      companyId: z.string().uuid().optional().nullable(),
    });
    const converted = zodToJsonSchema(schema);
    expect(converted.required).toBeUndefined();
    expect(converted.properties).toEqual({
      companyId: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
  });

  it("carries defaults through and keeps defaulted fields optional", () => {
    const schema = z.object({
      priority: z.enum(["high", "low"]).optional().default("low"),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        priority: { type: "string", enum: ["high", "low"], default: "low" },
      },
    });
  });

  it("unwraps effects (refine) to the inner schema", () => {
    const schema = z.object({ a: z.string() }).refine(() => true);
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("includes descriptions when present", () => {
    expect(zodToJsonSchema(z.string().describe("A name"))).toEqual({
      type: "string",
      description: "A name",
    });
  });

  it("falls back to a permissive schema for exotic types", () => {
    expect(zodToJsonSchema(z.string().or(z.number()).transform(String).pipe(z.string()))).toEqual({});
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });

  it("handles nested objects", () => {
    const schema = z.object({
      payload: z.object({
        summary: z.string(),
        tags: z.array(z.string()).optional(),
      }),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: {
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["summary"],
        },
      },
      required: ["payload"],
    });
  });
});

describe("toolInputSchema", () => {
  it("always emits an object schema with a properties key", () => {
    expect(toolInputSchema(z.object({}))).toEqual({ type: "object", properties: {} });
  });

  it("wraps a populated object schema", () => {
    const result = toolInputSchema(z.object({ id: z.string() }));
    expect(result).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });
});
