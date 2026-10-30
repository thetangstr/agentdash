import { describe, expect, it } from "vitest";
import {
  AGENT_CARD_SECTIONS,
  evaluationContractV2Schema,
  type AgentCardV1,
  type EvaluationEventType,
} from "@paperclipai/shared";
import type { EvaluationViewer } from "../services/evaluation/access-class.js";
import { viewerClassFilter, viewerReadsClass } from "../services/evaluation/access-class.js";
import { buildAgentObligationTimeline, cronFireTimes, generateOwedOccurrences } from "../services/evaluation/agent-obligations.js";
import { agentCardHash, agentCardsEquivalent, agentCaseRows, scoreAgent } from "../services/evaluation/agent-scoring.js";
import { projectAgentCardView } from "../services/evaluation/agent-cards.js";
import { calibrationSampleScore, selectCalibrationSample } from "../services/evaluation/calibration.js";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";
import { orderEvents } from "../services/evaluation/ledger.js";
import { buildTimeline } from "../services/evaluation/scoring/timeline.js";
import { countCronFiresInWindow } from "../services/agent-performance-projection.js";

// AgentDash: Agent Performance Management gate 3 (P3.3) — the pure agent
// scoring: owed work from versioned definitions (DST, pause, catch-up, never
// ran), attribution over time, bound vs unbound judgments, typed predicates,
// the agent formulas, fatal classes first, per-viewer projection with no leak
// through counts, side-effect-free projection, calibration selection and
// replay determinism with `asOf` (evaluation LLD §14).

const uid = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
const CO = uid(0xc0);
const AG = uid(0xa1); // the agent under evaluation (producer)
const RV = uid(0xa2); // a reviewer agent
const BB = uid(0xa3); // another agent
const P = uid(0xb1); // open project
const R = uid(0xb2); // restricted project
const ACC = "user-accountable";
const JUDGE = "user-judge";
const OUT = "user-outsider";
const T = uid(0xd1); // a schedule trigger
const ROUTINE = uid(0xd2);
const REV1 = uid(0xe1);
const REV2 = uid(0xe2);
const D0 = Date.parse("2026-10-01T00:00:00.000Z");
const H = 3_600_000;
const day = (n: number, h = 0, m = 0) => new Date(D0 + n * 24 * H + h * H + m * 60_000);

let n = 0;
type Row = EvaluationEventRow;
function row(o: {
  type: EvaluationEventType;
  at: Date;
  actor?: [string, string | null];
  payload?: Record<string, unknown>;
  projectId?: string | null;
  goalId?: string | null;
  accessClass?: string;
  sourceTable?: string;
  sourceId?: string;
  subject?: string | null;
  id?: string;
}): Row {
  n++;
  const [actorType, actorId] = o.actor ?? ["system", null];
  return {
    id: o.id ?? uid(0x100000 + n),
    seq: n,
    companyId: CO,
    projectId: o.projectId ?? null,
    goalId: o.goalId ?? null,
    actorType,
    actorId,
    sourceTable: o.sourceTable ?? o.type.split(".")[0]!,
    sourceId: o.sourceId ?? `s${n}`,
    sourceVersion: `v${n}`,
    sourceRowHash: null,
    eventType: o.type,
    schemaVersion: 3,
    eventTime: o.at,
    ingestTime: new Date(o.at.getTime() + 1000),
    dedupeKey: `k${String(n).padStart(8, "0")}`,
    payload: o.payload ?? {},
    correlationId: null,
    accessClass: o.accessClass ?? "company",
    subjectAgentId: o.subject ?? null,
  } as Row;
}

function issue(o: { id: string; identifier: string; assignee: string | null; created: Date; started?: Date; review?: Date; done?: Date; doneBy?: [string, string]; projectId?: string; accessClass?: string }): Row[] {
  const projectId = o.projectId ?? P;
  const accessClass = o.accessClass ?? "company";
  const base = { projectId, accessClass };
  const pl = (extra: Record<string, unknown>) => ({ issueId: o.id, identifier: o.identifier, ...extra });
  const out: Row[] = [
    row({ type: "issue.snapshot", at: o.created, ...base, sourceTable: "issues", sourceId: o.id, payload: pl({ status: "todo", projectId, assigneeAgentId: o.assignee, assigneeUserId: null, labels: [], titleTokens: [], createdAt: o.created.toISOString() }) }),
  ];
  const by: [string, string | null] = o.assignee ? ["agent", o.assignee] : ["user", ACC];
  if (o.started) out.push(row({ type: "issue.transition", at: o.started, actor: by, ...base, payload: pl({ from: "todo", to: "in_progress" }) }));
  if (o.review) out.push(row({ type: "issue.transition", at: o.review, actor: by, ...base, payload: pl({ from: "in_progress", to: "in_review" }) }));
  if (o.done) out.push(row({ type: "issue.transition", at: o.done, actor: o.doneBy ?? ["agent", RV], ...base, payload: pl({ from: o.review ? "in_review" : "in_progress", to: "done" }) }));
  return out;
}

type Resp = {
  key: string;
  obligation: Record<string, unknown>;
  deadline?: Record<string, unknown>;
  criteria?: Array<Record<string, unknown>>;
  expectedHumanSteps?: string[];
  judges?: Record<string, unknown>;
  outcomeLinks?: Array<{ goalId: string }>;
  coverage?: string[];
};
function profile(o: { agentId?: string; revisionId: string; at: Date; contractId: string; accountable?: string | null; responsibilities: Resp[] }) {
  const agentId = o.agentId ?? AG;
  const contract = {
    contractVersion: "v2",
    companyId: CO,
    subjectRef: { kind: "agent", id: agentId },
    accountableUserId: o.accountable === undefined ? ACC : o.accountable,
    profileRevisionId: o.revisionId,
    independenceRule: "independence/v1",
    responsibilities: o.responsibilities.map((r) => ({
      key: r.key,
      criteria: r.criteria ?? [],
      coverage: r.coverage ?? [],
      ...(r.deadline ? { deadline: r.deadline } : {}),
      outcomeLinks: r.outcomeLinks ?? [],
      expectedHumanSteps: r.expectedHumanSteps ?? [],
      judges: r.judges ?? { automated: [] },
    })),
  };
  expect(evaluationContractV2Schema.safeParse(contract).success).toBe(true);
  const digest = o.responsibilities.map((r) => ({ key: r.key, obligation: r.obligation, deadline: r.deadline ?? null }));
  return [
    row({ type: "contract.declared", at: new Date(o.at.getTime() - 60_000), actor: ["user", ACC], id: o.contractId, sourceTable: "evaluation_contracts", sourceId: `agent:${agentId}`, payload: { contract, companyId: CO } }),
    row({ type: "profile.revision_changed", at: o.at, subject: agentId, payload: { revisionId: o.revisionId, agentId, state: "applied", responsibilities: digest } }),
    row({ type: "profile.application_changed", at: o.at, subject: agentId, payload: { applicationId: uid(0x9000 + n), agentId, revisionId: o.revisionId, status: "applied" } }),
  ];
}

