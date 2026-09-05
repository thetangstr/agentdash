import {
  EVALUATION_CONTRACT_VERSION,
  EVALUATION_DEFAULT_REQUIRED_EVIDENCE,
  evaluationContractV1Schema,
  type EvaluationContractV1,
  type EvaluationEvidenceClass,
  type EvaluationMilestoneRef,
} from "@paperclipai/shared";
import { INDEPENDENCE_RULE } from "./independence.js";
import { createdAt, latestGoal, latestProject, obj, str, type ItemTimeline, type Timeline } from "./timeline.js";
import type { ContractSummary } from "./types.js";

/**
 * AgentDash: Company Evaluator — the milestone contract (spec §4).
 *
 * A declared contract is the latest `contract.declared` event for the
 * milestone inside the window. Without one the evaluator derives a contract
 * from the roster facts it has, marked `source: "derived"`: it always uses the
 * engineering-default evidence set (rule 16 — only a human may drop a class)
 * and declares no acceptance criteria, because criterion text lives outside the
 * ledger; O1 is then Insufficient and the card says so, which is the intended
 * measurement of the gap (§5.1).
 */
export interface ResolvedContract {
  contract: EvaluationContractV1;
  source: "declared" | "derived";
  eventId: string | null;
  declaredAt: Date | null;
  declaredBy: string | null;
  summary: ContractSummary;
}

export function resolveContract(tl: Timeline, ref: EvaluationMilestoneRef, members: ItemTimeline[], companyId: string): ResolvedContract {
  let declared: { contract: EvaluationContractV1; eventId: string; at: Date; by: string | null } | null = null;
  for (const e of tl.contracts) {
    const raw = obj((e.payload ?? {}) as Record<string, unknown>, "contract") ?? (e.payload as Record<string, unknown>);
    const parsed = evaluationContractV1Schema.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.milestoneRef.kind !== ref.kind || parsed.data.milestoneRef.id !== ref.id) continue;
    declared = { contract: parsed.data, eventId: e.id, at: e.eventTime, by: e.actorId };
  }
  if (declared) {
    const c = declared.contract;
    return {
      contract: c,
      source: "declared",
      eventId: declared.eventId,
      declaredAt: declared.at,
      declaredBy: declared.by,
      summary: summarise(c, "declared", declared.eventId, declared.at, declared.by),
    };
  }
  const project = ref.kind === "project" ? latestProject(tl, ref.id) : null;
  const goalId = ref.kind === "goal" ? ref.id : (project?.goalId ?? null);
  const goal = goalId ? latestGoal(tl, goalId) : null;
  const leadAgentId = ref.kind === "project" ? (project?.leadAgentId ?? null) : (goal?.ownerAgentId ?? null);
  const accountable = leadAgentId ? (tl.agents.get(leadAgentId)?.accountableUserId ?? null) : null;
  const memberStarts = members.map((m) => createdAt(m)?.getTime()).filter((x): x is number => typeof x === "number");
  const windowStart = memberStarts.length > 0 ? new Date(Math.min(...memberStarts.slice(0, 10_000))) : (project?.createdAt ?? new Date(0));
  const closed = project && (project.status === "completed" || project.status === "cancelled") ? project.time : goal && (goal.status === "achieved" || goal.status === "cancelled") ? goal.time : null;
  const md = goal?.metricDefinition ?? null;
  const target = md ? Number(md.target) : NaN;
  const contract: EvaluationContractV1 = {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    companyId,
    goalId,
    parentGoalId: goal?.parentId ?? null,
    milestoneRef: ref,
    accountableUserId: accountable,
    leadAgentId,
    acceptanceCriteria: [],
    definitionOfDone: null,
    requiredEvidence: [...EVALUATION_DEFAULT_REQUIRED_EVIDENCE],
    independenceRule: INDEPENDENCE_RULE,
    excludedReviewers: [],
    founderLocks: [],
    outcomeTarget:
      md && Number.isFinite(target) && typeof md.unit === "string"
        ? { metricKey: "goal.metricDefinition", target, unit: md.unit, source: typeof md.source === "string" ? md.source : "goal.metricDefinition" }
        : null,
    targetDate: project?.targetDate ?? null,
    downstreamRiskAcceptance: null,
    windowStart: windowStart.toISOString(),
    windowEnd: closed ? closed.toISOString() : null,
    source: "derived",
  };
  return { contract, source: "derived", eventId: null, declaredAt: null, declaredBy: null, summary: summarise(contract, "derived", null, null, null) };
}

function summarise(c: EvaluationContractV1, source: "declared" | "derived", eventId: string | null, at: Date | null, by: string | null): ContractSummary {
  const exceptions: string[] = [];
  const missing = EVALUATION_DEFAULT_REQUIRED_EVIDENCE.filter((cls) => !c.requiredEvidence.includes(cls));
  if (source === "declared" && missing.length > 0) {
    exceptions.push(`requiredEvidence omits ${missing.join(", ")} (below the engineering default; needs the founder's recorded acceptance — rule 16)`);
  }
  const unmeasurable = c.acceptanceCriteria.filter((x) => !x.check).length;
  if (unmeasurable > 0) exceptions.push(`${unmeasurable} acceptance criteria without a check: unmeasurable, count against coverage (rule 16)`);
  if (source === "derived") exceptions.push("contract derived by the evaluator from roster facts; no acceptance criteria could be derived; every metric capped at adequate evidence");
  return {
    source,
    contractVersion: c.contractVersion,
    declaredAt: at ? at.toISOString() : null,
    declaredBy: by,
    accountableUserId: c.accountableUserId,
    leadAgentId: c.leadAgentId,
    requiredEvidence: [...c.requiredEvidence],
    criteriaCount: c.acceptanceCriteria.length,
    measurableCriteria: c.acceptanceCriteria.length - unmeasurable,
    exceptions,
    founderLocks: [...c.founderLocks],
    excludedReviewers: [...c.excludedReviewers],
    targetDate: c.targetDate,
    eventId,
  };
}

/** Rule 17: a criterion declared after an item's terminal transition cannot judge that item. */
export function criterionAppliesTo(resolved: ResolvedContract, terminalTime: Date | null): boolean {
  if (!resolved.declaredAt || !terminalTime) return true;
  return resolved.declaredAt <= terminalTime;
}

export function requiredClasses(resolved: ResolvedContract): EvaluationEvidenceClass[] {
  return [...resolved.contract.requiredEvidence];
}

/** Parse a `record` check name into a shape the evidence module can evaluate. */
export function parseRecordCheck(record: string): { kind: "verdict.passed" | "pr.merged" | "ci.green" | "dod.present" | "project.status" | "goal.status" | "unknown"; value?: string } {
  if (record === "verdict.passed") return { kind: "verdict.passed" };
  if (record === "pr.merged") return { kind: "pr.merged" };
  if (record === "ci.green" || record === "regression_gates.pass") return { kind: "ci.green" };
  if (record === "dod.present") return { kind: "dod.present" };
  const m = /^(project|goal)\.status=([a-z_]+)$/.exec(record);
  if (m) return { kind: m[1] === "project" ? "project.status" : "goal.status", value: m[2]! };
  return { kind: "unknown" };
}

export function contractCompanyId(tl: Timeline): string | null {
  const first = tl.contracts[0];
  return first ? str((first.payload ?? {}) as Record<string, unknown>, "companyId") : null;
}
