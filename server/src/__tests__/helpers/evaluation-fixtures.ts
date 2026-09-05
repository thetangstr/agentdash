import type { EvaluationEventType } from "@paperclipai/shared";
import type { EvaluationEventRow } from "../../services/evaluation/ledger.js";
import { scoreMilestone } from "../../services/evaluation/scoring/card.js";

// AgentDash: Company Evaluator — fixture ledgers for the scoring unit tests.
// A window is an array of ledger rows; every time derives from a fixed t0.

export const CO = "00000000-0000-4000-8000-00000000c0c0";
export const P = "00000000-0000-4000-8000-0000000000a1";
export const P2 = "00000000-0000-4000-8000-0000000000a2";
export const G = "00000000-0000-4000-8000-0000000000b1";
export const A = "00000000-0000-4000-8000-0000000000aa"; // builder
export const R = "00000000-0000-4000-8000-0000000000bb"; // reviewer
export const T = "00000000-0000-4000-8000-0000000000cc"; // tpm
export const FOUNDER = "founder-1";
export const t0 = new Date("2026-08-01T10:00:00.000Z");
export const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);
export const iso = (h: number) => at(h).toISOString();

let seq = 0;
export interface Ev {
  type: EvaluationEventType;
  time: Date;
  actor?: [string, string | null];
  issueId?: string;
  projectId?: string | null;
  goalId?: string | null;
  payload?: Record<string, unknown>;
  ingest?: Date;
  sourceTable?: string;
  sourceId?: string;
}
export function ev(e: Ev): EvaluationEventRow {
  seq++;
  const [actorType, actorId] = e.actor ?? ["system", null];
  return {
    id: `e${seq}`,
    seq,
    companyId: CO,
    projectId: e.projectId === undefined ? P : e.projectId,
    goalId: e.goalId ?? null,
    actorType,
    actorId,
    sourceTable: e.sourceTable ?? e.type.split(".")[0]!,
    sourceId: e.sourceId ?? e.issueId ?? `s${seq}`,
    sourceVersion: `v${seq}`,
    sourceRowHash: null,
    eventType: e.type,
    schemaVersion: 2,
    eventTime: e.time,
    ingestTime: e.ingest ?? new Date(e.time.getTime() + 60_000),
    dedupeKey: `k${seq}`,
    payload: { ...(e.issueId ? { issueId: e.issueId, identifier: `EVL-${e.issueId.slice(-2)}` } : {}), ...(e.payload ?? {}) },
    correlationId: null,
  } as EvaluationEventRow;
}

export function roster(): EvaluationEventRow[] {
  return [
    ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: A, payload: { agentId: A, name: "Builder", role: "engineer", status: "idle", reportsTo: R, accountableUserId: FOUNDER } }),
    ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: R, payload: { agentId: R, name: "Reviewer", role: "reviewer", status: "idle", reportsTo: null, accountableUserId: FOUNDER } }),
    ev({ type: "agent.snapshot", time: at(0), projectId: null, sourceId: T, payload: { agentId: T, name: "TPM", role: "tpm", status: "idle", reportsTo: null, accountableUserId: FOUNDER } }),
    ev({ type: "project.snapshot", time: at(0), projectId: P, goalId: G, sourceId: P, payload: { projectId: P, name: "Launch", status: "in_progress", goalId: G, leadAgentId: null, targetDate: null } }),
    ev({ type: "goal.snapshot", time: at(0), projectId: null, goalId: G, sourceId: G, payload: { goalId: G, title: "Ship", status: "active", ownerAgentId: null, metricDefinition: null } }),
  ];
}