function trigger(o: { id?: string; routineId?: string; at: Date; cron?: string; tz?: string; enabled?: boolean; kind?: string; createdAt?: Date }) {
  const id = o.id ?? T;
  return row({ type: "routine.trigger_snapshot", at: o.at, sourceTable: "routine_triggers", sourceId: id, payload: { triggerId: id, routineId: o.routineId ?? ROUTINE, kind: o.kind ?? "schedule", enabled: o.enabled ?? true, cronExpression: o.cron ?? "0 9 * * *", timezone: o.tz ?? "UTC", createdAt: (o.createdAt ?? o.at).toISOString() } });
}
function routineDef(o: { at: Date; status?: string; catchUp?: string; concurrency?: string }) {
  return row({ type: "routine.snapshot", at: o.at, sourceTable: "routines", sourceId: ROUTINE, payload: { routineId: ROUTINE, status: o.status ?? "active", catchUpPolicy: o.catchUp ?? "skip_missed", concurrencyPolicy: o.concurrency ?? "coalesce_if_active", assigneeAgentId: AG, createdAt: o.at.toISOString() } });
}
function run(o: { id: string; triggeredAt: Date; scheduledFor?: Date | null; status: string; linkedIssueId?: string | null; coalescedInto?: string; source?: string; failureReason?: string; at?: Date }) {
  return row({
    type: "routine.run_changed",
    at: o.at ?? o.triggeredAt,
    projectId: P,
    sourceTable: "routine_runs",
    sourceId: o.id,
    payload: {
      routineRunId: o.id,
      routineId: ROUTINE,
      triggerId: T,
      source: o.source ?? "schedule",
      status: o.status,
      triggeredAt: o.triggeredAt.toISOString(),
      scheduledFor: o.scheduledFor === undefined ? o.triggeredAt.toISOString() : o.scheduledFor?.toISOString() ?? null,
      linkedIssueId: o.linkedIssueId ?? null,
      coalescedIntoRunId: o.coalescedInto ?? null,
      failureReason: o.failureReason ?? null,
    },
  });
}
function mapping(o: { id: string; issueId: string; key: string; from: Date; to?: Date; agentId?: string; projectId?: string; accessClass?: string }) {
  return row({
    type: "responsibility.interval",
    at: o.to ?? o.from,
    projectId: o.projectId ?? P,
    accessClass: o.accessClass,
    sourceTable: "issue_responsibilities",
    sourceId: o.id,
    payload: { mappingId: o.id, issueId: o.issueId, agentId: o.agentId ?? AG, responsibilityKey: o.key, profileRevisionId: REV1, validFrom: o.from.toISOString(), validTo: o.to?.toISOString() ?? null, mappedBy: "human" },
  });
}
function agentSnap(id: string, name: string) {
  return row({ type: "agent.snapshot", at: day(-10), sourceTable: "agents", sourceId: id, payload: { agentId: id, name, accountableUserId: ACC, status: "idle" } });
}

function score(events: Row[], o: { asOf: Date; from: Date; to?: Date; agentId?: string }): AgentCardV1 {
  return scoreAgent({ companyId: CO, agentId: o.agentId ?? AG, events, throughSeq: Math.max(0, ...events.map((e) => Number(e.seq))), asOf: o.asOf.toISOString(), window: { from: o.from.toISOString(), to: (o.to ?? o.asOf).toISOString() }, dependencies: [] });
}
function obligations(card: AgentCardV1, key: string) {
  return card.worker.obligations.body.responsibilities.find((r) => r.responsibilityKey === key)!;
}

const scheduled = (deadline?: Record<string, unknown>) => ({ key: "daily_report", obligation: { kind: "routine", routineTriggerId: T }, ...(deadline ? { deadline } : {}) });

/** Three days of a daily 09:00 trigger; days 1 and 2 ran and were delivered, day 3 never ran. */
function threeDays(): Row[] {
  const I1 = uid(0x501);
  const I2 = uid(0x502);
  return [
    agentSnap(AG, "Reporter"),
    trigger({ at: day(0, 8), createdAt: day(0, 8) }),
    routineDef({ at: day(0, 8) }),
    ...profile({ revisionId: REV1, at: day(0, 8, 30), contractId: uid(0xc1), responsibilities: [scheduled({ kind: "after_trigger", hours: 8 })] }),
    run({ id: uid(0x601), triggeredAt: day(1, 9), status: "issue_created", linkedIssueId: I1 }),
    ...issue({ id: I1, identifier: "REP-1", assignee: AG, created: day(1, 9, 1), started: day(1, 9, 5), review: day(1, 11), done: day(1, 12) }),
    run({ id: uid(0x602), triggeredAt: day(2, 9), status: "issue_created", linkedIssueId: I2 }),
    ...issue({ id: I2, identifier: "REP-2", assignee: AG, created: day(2, 9, 1), started: day(2, 9, 5), review: day(2, 11), done: day(2, 12) }),
  ];
}

