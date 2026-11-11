import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

const fred = (schema as unknown as Record<string, Parameters<typeof getTableConfig>[0]>).fredRegistrations;
describe("Fred protected registration schema", () => {
  it("exports one authoritative registration table", () => {
    expect(fred).toBeDefined();
    expect(getTableConfig(fred).name).toBe("fred_registrations");
  });
  it("keeps partially materialized identities nullable without dropping the company owner", () => {
    const columns = new Map(getTableConfig(fred).columns.map(column => [column.name, column]));
    expect(columns.get("agent_id")?.notNull).toBe(false);
    expect(columns.get("main_issue_id")?.notNull).toBe(false);
    expect(columns.get("owner_user_id")?.notNull).toBe(true);
    expect(columns.get("company_id")?.notNull).toBe(true);
    expect(columns.get("brief_revision")?.default).toBe(0);
    expect(columns.get("brief_document_revision_id")?.notNull).toBe(false);
  });
  it("pins unique company, agent and main issue plus bounded state/revision constraints", () => {
    const config = getTableConfig(fred);
    expect(config.indexes.filter(index => index.config.unique).map(index => index.config.name)).toEqual(expect.arrayContaining([
      "fred_registrations_company_unique", "fred_registrations_agent_unique", "fred_registrations_issue_unique",
    ]));
    expect(config.checks.map(check => check.name)).toEqual(expect.arrayContaining(["fred_registrations_state_check", "fred_registrations_brief_revision_check"]));
    expect(config.foreignKeys).toHaveLength(4);
  });
});
