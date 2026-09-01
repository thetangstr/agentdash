import { describe, expect, it } from "vitest";
import { agentCompanyBrandingSchema, updateCompanyBrandingSchema } from "./company.js";

/**
 * The route refuses an agent's rename explicitly, before parsing, so it can
 * answer with a sentence rather than "Validation error". This schema is the
 * belt to that braces — and untested redundancy is the kind that quietly stops
 * being redundant.
 *
 * Removing the route guard alone does not fail any route test, precisely
 * because this schema still refuses. These assertions are what make that true
 * rather than assumed.
 */
describe("agentCompanyBrandingSchema", () => {
  it("accepts the colour and the logo", () => {
    expect(agentCompanyBrandingSchema.safeParse({ brandColor: "#123456" }).success).toBe(true);
    expect(
      agentCompanyBrandingSchema.safeParse({ logoAssetId: "11111111-1111-4111-8111-111111111111" }).success,
    ).toBe(true);
  });

  it("refuses the company name", () => {
    expect(agentCompanyBrandingSchema.safeParse({ name: "RENAMED BY CEO AGENT" }).success).toBe(false);
  });

  it("refuses the description", () => {
    expect(agentCompanyBrandingSchema.safeParse({ description: "rewritten" }).success).toBe(false);
  });

  it("refuses a rename smuggled in beside a permitted field", () => {
    // `.strict()` is what makes this fail. Without it the unknown key is
    // stripped silently and the caller believes the rename was accepted —
    // or worse, a later `svc.update(req.body)` applies it anyway.
    expect(
      agentCompanyBrandingSchema.safeParse({ brandColor: "#123456", name: "RENAMED" }).success,
    ).toBe(false);
  });

  it("still requires at least one field", () => {
    expect(agentCompanyBrandingSchema.safeParse({}).success).toBe(false);
  });

  it("is strictly narrower than the human schema", () => {
    // States the relationship the route depends on. If someone widens the
    // agent schema to match, this says so.
    const rename = { name: "MKThink" };
    expect(updateCompanyBrandingSchema.safeParse(rename).success, "a human may rename").toBe(true);
    expect(agentCompanyBrandingSchema.safeParse(rename).success, "an agent may not").toBe(false);
  });
});