describe("APM gate 3 (P3.3): owed work from versioned definitions", () => {
  it("counts a period in which nothing ran: owed 3, delivered 2, the third cause_unknown", () => {
    const card = score(threeDays(), { asOf: day(3, 20), from: day(1) });
    const row0 = obligations(card, "daily_report");
    expect(row0.kind).toBe("scheduled");
    expect(row0.owed).toBe(3);
    expect(row0.byEndState.delivered_on_time).toBe(2);
    expect(row0.byEndState.cause_unknown).toBe(1);
    expect(Object.values(row0.byEndState).reduce((a, b) => a + b, 0)).toBe(3);
    expect(row0.deliveredItemCount).toBe(2);
  });

  it("asOf decides what is overdue without new events, and replay at a stored asOf is exact", () => {
    const events = threeDays();
    const early = score(events, { asOf: day(3, 10), from: day(1) });
    expect(obligations(early, "daily_report").byEndState.not_started).toBe(1); // due at 17:00, still waiting
    const late = score(events, { asOf: day(3, 20), from: day(1), to: day(3, 10) });
    expect(obligations(late, "daily_report").byEndState.cause_unknown).toBe(1);
    // determinism: the same inputs give the same card, whatever order the rows come in
    const again = score([...events].reverse(), { asOf: day(3, 10), from: day(1) });
    expect(agentCardHash(again)).toBe(agentCardHash(early));
    // facts dated after asOf are not yet observed
    const lateFact = [...events, run({ id: uid(0x603), triggeredAt: day(3, 9), status: "issue_created", linkedIssueId: uid(0x503) })];
    lateFact[lateFact.length - 1]!.eventTime = day(3, 21);
    const cut = Number(lateFact[lateFact.length - 1]!.seq);
    const at = (rows: Row[]) => scoreAgent({ companyId: CO, agentId: AG, events: rows, throughSeq: cut, asOf: day(3, 20).toISOString(), window: { from: day(1).toISOString(), to: day(3, 20).toISOString() }, dependencies: [] });
    expect(agentCardHash(at(lateFact))).toBe(agentCardHash(at(lateFact.slice(0, -1))));
  });

  it("refuses inconsistent replay inputs", () => {
    expect(() => score(threeDays(), { asOf: day(3), from: day(1), to: day(4) })).toThrow(/window.to is after asOf/);
  });

  it("generates DST-correct fire times in the trigger's timezone (the scheduler's semantics)", () => {
    // US daylight time ends on Nov 1, 2026: 09:00 New York is 13:00Z before and 14:00Z after
    const fall = cronFireTimes("0 9 * * *", "America/New_York", Date.parse("2026-10-30T00:00:00Z"), Date.parse("2026-11-03T00:00:00Z")).times.map((t) => new Date(t).toISOString());
    expect(fall).toEqual(["2026-10-30T13:00:00.000Z", "2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
    // spring forward on Mar 8, 2026: 02:30 does not exist that day
    const spring = cronFireTimes("30 2 * * *", "America/New_York", Date.parse("2026-03-06T00:00:00Z"), Date.parse("2026-03-11T00:00:00Z")).times;
    expect(spring.length).toBe(4);
    expect(spring.length).toBe(countCronFiresInWindow("30 2 * * *", "America/New_York", new Date("2026-03-06T00:00:00Z"), new Date("2026-03-10T23:59:00Z")));
    // and through generation: occurrence ids carry the zone-correct instant
    const events = [
      trigger({ at: day(25), cron: "0 9 * * *", tz: "America/New_York", createdAt: day(25) }),
      routineDef({ at: day(25) }),
      ...profile({ revisionId: REV1, at: day(25), contractId: uid(0xc1), responsibilities: [scheduled()] }),
    ];
    const tl = buildAgentObligationTimeline(orderEvents(events), buildTimeline(orderEvents(events)), AG);
    const occ = generateOwedOccurrences({ from: "2026-10-30T00:00:00.000Z", to: "2026-11-02T23:00:00.000Z" }, tl, "2026-11-03T00:00:00.000Z");
    expect(occ.map((o) => o.occurrenceId)).toEqual(fall.map((f) => `scheduled:${T}:${f}`));
  });

  it("owes nothing while a trigger or its routine is paused, and owes again once re-enabled", () => {
    const events = [
      trigger({ at: day(0), enabled: true }),
      routineDef({ at: day(0) }),
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [scheduled()] }),
      trigger({ at: day(2), enabled: false }), // paused for days 2 and 3
      trigger({ at: day(4), enabled: true }),
      routineDef({ at: day(5, 12), status: "paused" }), // the routine paused: day 6 owes nothing
    ];
    const tl = buildAgentObligationTimeline(orderEvents(events), buildTimeline(orderEvents(events)), AG);
    const occ = generateOwedOccurrences({ from: day(1).toISOString(), to: day(6, 23).toISOString() }, tl, day(7).toISOString());
    expect(occ.map((o) => o.owedAt)).toEqual([day(1, 9), day(4, 9), day(5, 9)].map((d) => d.toISOString()));
  });

  it("follows the catch-up and coalescing policies in force", () => {
    const head = [trigger({ at: day(0) }), ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [scheduled()] })];
    const window = { from: day(1).toISOString(), to: day(3, 23).toISOString() };
    // skip_missed: the scheduler woke late on day 3 and served only the oldest due tick
    const skip = [...head, routineDef({ at: day(0), catchUp: "skip_missed" }), run({ id: uid(0x701), triggeredAt: day(3, 9, 30), scheduledFor: day(1, 9), status: "issue_created", linkedIssueId: uid(0x711) })];
    let tl = buildAgentObligationTimeline(orderEvents(skip), buildTimeline(orderEvents(skip)), AG);
    let occ = generateOwedOccurrences(window, tl, day(4).toISOString());
    expect(occ.map((o) => o.endState)).toEqual(["cause_unknown", "skipped_by_policy", "skipped_by_policy"]);
    expect(occ[1]!.note).toMatch(/catch-up policy skip_missed/);
    // enqueue_missed_with_cap: every missed tick got its own run
    const enqueue = [
      ...head,
      routineDef({ at: day(0), catchUp: "enqueue_missed_with_cap" }),
      ...[1, 2, 3].map((d) => run({ id: uid(0x720 + d), triggeredAt: day(3, 9, 30), scheduledFor: day(d, 9), status: "received" })),
    ];
    tl = buildAgentObligationTimeline(orderEvents(enqueue), buildTimeline(orderEvents(enqueue)), AG);
    occ = generateOwedOccurrences(window, tl, day(4).toISOString());
    expect(occ.every((o) => o.matched?.routineRunId)).toBe(true);
    // coalesce_if_active: the coalesced tick is served by the live issue of the run it joined
    const I = uid(0x731);
    const coalesce = [
      ...head,
      routineDef({ at: day(0), concurrency: "coalesce_if_active" }),
      run({ id: uid(0x741), triggeredAt: day(1, 9), status: "issue_created", linkedIssueId: I }),
      run({ id: uid(0x742), triggeredAt: day(2, 9), status: "coalesced", coalescedInto: uid(0x741) }),
      ...issue({ id: I, identifier: "REP-9", assignee: AG, created: day(1, 9), started: day(1, 10), review: day(2, 11), done: day(2, 12) }),
    ];
    tl = buildAgentObligationTimeline(orderEvents(coalesce), buildTimeline(orderEvents(coalesce)), AG);
    occ = generateOwedOccurrences({ from: day(1).toISOString(), to: day(2, 23).toISOString() }, tl, day(3).toISOString());
    expect(occ.map((o) => [o.endState, o.matched?.issueId])).toEqual([
      ["delivered_on_time", I],
      ["delivered_on_time", I],
    ]);
    expect(occ[1]!.note).toMatch(/coalesced/);
  });

  it("assigns a block only with evidence; otherwise not_started, missed or cause_unknown", () => {
    const issues = [uid(0x801), uid(0x802), uid(0x803), uid(0x804), uid(0x805)];
    const events: Row[] = [
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "asks", obligation: { kind: "assigned" } }, { key: "fast", obligation: { kind: "assigned" }, deadline: { kind: "after_assignment", hours: 1 } }] }),
      ...issues.flatMap((id, i) => issue({ id, identifier: `ASK-${i}`, assignee: AG, created: day(1), started: i < 3 ? day(1, 1) : undefined })),
      ...issues.map((id, i) => mapping({ id: uid(0x810 + i), issueId: id, key: i === 4 ? "fast" : "asks", from: day(1) })),
      row({ type: "interaction.changed", at: day(1, 2), actor: ["agent", AG], projectId: P, payload: { issueId: issues[0], interactionId: "q1", kind: "ask_user_questions", status: "pending" } }),
      row({ type: "authz.refused", at: day(1, 3), actor: ["agent", AG], projectId: P, payload: { issueId: issues[1], reasonCode: "ACCESS_POLICY_REFUSED", dimension: "do", target: { kind: "connection", id: "c" } } }),
      row({ type: "run.finished", at: day(1, 4), actor: ["agent", AG], projectId: P, payload: { issueId: issues[2], runId: "r1", agentId: AG, status: "failed", errorCode: "adapter_failed" } }),
    ];
    const card = score(events, { asOf: day(2), from: day(1) });
    expect(obligations(card, "asks").byEndState).toMatchObject({ blocked_on_person: 1, blocked_on_access: 1, blocked_on_platform: 1, not_started: 1 });
    expect(obligations(card, "fast").byEndState.missed).toBe(1);
    const cases = agentCaseRows({ companyId: CO, agentId: AG, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });
    for (const c of cases.filter((x) => x.section === "obligations" && String(x.state).startsWith("blocked_"))) expect(c.evidenceRefs.length).toBeGreaterThan(0);
  });
});

