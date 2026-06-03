// AgentDash (AGE-119 + AGE-123): agent-run metering + ledger service.
// Records exactly one agent-run per completed heartbeat run and provides
// monthly run count queries per workspace. The ledger methods (AGE-123)
// return enriched rows with agent name and issue title for the billing UX.

import { and, eq, gte, lt, desc, asc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuns, agents, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import {
  AGENT_RUN_COMPLEXITY_THRESHOLDS,
  type AgentRunComplexityTier,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Complexity classification
// ---------------------------------------------------------------------------

/**
 * Classify an agent run into a complexity tier based on total tokens consumed
 * and wall-clock duration. A run is "complex" if it exceeds EITHER the token
 * OR the duration threshold for complex; "medium" if it exceeds either medium
 * threshold; "simple" otherwise.
 */
export function classifyComplexity(
  tokenCount: number,
  durationMs: number | null | undefined,
): AgentRunComplexityTier {
  const dur = durationMs ?? 0;
  const { complex, medium } = AGENT_RUN_COMPLEXITY_THRESHOLDS;

  if (tokenCount >= complex.tokens || dur >= complex.durationMs) return "complex";
  if (tokenCount >= medium.tokens || dur >= medium.durationMs) return "medium";
  return "simple";
}

// ---------------------------------------------------------------------------
// UTC calendar-month window helper
// ---------------------------------------------------------------------------

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

// ---------------------------------------------------------------------------
// Ledger row type (AGE-123)
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  agentId: string;
  agentName: string;
  issueId: string | null;
  issueTitle: string | null;
  complexityTier: string;
  costCents: number;
  tokenCount: number;
  durationMs: number | null;
  completedAt: string; // ISO timestamp
}

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function agentRunService(db: Db) {
  return {
    /**
     * Record a single agent-run when a heartbeat run reaches a terminal state.
     * Idempotent: if the heartbeatRunId already has an agent_run row, the
     * insert is silently skipped (ON CONFLICT DO NOTHING).
     *
     * Aggregate token count and cost are pulled from cost_events linked to the
     * same heartbeat_run_id so the agent_runs row matches the financial ledger.
     */
    recordRun: async (input: {
      companyId: string;
      agentId: string;
      heartbeatRunId: string;
      issueId?: string | null;
      projectId?: string | null;
      startedAt?: Date | null;
      finishedAt: Date;
    }) => {
      // 1. Aggregate tokens + cost from cost_events for this run.
      const [agg] = await db
        .select({
          totalTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}), 0)::int`,
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, input.companyId),
            eq(costEvents.heartbeatRunId, input.heartbeatRunId),
          ),
        );

      const tokenCount = Number(agg?.totalTokens ?? 0);
      const totalCostCents = Number(agg?.totalCostCents ?? 0);

      // 2. Compute duration from startedAt → finishedAt.
      const durationMs =
        input.startedAt && input.finishedAt
          ? Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime())
          : null;

      // 3. Classify complexity.
      const complexityTier = classifyComplexity(tokenCount, durationMs);

      // 4. Insert idempotently.
      try {
        const [row] = await db
          .insert(agentRuns)
          .values({
            companyId: input.companyId,
            agentId: input.agentId,
            heartbeatRunId: input.heartbeatRunId,
            issueId: input.issueId ?? null,
            projectId: input.projectId ?? null,
            complexityTier,
            durationMs,
            tokenCount,
            costCents: totalCostCents,
            completedAt: input.finishedAt,
          })
          .onConflictDoNothing({ target: agentRuns.heartbeatRunId })
          .returning();

        return row ?? null;
      } catch (err) {
        // Best-effort — metering failures must not block the heartbeat
        // completion path. Log and continue.
        logger.error(
          { err, heartbeatRunId: input.heartbeatRunId },
          "[agent-runs] failed to record agent run",
        );
        return null;
      }
    },

    /**
     * Monthly run count for a workspace (company) in the current UTC calendar
     * month. Optionally filter by agentId.
     */
    monthlyCount: async (
      companyId: string,
      options?: { agentId?: string; now?: Date },
    ) => {
      const { start, end } = currentUtcMonthWindow(options?.now);
      const conditions = [
        eq(agentRuns.companyId, companyId),
        gte(agentRuns.completedAt, start),
        lt(agentRuns.completedAt, end),
      ];
      if (options?.agentId) {
        conditions.push(eq(agentRuns.agentId, options.agentId));
      }

      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          simple: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'simple')::int`,
          medium: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'medium')::int`,
          complex: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'complex')::int`,
        })
        .from(agentRuns)
        .where(and(...conditions));

      return {
        companyId,
        month: currentUtcMonthWindow(options?.now).start.toISOString(),
        total: Number(row?.total ?? 0),
        simple: Number(row?.simple ?? 0),
        medium: Number(row?.medium ?? 0),
        complex: Number(row?.complex ?? 0),
      };
    },

    /**
     * Monthly run count per agent within a workspace. Used by the ledger UX
     * (AGE-123) to show per-agent breakdowns.
     */
    monthlyCountByAgent: async (companyId: string, options?: { now?: Date }) => {
      const { start, end } = currentUtcMonthWindow(options?.now);
      return db
        .select({
          agentId: agentRuns.agentId,
          total: sql<number>`count(*)::int`,
          simple: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'simple')::int`,
          medium: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'medium')::int`,
          complex: sql<number>`count(*) filter (where ${agentRuns.complexityTier} = 'complex')::int`,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.companyId, companyId),
            gte(agentRuns.completedAt, start),
            lt(agentRuns.completedAt, end),
          ),
        )
        .groupBy(agentRuns.agentId);
    },

    // -----------------------------------------------------------------------
    // AGE-123: Ledger query — enriched list with agent names + issue titles.
    // -----------------------------------------------------------------------

    /**
     * Paginated ledger of agent runs for a workspace, enriched with agent
     * name and issue title. Supports date-range filtering and sort direction.
     */
    ledger: async (
      companyId: string,
      options?: {
        from?: Date;
        to?: Date;
        limit?: number;
        offset?: number;
        sort?: "asc" | "desc";
      },
    ): Promise<LedgerPage> => {
      const limit = Math.min(options?.limit ?? 50, 500);
      const offset = options?.offset ?? 0;
      const sortDir = options?.sort === "asc" ? asc : desc;

      const conditions = [eq(agentRuns.companyId, companyId)];
      if (options?.from) conditions.push(gte(agentRuns.completedAt, options.from));
      if (options?.to) conditions.push(lt(agentRuns.completedAt, options.to));

      const whereClause = and(...conditions);

      // Count total matching rows for pagination metadata.
      const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(agentRuns)
        .where(whereClause);
      const total = Number(countRow?.total ?? 0);

      // Fetch enriched rows with agent name + issue title.
      const rows = await db
        .select({
          id: agentRuns.id,
          agentId: agentRuns.agentId,
          agentName: agents.name,
          issueId: agentRuns.issueId,
          issueTitle: issues.title,
          complexityTier: agentRuns.complexityTier,
          costCents: agentRuns.costCents,
          tokenCount: agentRuns.tokenCount,
          durationMs: agentRuns.durationMs,
          completedAt: agentRuns.completedAt,
        })
        .from(agentRuns)
        .leftJoin(agents, eq(agentRuns.agentId, agents.id))
        .leftJoin(issues, eq(agentRuns.issueId, issues.id))
        .where(whereClause)
        .orderBy(sortDir(agentRuns.completedAt))
        .limit(limit)
        .offset(offset);

      return {
        rows: rows.map((r) => ({
          id: r.id,
          agentId: r.agentId,
          agentName: r.agentName ?? "Unknown agent",
          issueId: r.issueId,
          issueTitle: r.issueTitle ?? null,
          complexityTier: r.complexityTier,
          costCents: Number(r.costCents),
          tokenCount: Number(r.tokenCount),
          durationMs: r.durationMs != null ? Number(r.durationMs) : null,
          completedAt:
            r.completedAt instanceof Date
              ? r.completedAt.toISOString()
              : String(r.completedAt),
        })),
        total,
        hasMore: offset + limit < total,
      };
    },
  };
}
