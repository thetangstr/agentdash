// AgentDash: billing-trio (#151) — caller-only helper that assembles the
// `Deps` shape required by `requireTierFor`. Lives next to the middleware
// rather than inside it so the middleware itself stays untouched.
import { agents, companyMemberships, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { companyService } from "../services/companies.js";

export function buildRequireTierDeps(db: Db) {
  const companies = companyService(db);
  return {
    getCompany: async (id: string) => {
      const company = await companies.getById(id);
      return { planTier: company?.planTier ?? "free" };
    },
    counts: {
      humans: async (companyId: string) => {
        const row = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return row?.count ?? 0;
      },
      agents: async (companyId: string) => {
        const row = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, companyId),
              ne(agents.status, "terminated"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return row?.count ?? 0;
      },
    },
  };
}
