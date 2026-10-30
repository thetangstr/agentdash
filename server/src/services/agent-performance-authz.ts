import type { Request } from "express";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { isCompanyAdministrator } from "../routes/authz.js";
import {
  approvalVisibilityCondition,
  projectScopedVisibilityCondition,
  projectVisibilityCondition,
  runVisibilityCondition,
  seesEverything,
} from "../routes/visibility.js";
import { accessService } from "./access.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { agentStewardshipService } from "./agent-stewardships.js";

/**
 * AgentDash: Agent Performance Management gate 1 — who may read an agent's
 * access inventory and performance projection, and which restricted-project
 * work the reader may see inside them. One definition, used by
 * `routes/agent-access.ts` and `routes/agent-performance.ts`, so the two
 * views cannot disagree about either question.
 */

export const AGENT_PERFORMANCE_FORBIDDEN_MESSAGE =
  "Only the agent's accountable person, its steward and company admins can see this.";

/** The read-only evaluator principal. It reads neither view in gate 1. */
export function isEvaluatorPrincipal(req: Request): boolean {
  return req.actor.type === "agent" && (req.actor.readOnly === true || req.actor.principalKind === "evaluator");
}

/**
 * A board principal who is a company owner/admin or an instance admin
 * (`isCompanyAdministrator`, which also admits the local board), the human who
 * answers for the agent (`agentAccountabilityService.resolveForAgent`: the
 * assigned accountable person of an autonomous agent, the steward of a
 * stewarded one), or the agent's active steward. Agents, including the
 * evaluator principal, are never admitted. Callers check company access, agent
 * visibility and that the agent is in this company first (404 before 403).
 */
export async function canReadAgentPerformance(
  db: Db,
  req: Request,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  if (req.actor.type !== "board") return false;
  if (await isCompanyAdministrator(accessService(db), req, companyId)) return true;
  const userId = req.actor.userId;
  if (!userId) return false;
  const [steward, accountable] = await Promise.all([
    agentStewardshipService(db).activeByAgent(companyId, agentId),
    agentAccountabilityService(db).resolveForAgent(companyId, agentId),
  ]);
  return steward?.userId === userId || accountable?.userId === userId;
}

/** 403 unless `canReadAgentPerformance`. Thrown, not logged: these routes write nothing. */
export async function assertAgentPerformanceReader(
  db: Db,
  req: Request,
  companyId: string,
  agentId: string,
): Promise<void> {
  if (await canReadAgentPerformance(db, req, companyId, agentId)) return;
  throw forbidden(AGENT_PERFORMANCE_FORBIDDEN_MESSAGE);
}

/**
 * The restricted-project rule (A5, `routes/visibility.ts`) for the VIEWER, as
 * SQL conditions a loader composes into its queries. Someone who answers for an
 * agent may still be off a restricted project's access list; work tied to such
 * a project is left out before anything is counted, and its title and id never
 * appear. `restricted` is true whenever the rule can hide something for this
 * viewer — not only when it did — so saying so leaks nothing.
 */
export interface ViewerProjectScope {
  restricted: boolean;
  /** Over `projects`. */
  projects: SQL | undefined;
  /** For any nullable project-id expression: null project, open project, or one the viewer is listed on. */
  projectScoped: (projectId: SQL | { getSQL(): SQL }) => SQL | undefined;
  /** Over `heartbeat_runs`, through the run's issue. */
  runs: SQL | undefined;
  /** Over `approvals` (project-scoped budget overrides). */
  approvals: SQL | undefined;
}

export const UNRESTRICTED_PROJECT_SCOPE: ViewerProjectScope = {
  restricted: false,
  projects: undefined,
  projectScoped: () => undefined,
  runs: undefined,
  approvals: undefined,
};

export function viewerProjectScope(req: Request, companyId: string): ViewerProjectScope {
  if (seesEverything(req, companyId)) return UNRESTRICTED_PROJECT_SCOPE;
  return {
    restricted: true,
    projects: projectVisibilityCondition(req, companyId),
    projectScoped: (projectId) => projectScopedVisibilityCondition(req, companyId, projectId),
    runs: runVisibilityCondition(req, companyId),
    approvals: approvalVisibilityCondition(req, companyId),
  };
}