describe("APM gate 3 (P3.3): who did what, over time", () => {
  const I1 = uid(0x901);
  const I2 = uid(0x902);
  const base = () => [
    agentSnap(AG, "Builder"),
    agentSnap(RV, "Reviewer"),
    agentSnap(BB, "Helper"),
    ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "build", obligation: { kind: "assigned" } }] }),
    ...issue({ id: I1, identifier: "BLD-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8) }),
    mapping({ id: uid(0x911), issueId: I1, key: "build", from: day(1) }),
    row({ type: "verdict.recorded", at: day(1, 6), actor: ["agent", RV], projectId: P, sourceTable: "verdicts", payload: { issueId: I1, verdictId: "v1", entityType: "issue", outcome: "passed", reviewerAgentId: RV, reviewerUserId: null } }),
  ];

  it("delivery credit stays with the producer at delivery when the item is reassigned afterwards", () => {
    const events = [...base(), row({ type: "issue.assignment_changed", at: day(1, 9), actor: ["user", ACC], projectId: P, payload: { issueId: I1, fromAgentId: AG, toAgentId: BB } })];
    expect(score(events, { asOf: day(2), from: day(1) }).worker.acceptance.body.delivered.items).toBe(1);
    expect(score(events, { asOf: day(2), from: day(1), agentId: BB }).worker.acceptance.body.delivered.items).toBe(0);
  });

  it("several agents on one issue: the producer is credited; a contributor's work is its own, unmapped bucket", () => {
    const events = [...base(), ...issue({ id: I2, identifier: "BLD-2", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 9) })];
    events.push(row({ type: "run.finished", at: day(1, 2), actor: ["agent", BB], projectId: P, payload: { issueId: I2, runId: "rb", agentId: BB, status: "succeeded" } }));
    const a = score(events, { asOf: day(2), from: day(1) });
    const b = score(events, { asOf: day(2), from: day(1), agentId: BB });
    expect(a.worker.acceptance.body.delivered.items).toBe(2);
    expect(a.worker.obligations.body.unmapped.items).toBe(1); // BLD-2 has no mapping
    expect(b.worker.acceptance.body.delivered.items).toBe(0);
    expect(b.worker.obligations.body.unmapped.items).toBe(1); // its run on BLD-2
    const cases = (agent: string) => agentCaseRows({ companyId: CO, agentId: agent, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] }).filter((c) => c.caseId.startsWith("obligations:unmapped:"));
    expect(cases(AG).map((c) => [c.itemLabel, c.role])).toEqual([["BLD-2", "producer"]]);
    expect(cases(BB).map((c) => [c.itemLabel, c.role])).toEqual([["BLD-2", "contributor"]]);
  });

  it("reviewer vs producer: the reviewer's work is its own section; the producer's quality counts an independent judge", () => {
    const a = score(base(), { asOf: day(2), from: day(1) });
    const r = score(base(), { asOf: day(2), from: day(1), agentId: RV });
    expect(a.worker.quality.body.judgeIndependence.independent).toBe(1);
    expect(a.reviewer.body.reviews.total).toBe(0);
    expect(r.reviewer.body.reviews).toMatchObject({ total: 1, unbound: 1, byOutcome: { passed: 1 } });
    expect(r.reviewer.body.independence.independent).toBe(1);
    expect(r.worker.acceptance.body.delivered.items).toBe(0);
  });

  it("harness feedback to a non-producer is a feedback-recipient case, never a performance fact", () => {
    const events = [...base(), row({ type: "assessment.automated", at: day(1, 7), projectId: P, accessClass: `private_pairing:${uid(0x9f1)}`, payload: { receiptId: uid(0x9f1), pairedAgentId: BB, issueId: I1, checks: [{ criterionId: null, outcome: "pass" }] } })];
    const b = score(events, { asOf: day(2), from: day(1), agentId: BB });
    expect(b.worker.quality.body.unboundObservations).toBe(0);
    const cases = agentCaseRows({ companyId: CO, agentId: BB, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });
    expect(cases.filter((c) => c.role === "feedback_recipient").length).toBe(1);
    const a = score(events, { asOf: day(2), from: day(1) });
    expect(a.worker.quality.body.unboundObservations).toBe(1); // on the producer's work, unbound
    expect(a.gaps.body.map((g) => g.code)).toContain("UNBOUND_JUDGMENTS");
  });
});

