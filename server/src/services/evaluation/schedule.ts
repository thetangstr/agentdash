import type { Db } from "@paperclipai/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { agents, companyMemberships, projects } from "@paperclipai/db";
import { EVALUATION_REVIEW_PROJECT_NAME, EVALUATOR_AGENT_ROLE } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { evaluationReviewItems } from "./review-items.js";
import { evaluationScorecardService } from "./scorecards.js";
import type { ScoredCard } from "./scoring/types.js";

/**
 * AgentDash: Company Evaluator — the shadow-mode cadence (spec §9.2, §11).
 *
 * On its own interval (off by default), store a card for every open project
 * of every company that has provisioned an evaluator principal — never for a
 * company that has not opted in — and bring its review items up to date.
 * Deterministic, no model call; the evaluator agent is not involved. Goals are
 * not snapshotted by the cadence (an administrator can). Exceptions with no
 * accountable owner route to the company's first active administrator; with
 * no administrator they are recorded as unrouted, never sent to an arbitrary
 * member. A company or milestone that fails is logged and skipped; the loop
 * never stops.
 */
export interface SnapshotCadenceOptions {
  /** Also sync review items (default true). */
  reviewItems?: boolean;
}

export interface SnapshotCadenceResult {
  companies: number;
  milestones: number;
  cards: number;
  reviewItemsCreated: number;
  reviewItemsUpdated: number;
  failures: Array<{ companyId: string; milestoneId: string | null; error: string }>;
}

export function evaluationSnapshotCadence(db: Db, opts: SnapshotCadenceOptions = {}) {
  const cards = evaluationScorecardService(db);
  const reviewItems = evaluationReviewItems(db);

  async function firstAdministrator(companyId: string): Promise<string | null> {
    const rows = await db
      .select({ principalId: companyMemberships.principalId, role: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
    const admins = rows.filter((r) => r.role === "admin" || r.role === "owner").map((r) => r.principalId).sort();
    return admins[0] ?? null;
  }

  /** Companies that opted in by provisioning an evaluator principal (an evaluator-role agent that is not terminated). */
  async function provisionedCompanies(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ id: agents.companyId })
      .from(agents)
      .where(and(eq(agents.role, EVALUATOR_AGENT_ROLE), ne(agents.status, "terminated")));
    return rows.map((r) => r.id).sort();
  }

  return {
    /** One pass over the open projects of every provisioned company. */
    async run(): Promise<SnapshotCadenceResult> {
      const result: SnapshotCadenceResult = { companies: 0, milestones: 0, cards: 0, reviewItemsCreated: 0, reviewItemsUpdated: 0, failures: [] };
      for (const companyId of await provisionedCompanies()) {
        result.companies++;
        let open: Array<{ id: string }> = [];
        let fallback: string | null = null;
        try {
          // rule 12: the evaluator's own review-items project is never a scored milestone
          open = await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.companyId, companyId), inArray(projects.status, ["in_progress", "planned"]), ne(projects.name, EVALUATION_REVIEW_PROJECT_NAME)));
          fallback = opts.reviewItems === false ? null : await firstAdministrator(companyId);
        } catch (err) {
          result.failures.push({ companyId, milestoneId: null, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        for (const { id: milestoneId } of open) {
          result.milestones++;
          const ref = { kind: "project" as const, id: milestoneId };
          try {
            const stored = await cards.snapshot(companyId, ref);
            result.cards++;
            if (opts.reviewItems !== false) {
              const synced = await reviewItems.sync(companyId, ref, stored.card as ScoredCard, stored.version, fallback);
              result.reviewItemsCreated += synced.created.length;
              result.reviewItemsUpdated += synced.updated.length;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // a company mid-ingest holds its lock: skip this pass, the next one catches up
            result.failures.push({ companyId, milestoneId, error: message });
            logger.warn({ companyId, milestoneId, err: message }, "evaluation_snapshot: milestone skipped");
          }
        }
      }
      return result;
    },
  };
}
