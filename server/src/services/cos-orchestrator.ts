// AgentDash: Chief of Staff (CoS) orchestrator (AGE-48 Phase 1).
//
// Triggered by `goalService.create()` when a goal is created via the UI
// (unless the caller passes `skipAutoPropose`). Derives a default
// interview payload from the goal's title/description/level, generates a
// CoS plan via `agentPlansService.generatePlan()`, persists it as a
// `proposed` plan via `agentPlansService.create()`, and writes an
// `activityLog` entry (`plan.proposed`) so the Goal Hub can surface it.
//
// Design notes
// ------------
// - Inline-await from the route: the goal must be created first, then we
//   best-effort propose a plan. If plan generation or persistence fails we
//   SWALLOW the error (after logging) so the goal creation itself never
//   fails. The orchestrator is additive and must not become a new failure
//   domain for the `POST /goals` endpoint.
// - We prefer reading `companyId` + `goalId` + the goal row directly so
//   this service can be called from any caller (route, assistant tool,
//   integration test) without coupling to Express internals.
// - No new DB columns are introduced; the proposal lives on the existing
//   `agent_plans` row with `status = 'proposed'`.

import type { Db } from "@agentdash/db";
import type {
  AgentTeamPlanPayload,
  GoalInterviewPayload,
} from "@agentdash/shared";
import { logger } from "../middleware/logger.js";
import { agentPlansService } from "./agent-plans.js";
import { goalService } from "./goals.js";
import { logActivity } from "./activity-log.js";

export interface ProposeForGoalOptions {
  // Optional explicit interview payload (e.g., surfaced by a CoS chat
  // session). When omitted, we derive a minimal payload from the goal
  // itself.
  interview?: GoalInterviewPayload;
  // Optional actor to attribute the plan's creation to. Most callers are
  // system-triggered (auto-propose on goal.created), in which case
  // `actorId` defaults to `"system"`.
  actor?: { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null };
}

export interface ProposeForGoalResult {
  ok: boolean;
  planId?: string;
  reason?: string;
}

// AgentDash: derive a minimal interview payload from an existing goal row.
// The dynamic plan generator can operate from a partial interview — title +
// description + level is enough for archetype detection and rationale
// composition.
export function defaultInterviewPayload(goal: {
  title: string;
  description?: string | null;
  level?: string | null;
}): GoalInterviewPayload {
  const statement = goal.description?.trim()
    ? `${goal.title}: ${goal.description.trim()}`
    : goal.title;
  return {
    goalStatement: statement,
    constraints: [],
    channels: [],
    blockers: [],
  };
}

export function cosOrchestratorService(db: Db) {
  const plansSvc = agentPlansService(db);
  const goalsSvc = goalService(db);

  return {
    defaultInterviewPayload,

    // AgentDash (AGE-48 Phase 1): generate a CoS plan proposal for a goal
    // and persist it. Safe to call multiple times — duplicate proposals are
    // allowed (the hub picks the most recent `proposed` row). Errors are
    // logged and returned as `{ ok: false }` so callers can keep going.
    proposeForGoal: async (
      companyId: string,
      goalId: string,
      options: ProposeForGoalOptions = {},
    ): Promise<ProposeForGoalResult> => {
      try {
        const goal = await goalsSvc.getById(goalId);
        if (!goal || goal.companyId !== companyId) {
          return { ok: false, reason: "goal_not_found" };
        }
        const interview = options.interview ?? defaultInterviewPayload(goal);
        const generated = await plansSvc.generatePlan(companyId, goalId, interview);
        if ("error" in generated) {
          logger.warn(
            { companyId, goalId, error: generated.error },
            "cos-orchestrator: plan generation returned an error",
          );
          return { ok: false, reason: generated.error };
        }

        const payload: AgentTeamPlanPayload = generated.plan;
        const actor = options.actor ?? {
          actorType: "system" as const,
          actorId: "system",
          agentId: null,
        };
        const plan = await plansSvc.create(
          companyId,
          {
            goalId,
            archetype: generated.archetype as AgentTeamPlanPayload["archetype"],
            rationale: payload.rationale,
            payload,
          },
          {
            userId: actor.actorType === "user" ? actor.actorId : undefined,
            agentId: actor.agentId ?? undefined,
          },
        );

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          action: "plan.proposed",
          entityType: "goal",
          entityId: goalId,
          details: { planId: plan.id, archetype: plan.archetype },
        });

        return { ok: true, planId: plan.id };
      } catch (error) {
        logger.warn(
          { err: error, companyId, goalId },
          "cos-orchestrator: proposeForGoal failed, swallowing to keep goal creation path green",
        );
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "unknown_error",
        };
      }
    },
  };
}