describe("APM gate 3 (P3.3): bound vs unbound judgments and typed predicates", () => {
  const I1 = uid(0xa01);
  const C1 = uid(0xc1);
  const C2 = uid(0xc2);
  const harnessCrit = { id: "c1", text: "The harness accepts it", check: { kind: "record", record: "harness.criterion_passed" }, source: "human" };
  const attestCrit = { id: "a1", text: "The judge accepts it", check: { kind: "human_attest", attesterUserId: JUDGE }, source: "human" };
  const setup = (criteria: Array<Record<string, unknown>>) => [
    agentSnap(AG, "Builder"),
    ...profile({ revisionId: REV1, at: day(0), contractId: C1, responsibilities: [{ key: "work", obligation: { kind: "assigned" }, criteria, judges: { automated: ["harness"], human: { userId: JUDGE, sampleRate: 1, minPerWindow: 1 } } }] }),
    ...issue({ id: I1, identifier: "WRK-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8) }),
    mapping({ id: uid(0xa11), issueId: I1, key: "work", from: day(1) }),
  ];
  const receipt = (at: Date, checks: Array<Record<string, unknown>>) =>
    row({ type: "assessment.automated", at, projectId: P, accessClass: `private_pairing:${uid(0xaf0 + n)}`, payload: { receiptId: uid(0xaf0 + n), pairedAgentId: AG, issueId: I1, checks } });
  const attest = (o: { at: Date; by: string; criterion: Record<string, unknown>; subject?: string; result?: string }) =>
    row({ type: "evaluation.disposition", at: o.at, actor: ["user", o.by], projectId: P, sourceTable: "evaluation_dispositions", payload: { kind: "criterion_attest", binding: { criterion: o.criterion, subjectRef: { kind: "agent", id: o.subject ?? AG }, item: { kind: "issue", id: I1 } }, result: o.result ?? "satisfied", evidenceRefs: [uid(1)], decidedBy: o.by } });

  it("a legacy receipt never satisfies a criterion; a bound check does", () => {
    const events = [...setup([harnessCrit]), receipt(day(1, 6), [{ criterionId: null, outcome: "pass" }])];
    let card = score(events, { asOf: day(2), from: day(1) });
    let row0 = card.worker.quality.body.criteria[0]!;
    expect(row0.byJudge.harness).toEqual({ pass: 0, fail: 0, unknown: 1 });
    expect(card.worker.quality.body.unboundObservations).toBe(1);
    events.push(receipt(day(1, 7), [{ criterionId: "c1", outcome: "pass" }]));
    card = score(events, { asOf: day(2), from: day(1) });
    row0 = card.worker.quality.body.criteria[0]!;
    expect(row0.byJudge.harness).toEqual({ pass: 1, fail: 0, unknown: 0 });
    expect(row0.byJudge.evaluator.pass).toBe(0); // harness.criterion_passed is the harness's judgment, not the evaluator's
  });

  it("attestations bind to their tuple: other subjects, unnamed people, V1 attests and changed checks never count", () => {
    const events = setup([attestCrit]);
    const tuple = scoreAgent({ companyId: CO, agentId: AG, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] }).worker.quality.body.criteria[0]!.criterion;
    events.push(attest({ at: day(1, 9), by: JUDGE, criterion: tuple, subject: BB })); // another subject
    events.push(attest({ at: day(1, 9), by: OUT, criterion: tuple })); // not the named attester
    events.push(row({ type: "evaluation.disposition", at: day(1, 9), actor: ["user", JUDGE], projectId: P, payload: { kind: "criterion_attest", criterionId: "a1", issueId: I1, result: "satisfied" } })); // V1 shape
    let card = score(events, { asOf: day(2), from: day(1) });
    expect(card.worker.quality.body.criteria[0]!.byJudge.person.pass).toBe(0);
    events.push(attest({ at: day(1, 10), by: JUDGE, criterion: tuple }));
    card = score(events, { asOf: day(2), from: day(1) });
    expect(card.worker.quality.body.criteria[0]!.byJudge.person).toEqual({ pass: 1, fail: 0, unknown: 0 });
    // a new revision changes the check under the same id: a new tuple, starting fresh
    const changed = { ...attestCrit, check: { kind: "human_attest", attesterUserId: OUT } };
    const later = [
      ...events,
      ...profile({ revisionId: REV2, at: day(1, 11), contractId: C2, responsibilities: [{ key: "work", obligation: { kind: "assigned" }, criteria: [changed] }] }),
      ...issue({ id: uid(0xa02), identifier: "WRK-2", assignee: AG, created: day(1, 12), started: day(1, 13), review: day(1, 14), done: day(1, 15) }),
      mapping({ id: uid(0xa12), issueId: uid(0xa02), key: "work", from: day(1, 12) }),
    ];
    card = score(later, { asOf: day(2), from: day(1) });
    const rows = card.worker.quality.body.criteria;
    expect(rows.map((r) => r.criterion.contractEventId).sort()).toEqual([C1, C2].sort());
    const fresh = rows.find((r) => r.criterion.contractEventId === C2)!;
    expect(fresh.criterion.checkHash).not.toBe(tuple.checkHash);
    expect(fresh.byJudge.person.pass).toBe(0);
  });

  it("a shipped deliverable cannot satisfy pr.merged; deliverable.shipped reads its own record", () => {
    const DLV = uid(0xb01);
    const RUN = uid(0xb02);
    const events = [
      agentSnap(AG, "Assembler"),
      ...profile({
        revisionId: REV1,
        at: day(0),
        contractId: C1,
        responsibilities: [
          {
            key: "weekly",
            obligation: { kind: "deliverable", deliverableId: DLV },
            criteria: [
              { id: "pr", text: "Merged", check: { kind: "record", record: "pr.merged" }, source: "human" },
              { id: "ship", text: "Shipped", check: { kind: "record", record: "deliverable.shipped" }, source: "human" },
            ],
          },
        ],
      }),
      row({ type: "deliverable.run_changed", at: day(1, 10), sourceTable: "deliverable_runs", sourceId: RUN, payload: { deliverableRunId: RUN, deliverableId: DLV, runKey: "2026-W40", status: "shipped", assemblerAgentId: AG, openedAt: day(1).toISOString(), shippedAt: day(1, 10).toISOString(), checkPassed: true } }),
    ];
    const card = score(events, { asOf: day(2), from: day(1) });
    const [pr, ship] = ["pr", "ship"].map((id) => card.worker.quality.body.criteria.find((c) => c.criterion.criterionId === id)!);
    expect(pr!.items).toBe(1);
    expect(pr!.byJudge.evaluator).toEqual({ pass: 0, fail: 0, unknown: 1 });
    expect(ship!.byJudge.evaluator).toEqual({ pass: 1, fail: 0, unknown: 0 });
    const row0 = obligations(card, "weekly");
    expect(row0.owed).toBeNull(); // owed periods unknown: the cadence is free text
    expect(row0.byEndState.delivered_on_time).toBe(1);
    expect(card.gaps.body.map((g) => g.code)).toContain("OWED_PERIODS_UNKNOWN");
  });
});

describe("APM gate 3 (P3.3): acceptance facts are judge-type-specific (LLD §1)", () => {
  // A `verdict.passed` criterion is satisfied by any independent passed verdict, but the judgment is the
  // reviewer's: a person's verdict is human acceptance only, an independent agent's verdict automated only.
  const I1 = uid(0xe01);
  const C1 = uid(0xc1);
  const reviewed = { id: "reviewed", text: "An independent reviewer passed it", check: { kind: "record", record: "verdict.passed" }, source: "human" };
  const setup = () => [
    agentSnap(AG, "Builder"),
    agentSnap(RV, "Reviewer"),
    ...profile({ revisionId: REV1, at: day(0), contractId: C1, responsibilities: [{ key: "work", obligation: { kind: "assigned" }, criteria: [reviewed], judges: { automated: ["evaluator", "independent_agent"], human: { userId: JUDGE, sampleRate: 1, minPerWindow: 1 } } }] }),
    ...issue({ id: I1, identifier: "WRK-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8) }),
    mapping({ id: uid(0xe11), issueId: I1, key: "work", from: day(1) }),
  ];
  const verdict = (by: "person" | "agent", outcome: string, at: Date) =>
    row({
      type: "verdict.recorded",
      at,
      actor: by === "person" ? ["user", JUDGE] : ["agent", RV],
      projectId: P,
      sourceTable: "verdicts",
      payload: { issueId: I1, verdictId: `v${n}`, entityType: "issue", outcome, reviewerAgentId: by === "agent" ? RV : null, reviewerUserId: by === "person" ? JUDGE : null },
    });
  const read = (events: Row[]) => {
    const card = score(events, { asOf: day(2), from: day(1) });
    const { automatedAcceptance, humanAcceptance } = card.worker.acceptance.body.facts;
    return { automated: automatedAcceptance, human: humanAcceptance, byJudge: card.worker.quality.body.criteria[0]!.byJudge, card };
  };

  it("a person-only pass is human acceptance, not automated", () => {
    const { automated, human, byJudge } = read([...setup(), verdict("person", "passed", day(1, 6))]);
    expect(human).toMatchObject({ yes: 1, no: 0, unknown: 0, of: 1 });
    expect(automated).toMatchObject({ yes: 0, no: 0, unknown: 1, of: 1 });
    // the criterion is still satisfied, by the person
    expect(byJudge.person).toEqual({ pass: 1, fail: 0, unknown: 0 });
    expect(byJudge.evaluator).toEqual({ pass: 0, fail: 0, unknown: 1 });
    expect(byJudge.independent_agent).toEqual({ pass: 0, fail: 0, unknown: 1 });
  });

  it("an independent-agent-only pass is automated acceptance, not human", () => {
    const { automated, human, byJudge } = read([...setup(), verdict("agent", "passed", day(1, 6))]);
    expect(automated).toMatchObject({ yes: 1, no: 0, unknown: 0, of: 1 });
    expect(human).toMatchObject({ yes: 0, no: 0, unknown: 1, of: 1 });
    expect(byJudge.independent_agent).toEqual({ pass: 1, fail: 0, unknown: 0 });
    expect(byJudge.person).toEqual({ pass: 0, fail: 0, unknown: 1 });
    expect(byJudge.evaluator.pass).toBe(0);
  });

  it("an item is in both only when both kinds of judge passed it", () => {
    const { automated, human, byJudge, card } = read([...setup(), verdict("person", "passed", day(1, 6)), verdict("agent", "passed", day(1, 7))]);
    expect(automated).toMatchObject({ yes: 1, of: 1 });
    expect(human).toMatchObject({ yes: 1, of: 1 });
    expect(byJudge.person.pass).toBe(1);
    expect(byJudge.independent_agent.pass).toBe(1);
    expect(card.worker.decisions.body.disagreements).toEqual([]);
  });

  it("a kind that decided without passing fails on its own column; the criterion stays satisfied by the other", () => {
    const { automated, human, byJudge, card } = read([...setup(), verdict("person", "passed", day(1, 6)), verdict("agent", "revision_requested", day(1, 7))]);
    expect(human).toMatchObject({ yes: 1, of: 1 });
    expect(automated).toMatchObject({ yes: 0, no: 1, of: 1 });
    expect(byJudge.person.pass).toBe(1);
    expect(byJudge.independent_agent).toEqual({ pass: 0, fail: 1, unknown: 0 });
    expect(card.worker.decisions.body.disagreements.map((d) => d.judgments.map((j) => [j.judge, j.result]))).toEqual([[["person", "pass"], ["independent_agent", "fail"]]]);
  });

  it("a person's verdict and the same criterion's attestation count once for the person column", () => {
    const events = setup();
    const tuple = score(events, { asOf: day(2), from: day(1) }).worker.quality.body.criteria[0]!.criterion;
    events.push(verdict("person", "passed", day(1, 6)));
    events.push(row({ type: "evaluation.disposition", at: day(1, 9), actor: ["user", JUDGE], projectId: P, sourceTable: "evaluation_dispositions", payload: { kind: "criterion_attest", binding: { criterion: tuple, subjectRef: { kind: "agent", id: AG }, item: { kind: "issue", id: I1 } }, result: "satisfied", evidenceRefs: [uid(1)], decidedBy: JUDGE } }));
    const { automated, human, byJudge } = read(events);
    expect(byJudge.person).toEqual({ pass: 1, fail: 0, unknown: 0 });
    expect(human).toMatchObject({ yes: 1, of: 1 });
    expect(automated).toMatchObject({ yes: 0, unknown: 1 });
    const cases = agentCaseRows({ companyId: CO, agentId: AG, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });
    const ids = cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("APM gate 3 (P3.7): a use.confirmed criterion feeds the use fact only", () => {
  // Use is its own fact (LLD §1): a criterion checked by `use.confirmed` is judged like any other in the
  // quality section, but it never makes the item automatically or humanly accepted.
  const I1 = uid(0xf01);
  const C1 = uid(0xc1);
  const used = { id: "used", text: "Someone used the report", check: { kind: "record", record: "use.confirmed" }, source: "human" };
  const setup = () => [
    agentSnap(AG, "Builder"),
    ...profile({ revisionId: REV1, at: day(0), contractId: C1, responsibilities: [{ key: "work", obligation: { kind: "assigned" }, criteria: [used], judges: { automated: ["evaluator"], human: { userId: JUDGE, sampleRate: 1, minPerWindow: 1 } } }] }),
    ...issue({ id: I1, identifier: "USE-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8) }),
    mapping({ id: uid(0xf11), issueId: I1, key: "work", from: day(1) }),
  ];
  const useConfirmed = (at: Date, by: string) =>
    row({ type: "evaluation.disposition", at, actor: ["user", by], projectId: P, sourceTable: "evaluation_dispositions", payload: { kind: "use_confirmed", subjectRef: { kind: "agent", id: AG }, item: { kind: "issue", id: I1 }, evidenceRefs: [uid(1)], decidedBy: by } });
  const attest = (at: Date, criterion: Record<string, unknown>, result: "satisfied" | "unsatisfied") =>
    row({ type: "evaluation.disposition", at, actor: ["user", JUDGE], projectId: P, sourceTable: "evaluation_dispositions", payload: { kind: "criterion_attest", binding: { criterion, subjectRef: { kind: "agent", id: AG }, item: { kind: "issue", id: I1 } }, result, evidenceRefs: [uid(1)], decidedBy: JUDGE } });
  const facts = (events: Row[]) => score(events, { asOf: day(2), from: day(1) }).worker.acceptance.body.facts;
  const cases = (events: Row[]) => agentCaseRows({ companyId: CO, agentId: AG, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });

  it("a use_confirmed disposition passes the criterion and counts as use, never as automated or human acceptance", () => {
    const events = [...setup(), useConfirmed(day(1, 9), OUT)];
    const card = score(events, { asOf: day(2), from: day(1) });
    expect(card.worker.quality.body.criteria[0]!.byJudge.evaluator).toEqual({ pass: 1, fail: 0, unknown: 0 });
    const f = card.worker.acceptance.body.facts;
    expect(f.use).toMatchObject({ yes: 1, no: 0, unknown: 0, of: 1 });
    expect(f.automatedAcceptance).toMatchObject({ yes: 0, no: 0, unknown: 1, of: 1 });
    expect(f.humanAcceptance).toMatchObject({ yes: 0, no: 0, unknown: 1, of: 1 });
    const byFact = Object.fromEntries(cases(events).filter((c) => c.section === "acceptance").map((c) => [c.fact, c.state]));
    expect(byFact).toEqual({ automated: "unknown", human: "unknown", use: "pass", outcome: "unknown" });
  });

  it("a bound attestation of the use criterion decides use (a 'not used' is a no), never human acceptance", () => {
    const tuple = score(setup(), { asOf: day(2), from: day(1) }).worker.quality.body.criteria[0]!.criterion;
    const notUsed = [...setup(), attest(day(1, 9), tuple, "unsatisfied")];
    expect(facts(notUsed).use).toMatchObject({ yes: 0, no: 1, unknown: 0 });
    expect(facts(notUsed).humanAcceptance).toMatchObject({ yes: 0, no: 0, unknown: 1 });
    expect(facts(notUsed).automatedAcceptance).toMatchObject({ yes: 0, no: 0, unknown: 1 });
    const confirmed = [...setup(), attest(day(1, 9), tuple, "satisfied")];
    expect(facts(confirmed).use).toMatchObject({ yes: 1, no: 0 });
    expect(facts(confirmed).humanAcceptance).toMatchObject({ yes: 0, unknown: 1 });
    // the person's attestation is still a person judgment of the criterion
    expect(score(confirmed, { asOf: day(2), from: day(1) }).worker.quality.body.criteria[0]!.byJudge.person.pass).toBe(1);
  });

  it("a quality case with no judgment yet cites the item's own records, so a named attester can bind to it", () => {
    const events = setup();
    const unknown = cases(events).find((c) => c.section === "quality" && c.criterion !== null)!;
    expect(unknown).toMatchObject({ state: "unknown", judge: null });
    const ids = new Set(events.map((e) => e.id));
    expect(unknown.evidenceRefs.length).toBeGreaterThan(0);
    for (const id of unknown.evidenceRefs) expect(ids.has(id)).toBe(true);
    // the delivery (the transition to done) and the issue record are among them
    const done = events.find((e) => e.eventType === "issue.transition" && (e.payload as { to?: string }).to === "done")!;
    const snapshot = events.find((e) => e.eventType === "issue.snapshot")!;
    expect(unknown.evidenceRefs).toEqual(expect.arrayContaining([done.id, snapshot.id]));
  });
});

describe("APM gate 3 (P3.3): agent formula semantics and fatal classes", () => {
  const I1 = uid(0xc01);
  it("P6 split: refusals are attempts, repeats raise an exception, only unauthorized execution is fatal and first", () => {
    const refusal = (at: Date, target: string) => row({ type: "authz.refused", at, actor: ["agent", AG], payload: { reasonCode: "ACCESS_POLICY_REFUSED", dimension: "do", rule: "do.connections", target: { kind: "connection", id: target } } });
    const events = [
      agentSnap(AG, "Builder"),
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "x", obligation: { kind: "assigned" } }] }),
      refusal(day(1, 1), "slack"),
      refusal(day(1, 2), "slack"),
      refusal(day(1, 3), "email"),
      row({ type: "access.would_refuse", at: day(1, 4), payload: { agentId: AG, dimension: "talk", rule: "talk.agents", policyMode: "shadow" } }),
    ];
    let card = score(events, { asOf: day(2), from: day(1) });
    expect(card.worker.bounds.body).toMatchObject({ refusedAttempts: 3, repeatedAfterRefusal: 1, wouldRefuse: 1, unauthorizedExecution: 0 });
    expect(card.worker.bounds.body.byDimension.do).toEqual({ refused: 3, repeated: 1, wouldRefuse: 0, unauthorized: 0 });
    expect(card.fatal.body).toEqual([]);
    expect(card.worker.decisions.body.exceptions.map((e) => [e.kind, e.severity])).toEqual([["repeated_after_refusal", "material"]]);
    events.push(row({ type: "access.would_refuse", at: day(1, 5), payload: { agentId: AG, dimension: "do", rule: "do.connections", policyMode: "enforce", issueId: I1 } }));
    card = score(events, { asOf: day(2), from: day(1) });
    expect(card.worker.bounds.body.unauthorizedExecution).toBe(1);
    expect(card.fatal.body.map((f) => [f.fatalClass, f.status])).toEqual([["unauthorized_execution", "potential"]]);
    expect(card.worker.decisions.body.exceptions[0]).toMatchObject({ kind: "unauthorized_execution", severity: "immediate" });
    // fatal classes come first on the card and on every view
    expect(Object.keys(card).indexOf("fatal")).toBeLessThan(Object.keys(card).indexOf("worker"));
    const view = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: viewer({ admin: true }), readableCard: () => card, dependencyReadable: () => true, canSeePeople: true });
    expect(Object.keys(view).indexOf("fatal")).toBeLessThan(Object.keys(view).indexOf("worker"));
  });

  it("P1: steps the contract expects are not interventions; unplanned human completions are", () => {
    const build = (expected: string[]) => [
      agentSnap(AG, "Builder"),
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "x", obligation: { kind: "assigned" }, expectedHumanSteps: expected }] }),
      ...issue({ id: I1, identifier: "X-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8), doneBy: ["user", ACC] }),
      mapping({ id: uid(0xc11), issueId: I1, key: "x", from: day(1) }),
    ];
    const signed = score(build(["sign_off"]), { asOf: day(2), from: day(1) }).worker.cost.body;
    expect([signed.humanReviewActions, signed.humanCorrections]).toEqual([1, 0]);
    const rescued = score(build([]), { asOf: day(2), from: day(1) }).worker.cost.body;
    expect([rescued.humanReviewActions, rescued.humanCorrections]).toEqual([0, 1]);
  });

  it("rework is charged to the producer, never to the reviewer; judge independence and source diversity are separate", () => {
    const events = [
      agentSnap(AG, "Builder"),
      agentSnap(RV, "Reviewer"),
      ...issue({ id: I1, identifier: "X-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 5), done: day(1, 8), doneBy: ["user", ACC] }),
      row({ type: "issue.transition", at: day(1, 9), actor: ["user", ACC], projectId: P, payload: { issueId: I1, from: "done", to: "in_progress", reopened: true } }),
      row({ type: "issue.transition", at: day(1, 10), actor: ["agent", AG], projectId: P, payload: { issueId: I1, from: "in_progress", to: "in_review" } }),
      row({ type: "verdict.recorded", at: day(1, 10, 30), actor: ["agent", RV], projectId: P, payload: { issueId: I1, verdictId: "v", outcome: "passed", reviewerAgentId: RV } }),
      row({ type: "issue.transition", at: day(1, 11), actor: ["agent", RV], projectId: P, payload: { issueId: I1, from: "in_review", to: "done" } }),
    ];
    const a = score(events, { asOf: day(2), from: day(1) });
    expect(a.worker.quality.body.rework).toEqual({ items: 1, reopened: 1 });
    expect(a.worker.quality.body.judgeIndependence).toEqual({ independent: 1, notIndependent: 0, unknown: 0 });
    expect(a.worker.quality.body.sourceDiversity).toEqual({}); // no contract: no criterion was judged, so no decisive facts by tier
    expect(score(events, { asOf: day(2), from: day(1), agentId: RV }).worker.quality.body.rework).toEqual({ items: 0, reopened: 0 });
    expect(a.gaps.body.map((g) => g.code)).toContain("NO_APPLIED_PROFILE");
    expect(a.contract.source).toBe("none");
  });
});

function viewer(o: Partial<EvaluationViewer> = {}): EvaluationViewer {
  return { companyId: CO, principal: { type: "board", userId: OUT }, admin: false, readableProjectIds: new Set([P]), hiddenProjectIds: new Set([R]), privateAgentIds: new Set(), pairingReceiptIds: new Set(), ...o };
}

describe("APM gate 3 (P3.3): per-viewer projection", () => {
  const OPEN = uid(0xd01);
  const HIDDEN = uid(0xd02);
  const REVIEWED = uid(0xd03);
  const CORR = uid(0xd04);
  const events = () => [
    agentSnap(AG, "Builder"),
    ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "work", obligation: { kind: "assigned" } }] }),
    ...issue({ id: OPEN, identifier: "OPN-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 4), done: day(1, 6) }),
    mapping({ id: uid(0xd11), issueId: OPEN, key: "work", from: day(1) }),
    ...issue({ id: HIDDEN, identifier: "SEC-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 4), done: day(1, 6), projectId: R, accessClass: `project:${R}` }),
    mapping({ id: uid(0xd12), issueId: HIDDEN, key: "work", from: day(1), projectId: R, accessClass: `project:${R}` }),
    // the agent's only review is of work in the restricted project
    ...issue({ id: REVIEWED, identifier: "SEC-2", assignee: BB, created: day(1), started: day(1, 1), review: day(1, 2), projectId: R, accessClass: `project:${R}` }),
    row({ type: "verdict.recorded", at: day(1, 3), actor: ["agent", AG], projectId: R, accessClass: `project:${R}`, payload: { issueId: REVIEWED, verdictId: "vs", outcome: "passed", reviewerAgentId: AG } }),
    row({ type: "correction.recorded", at: day(1, 7), actor: ["user", ACC], accessClass: `private_agent:${AG}`, id: CORR, payload: { correctionId: CORR, agentId: AG, issueId: null, kind: "revision" } }),
  ];
  const input = (rows: Row[]) => ({ companyId: CO, agentId: AG, events: rows, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });

  it("a section built only from classes the viewer can't read is 'Not visible to you' with no counts; others count only what they can read", () => {
    const rows = events();
    const card = scoreAgent(input(rows));
    expect(obligations(card, "work").owed).toBe(2);
    expect(card.worker.cost.body.humanCorrections).toBe(1);
    const outsider = viewer();
    const readable = rows.filter(viewerClassFilter(outsider));
    let calls = 0;
    const before = agentCardHash(card);
    const view = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: outsider, readableCard: () => (calls++, scoreAgent(input(readable))), dependencyReadable: () => false, canSeePeople: false });
    expect(agentCardHash(card)).toBe(before); // projection has no side effect on the card
    expect(calls).toBe(1);
    expect(view.restricted).toBe(true);
    expect(view.reviewer).toEqual({ visibility: "not_visible", note: "Not visible to you" });
    expect(view.worker.obligations.visibility).toBe("partial");
    if (view.worker.obligations.visibility !== "not_visible") expect(view.worker.obligations.body.responsibilities[0]!.owed).toBe(1);
    // the burden section rests only on the agent's private correction: no body, no counts
    expect(view.worker.cost).toEqual({ visibility: "not_visible", note: "Not visible to you" });
    const json = JSON.stringify(view);
    for (const secret of [HIDDEN, REVIEWED, "SEC-1", "SEC-2", CORR]) expect(json).not.toContain(secret);
    // the drill-down rests on the same readable rows, and filters by class before anything is counted
    const cases = agentCaseRows(input(readable)).filter((c) => c.accessClasses.every((cls) => viewerReadsClass(outsider, cls)));
    expect(JSON.stringify(cases)).not.toContain(HIDDEN);
    expect(cases.filter((c) => c.section === "obligations").length).toBe(1);
  });

  it("the steward reads its agent's private class; an admin reads the stored card as it is", () => {
    const rows = events();
    const card = scoreAgent(input(rows));
    const steward = viewer({ principal: { type: "board", userId: "steward" }, privateAgentIds: new Set([AG]) });
    const view = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: steward, readableCard: () => scoreAgent(input(rows.filter(viewerClassFilter(steward)))), dependencyReadable: () => true, canSeePeople: false });
    if (view.worker.cost.visibility !== "not_visible") expect(view.worker.cost.body.humanCorrections).toBe(1);
    const admin = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: viewer({ admin: true }), readableCard: () => { throw new Error("an admin is served the stored card"); }, dependencyReadable: () => true, canSeePeople: true });
    expect(admin.worker.obligations).toEqual({ visibility: "visible", body: card.worker.obligations.body });
    for (const key of AGENT_CARD_SECTIONS) expect(admin.worker[key].visibility).toBe("visible");
    expect(admin.restricted).toBe(false);
  });
});

