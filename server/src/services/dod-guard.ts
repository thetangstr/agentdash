// AgentDash: goals-eval-hitl
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues, projects } from "@paperclipai/db";
import {
  FEATURE_FLAG_KEYS,
  definitionOfDoneSchema,
  goalMetricDefinitionSchema,
} from "@paperclipai/shared";
import { unprocessable, notFound } from "../errors.js";
import type { FeatureFlagsService } from "./feature-flags.js";

export type DodGuardEntityType = "goal" | "project" | "issue";

/**
 * DoD / metric-definition guard. Caller-only helper that enforces the
 * "definition of done required at status transition" invariant defined in
 * the goals-eval-hitl plan. Per-tenant: no-op when the company hasn't
 * opted into `dod_guard_enabled`.
 *
 * NOT wired into existing transition paths in Phase C1; Phase D routes
 * (and the Phase C2 orchestrator) call this before mutating status.
 *
 * Throws `unprocessable` with `code: 'DOD_REQUIRED'` when missing/invalid.
 */
export function dodGuardService(db: Db, featureFlags: FeatureFlagsService) {
  async function assertDoDOrThrow(
    companyId: string,
    entityType: DodGuardEntityType,
    entityId: string,
    nextStatus: string,
    currentStatus?: string,
  ): Promise<void> {
    // Per-tenant gating: short-circuit when the flag is off for this company.
    const enabled = await featureFlags.isEnabled(companyId, FEATURE_FLAG_KEYS.DOD_GUARD);
    if (!enabled) return;

    // Only enforce on transition OUT of `backlog`. Skip if this is a no-op
    // transition or the entity is moving INTO backlog.
    const fromBacklog = currentStatus === "backlog";
    const toBacklog = nextStatus === "backlog";
    if (toBacklog) return;
    if (currentStatus !== undefined && !fromBacklog) return;

    if (entityType === "goal") {
      const row = await db
        .select({
          id: goals.id,
          companyId: goals.companyId,
          status: goals.status,
          metricDefinition: goals.metricDefinition,
        })
        .from(goals)
        .where(eq(goals.id, entityId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Goal not found");
      if (row.companyId !== companyId) {
        throw unprocessable("Goal does not belong to the requested company");
      }
      // If currentStatus wasn't supplied, fall back to the row's current
      // status — only enforce when the row is leaving backlog.
      if (currentStatus === undefined && row.status !== "backlog") return;

      const parsed = goalMetricDefinitionSchema.safeParse(row.metricDefinition);
      if (!parsed.success) {
        throw unprocessable("Goal metricDefinition required to leave backlog", {
          code: "DOD_REQUIRED",
          entityType,
          entityId,
          field: "metricDefinition",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      return;
    }

    if (entityType === "project") {
      const row = await db
        .select({
          id: projects.id,
          companyId: projects.companyId,
          status: projects.status,
          definitionOfDone: projects.definitionOfDone,
        })
        .from(projects)
        .where(eq(projects.id, entityId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Project not found");
      if (row.companyId !== companyId) {
        throw unprocessable("Project does not belong to the requested company");
      }
      if (currentStatus === undefined && row.status !== "backlog") return;

      const parsed = definitionOfDoneSchema.safeParse(row.definitionOfDone);
      if (!parsed.success) {
        throw unprocessable("Project definitionOfDone required to leave backlog", {
          code: "DOD_REQUIRED",
          entityType,
          entityId,
          field: "definitionOfDone",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      return;
    }

    if (entityType === "issue") {
      const row = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          definitionOfDone: issues.definitionOfDone,
        })
        .from(issues)
        .where(eq(issues.id, entityId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Issue not found");
      if (row.companyId !== companyId) {
        throw unprocessable("Issue does not belong to the requested company");
      }
      if (currentStatus === undefined && row.status !== "backlog") return;

      const parsed = definitionOfDoneSchema.safeParse(row.definitionOfDone);
      if (!parsed.success) {
        throw unprocessable("Issue definitionOfDone required to leave backlog", {
          code: "DOD_REQUIRED",
          entityType,
          entityId,
          field: "definitionOfDone",
          issues: parsed.success ? [] : parsed.error.issues,
        });
      }
      return;
    }
  }

  return { assertDoDOrThrow };
}

export type DodGuardService = ReturnType<typeof dodGuardService>;