export interface ItemOpts {
  id: string;
  created?: number;
  started?: number | null;
  review?: number | null;
  done?: number | null;
  assignee?: string | null;
  dod?: boolean;
  dodSetAt?: number;
  labels?: string[];
  titleTokens?: string[];
  project?: string | null;
  parentId?: string | null;
  cancelled?: number | null;
  actorDone?: [string, string | null];
}
/** One issue's control-plane facts: snapshot, transitions by the assignee, optional DoD. */
export function item(o: ItemOpts): EvaluationEventRow[] {
  const created = o.created ?? 0;
  const assignee = o.assignee === undefined ? A : o.assignee;
  const project = o.project === undefined ? P : o.project;
  const status = o.done != null ? "done" : o.cancelled != null ? "cancelled" : o.review != null ? "in_review" : o.started != null ? "in_progress" : "todo";
  const out: EvaluationEventRow[] = [];
  out.push(ev({ type: "issue.created", time: at(created), actor: ["user", "local-board"], issueId: o.id, projectId: project }));
  out.push(
    ev({
      type: "issue.snapshot",
      time: at(created),
      issueId: o.id,
      projectId: project,
      sourceTable: "issues",
      payload: {
        status,
        projectId: project,
        inheritedProjectId: null,
        goalId: G,
        parentId: o.parentId ?? null,
        assigneeAgentId: assignee,
        assigneeUserId: null,
        labels: o.labels ?? [],
        titleTokens: o.titleTokens ?? ["ship", "thing", o.id.slice(-2)],
        dodCriteria: o.dod ? 2 : 0,
        dodCriteriaIds: o.dod ? ["c1", "c2"] : null,
        createdAt: iso(created),
        startedAt: o.started != null ? iso(o.started) : null,
        completedAt: o.done != null ? iso(o.done) : null,
        cancelledAt: o.cancelled != null ? iso(o.cancelled) : null,
        originFingerprint: "default",
      },
    }),
  );
  if (o.dod && o.dodSetAt != null) {
    out.push(ev({ type: "issue.dod_set", time: at(o.dodSetAt), actor: ["user", "local-board"], issueId: o.id, projectId: project, payload: { hasPrevious: false, criteriaCount: 2, previousCriteriaCount: null, criteriaIds: ["c1", "c2"], criteriaHashes: ["h1", "h2"] } }));
  }
  const agentActor: [string, string | null] = assignee ? ["agent", assignee] : ["user", "local-board"];
  if (o.started != null) out.push(ev({ type: "issue.transition", time: at(o.started), actor: agentActor, issueId: o.id, projectId: project, payload: { from: "todo", to: "in_progress", reopened: false } }));
  if (o.review != null) out.push(ev({ type: "issue.transition", time: at(o.review), actor: agentActor, issueId: o.id, projectId: project, payload: { from: "in_progress", to: "in_review", reopened: false } }));
  if (o.done != null) out.push(ev({ type: "issue.transition", time: at(o.done), actor: o.actorDone ?? ["agent", R], issueId: o.id, projectId: project, payload: { from: "in_review", to: "done", reopened: false } }));
  if (o.cancelled != null) out.push(ev({ type: "issue.transition", time: at(o.cancelled), actor: ["user", "local-board"], issueId: o.id, projectId: project, payload: { from: status === "cancelled" ? "todo" : status, to: "cancelled", reopened: false } }));
  return out;
}

export function verdict(issueId: string, h: number, reviewer: string | null, outcome = "passed", user: string | null = null): EvaluationEventRow {
  return ev({ type: "verdict.recorded", time: at(h), actor: reviewer ? ["agent", reviewer] : ["user", user], issueId, sourceTable: "verdicts", sourceId: `v-${issueId}-${h}`, payload: { verdictId: `v-${issueId}-${h}`, entityType: "issue", outcome, reviewerAgentId: reviewer, reviewerUserId: user, rubricScores: { correctness: 4 } } });
}
export function handoff(issueId: string, h: number, author: string, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): EvaluationEventRow {
  return ev({ type: `handoff.${type}` as EvaluationEventType, time: at(h), actor: ["agent", author], issueId, sourceTable: "issue_comments", sourceId: `c-${issueId}-${h}`, payload: { commentId: `c-${issueId}-${h}`, handoffType: type, selfReported: false, claimedTimestamp: null, timestampClamped: true, timestampSuspicious: false, droppedKeys: [], payload, ...extra } });
}
export const gates = { typecheck: "pass", test: "pass", build: "pass", pre_existing_failures: [] as string[] };
/** A fully evidenced done item: DoD before start, independent passed verdict, passing gates, shipped merge report. */
export function evidenced(id: string, base = 0): EvaluationEventRow[] {
  return [
    ...item({ id, created: base, started: base + 1, review: base + 5, done: base + 8, dod: true, dodSetAt: base }),
    handoff(id, base + 5, R, "tester_to_reviewer", { issue: { id }, verdict: "pass", regression_gates: gates, labels_applied: [] }),
    verdict(id, base + 6, R),
    handoff(id, base + 7, T, "tpm_merge_report", { issue: { id }, merge_result: "shipped", pr: { number: 42, base_branch: "main" } }),
  ];
}

export const I1 = "00000000-0000-4000-8000-000000000101";
export const I2 = "00000000-0000-4000-8000-000000000102";
export const I3 = "00000000-0000-4000-8000-000000000103";
export const I4 = "00000000-0000-4000-8000-000000000104";
export const I5 = "00000000-0000-4000-8000-000000000105";
export const ref = { kind: "project" as const, id: P };
export const score = (window: EvaluationEventRow[]) => scoreMilestone(window, ref, Math.max(...window.map((e) => Number(e.seq))), CO, { fallbackOpen: true });
export function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