describe("APM gate 3 (P3.3): private receipts and the milestone roll-up", () => {
  const I1 = uid(0xf01);
  const RECEIPT = uid(0xf02);
  it("a private harness receipt never reaches an outsider, not even as a count", () => {
    const rows = [
      agentSnap(AG, "Builder"),
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "work", obligation: { kind: "assigned" } }] }),
      ...issue({ id: I1, identifier: "PRV-1", assignee: AG, created: day(1), started: day(1, 1), review: day(1, 4), done: day(1, 6) }),
      mapping({ id: uid(0xf11), issueId: I1, key: "work", from: day(1) }),
      row({ type: "assessment.automated", at: day(1, 5), projectId: P, accessClass: `private_pairing:${RECEIPT}`, payload: { receiptId: RECEIPT, pairedAgentId: AG, issueId: I1, checks: [] } }),
    ];
    const input = (events: Row[]) => ({ companyId: CO, agentId: AG, events, throughSeq: n, asOf: day(2).toISOString(), window: { from: day(1).toISOString(), to: day(2).toISOString() }, dependencies: [] });
    const card = scoreAgent(input(rows));
    expect(card.worker.quality.body.unboundObservations).toBe(1);
    const outsider = viewer();
    const view = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: outsider, readableCard: () => scoreAgent(input(rows.filter(viewerClassFilter(outsider)))), dependencyReadable: () => true, canSeePeople: false });
    expect(view.worker.quality.visibility).toBe("partial");
    if (view.worker.quality.visibility !== "not_visible") expect(view.worker.quality.body.unboundObservations).toBe(0);
    expect(JSON.stringify(view)).not.toContain(RECEIPT);
    const paired = viewer({ pairingReceiptIds: new Set([RECEIPT]) });
    const pv = projectAgentCardView({ card, stored: null, sideEffectFree: true, viewer: paired, readableCard: () => scoreAgent(input(rows.filter(viewerClassFilter(paired)))), dependencyReadable: () => true, canSeePeople: false });
    if (pv.worker.quality.visibility !== "not_visible") expect(pv.worker.quality.body.unboundObservations).toBe(1);
  });

  it("projects the agent led are recomputed with scoreMilestone from the same cut and cited with their hash", async () => {
    const { scoreMilestone, cardHash, FORMULA_VERSION } = await import("../services/evaluation/scoring/card.js");
    const { accountableMilestoneRefs } = await import("../services/evaluation/agent-scoring.js");
    const rows = [
      agentSnap(AG, "Lead"),
      row({ type: "project.snapshot", at: day(0), projectId: P, sourceTable: "projects", sourceId: P, payload: { projectId: P, name: "Launch", status: "in_progress", leadAgentId: AG } }),
      row({ type: "project.snapshot", at: day(1, 12), projectId: P, sourceTable: "projects", sourceId: P, payload: { projectId: P, name: "Launch", status: "in_progress", leadAgentId: BB } }),
      ...issue({ id: I1, identifier: "LCH-1", assignee: BB, created: day(1), started: day(1, 1), review: day(1, 2), done: day(1, 3) }),
    ];
    const window = { from: day(1).toISOString(), to: day(2).toISOString() };
    const refs = accountableMilestoneRefs(rows, AG, window, n);
    expect(refs).toEqual([{ kind: "project", id: P }]);
    const ms = scoreMilestone(rows, refs[0]!, n, CO, { fallbackOpen: true });
    const citation = { kind: "project" as const, id: P, throughSeq: n, formulaVersion: FORMULA_VERSION, hash: cardHash(ms), fallbackOpen: true };
    const card = scoreAgent({ companyId: CO, agentId: AG, events: rows, throughSeq: n, asOf: day(2).toISOString(), window, dependencies: [{ citation, card: ms }] });
    const [result] = card.worker.acceptance.body.accountable;
    expect(result).toMatchObject({ ref: { kind: "project", id: P }, name: "Launch", citation });
    expect(result!.intervals).toEqual([{ role: "lead", from: day(1).toISOString(), to: day(1, 12).toISOString() }]);
    expect(result!.outcome.O1).toEqual(ms.outcome.O1);
    expect(card.replay.dependencies).toEqual([citation]);
    // a citation that does not match the recomputed card, or another cut, is refused
    expect(() => scoreAgent({ companyId: CO, agentId: AG, events: rows, throughSeq: n, asOf: day(2).toISOString(), window, dependencies: [{ citation: { ...citation, hash: "0".repeat(64) }, card: ms }] })).toThrow(/citation hash/);
    expect(() => scoreAgent({ companyId: CO, agentId: AG, events: rows, throughSeq: n, asOf: day(2).toISOString(), window, dependencies: [{ citation: { ...citation, throughSeq: n - 1 }, card: ms }] })).toThrow();
  });
});

