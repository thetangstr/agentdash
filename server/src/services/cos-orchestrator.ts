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
  // AgentDash (AGE-50 Phase 4b): set when the orchestrator intentionally
  // skipped auto-propose (e.g., company-level goals that require a Socratic
  // interview instead of a canned plan).
  skipped?: boolean;
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

// AgentDash (AGE-50 Phase 5): ambiguity gate. A goal's description is
// "substantive" enough to skip the Socratic deep-interview when it
// contains both enough characters AND enough distinct words for the plan
// generator to have real signal to work with. Thresholds are empirical —
// if operators report canned plans despite substantive descriptions, tune
// up. If they complain about being forced into interviews they don't need,
// tune down.
const SUBSTANTIVE_DESC_MIN_CHARS = 200;
const SUBSTANTIVE_DESC_MIN_WORDS = 30;

export function isDescriptionSubstantive(description: string | null | undefined): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  if (trimmed.length < SUBSTANTIVE_DESC_MIN_CHARS) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= SUBSTANTIVE_DESC_MIN_WORDS;
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

        // AgentDash (AGE-50 Phase 4b + Phase 5): company-level goals
        // normally require a Socratic deep-interview before a plan is
        // written — but if the operator already supplied a rich,
        // specific description, skip the interview and auto-propose
        // directly (AGE-50 Phase 5 ambiguity gate). The rationale: making
        // an operator re-answer questions they already answered in the
        // description is a conversion killer.
        //
        // Callers can still force auto-propose by passing an explicit
        // `options.interview`.
        if (goal.level === "company" && !options.interview) {
          const descSubstantive = isDescriptionSubstantive(goal.description);
          if (!descSubstantive) {
            logger.info(
              { companyId, goalId },
              "cos-orchestrator: skipping auto-propose for company-level goal (awaiting deep-interview)",
            );
            return {
              ok: true,
              skipped: true,
              reason: "company_goal_awaiting_interview",
            };
          }
          logger.info(
            { companyId, goalId, descriptionChars: goal.description?.length ?? 0 },
            "cos-orchestrator: description is substantive — auto-proposing directly (Phase 5 ambiguity gate)",
          );
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