describe("APM gate 3 (P3.3): calibration sample and reuse rule", () => {
  it("selects deterministically by hash(item, window.from), topped up to minPerWindow, plus disagreements and fatal flags", () => {
    const items = [uid(0xe01), uid(0xe02), uid(0xe03)];
    const make = (sampleRate: number, minPerWindow: number) => [
      agentSnap(AG, "Builder"),
      ...profile({ revisionId: REV1, at: day(0), contractId: uid(0xc1), responsibilities: [{ key: "work", obligation: { kind: "assigned" }, judges: { automated: [], human: { userId: JUDGE, sampleRate, minPerWindow } } }] }),
      ...items.flatMap((id, i) => [...issue({ id, identifier: `W-${i}`, assignee: AG, created: day(1), started: day(1, 1), review: day(1, 2), done: day(1, 3) }), mapping({ id: uid(0xe10 + i), issueId: id, key: "work", from: day(1) })]),
    ];
    const run1 = (sampleRate: number, minPerWindow: number) => {
      const events = make(sampleRate, minPerWindow);
      const contract = evaluationContractV2Schema.parse((events.find((e) => e.eventType === "contract.declared")!.payload as { contract: unknown }).contract);
      const card = score(events, { asOf: day(2), from: day(1) });
      return { card, sample: selectCalibrationSample(card, contract), contract };
    };
    let { card, sample, contract } = run1(0, 1);
    const lowest = [...items].sort((a, b) => calibrationSampleScore(a, day(1).toISOString()) - calibrationSampleScore(b, day(1).toISOString()))[0];
    expect(sample.map((x) => x.item.id)).toEqual([lowest]);
    expect(sample[0]).toMatchObject({ reason: "sample", routeToUserId: JUDGE, responsibilityKey: "work" });
    expect(card.worker.decisions.body.calibration.sampled).toBe(1);
    ({ card, sample, contract } = run1(1, 0));
    expect(sample.map((x) => x.item.id).sort()).toEqual([...items].sort());
    expect(sample.map((x) => x.key)).toEqual([...sample.map((x) => x.key)].sort());
    expect(selectCalibrationSample(card, contract)).toEqual(sample);
  });

  it("two cards equal apart from asOf and window are equivalent (the reuse rule); anything else is not", () => {
    const rows = threeDays();
    const a = score(rows, { asOf: day(3, 20), from: day(1), to: day(3, 20) });
    const b = score(rows, { asOf: day(3, 21), from: day(1, 0, 5), to: day(3, 21) });
    expect(agentCardHash(a)).not.toBe(agentCardHash(b));
    expect(agentCardsEquivalent(a, b)).toBe(true);
    const c = score(rows, { asOf: day(3, 10), from: day(1) }); // the third tick is still waiting: a different card
    expect(agentCardsEquivalent(a, c)).toBe(false);
  });
});

it("fixture sanity: every viewer projection keeps the base timeline untouched", () => {
  const rows = threeDays();
  const tl1 = buildTimeline(orderEvents(rows));
  score(rows, { asOf: day(3, 20), from: day(1) });
  const tl2 = buildTimeline(orderEvents(rows));
  expect(tl2.items.size).toBe(tl1.items.size);
});
