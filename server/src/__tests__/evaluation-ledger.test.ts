import { describe, expect, it } from "vitest";
import { EVALUATION_SKEW_TOLERANCE_MS } from "@paperclipai/shared";
import {
  canonicalJson,
  clampEventTime,
  compareEvents,
  dedupeKeyFor,
  hashCanonical,
  orderEvents,
} from "../services/evaluation/ledger.js";
import { extractHandoffPayloads } from "../services/evaluation/sources.js";
import { cardHash, projectMilestone, selectMilestoneEvents } from "../services/evaluation/replay.js";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";

// AgentDash: Company Evaluator — Milestone 1 unit tests for the pure ledger
// helpers (spec §8 rules 4–6, §11 replay order, §6 T2 parsing). No database.

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const GOAL = "33333333-3333-4333-8333-333333333333";

function row(partial: Partial<EvaluationEventRow> & { dedupeKey: string; eventTime: Date; ingestTime: Date }): EvaluationEventRow {
  return {
    id: partial.id ?? `id-${partial.dedupeKey}`,
    companyId: COMPANY,
    projectId: null,
    goalId: null,
    actorType: "agent",
    actorId: "agent-1",
    sourceTable: "activity_log",
    sourceId: "src",
    sourceVersion: "v",
    sourceRowHash: null,
    eventType: "issue.transition",
    schemaVersion: 1,
    payload: {},
    correlationId: null,
    ...partial,
  } as EvaluationEventRow;
}

describe("canonical JSON and hashing", () => {
  it("is key-order independent and stable across runs", () => {
    const a = canonicalJson({ b: 1, a: { d: [1, { z: 2, y: 1 }], c: "x" } });
    const b = canonicalJson({ a: { c: "x", d: [1, { y: 1, z: 2 }] }, b: 1 });
    expect(a).toBe(b);
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });

  it("drops undefined and serialises dates as ISO", () => {
    const d = new Date("2026-09-05T12:00:00.000Z");
    expect(canonicalJson({ a: undefined, d })).toBe('{"d":"2026-09-05T12:00:00.000Z"}');
  });
});

describe("dedupe key (rule 6)", () => {
  it("embeds the company so tenants never collide", () => {
    const base = { sourceTable: "issues", sourceId: "x", eventType: "issue.snapshot" as const, sourceVersion: "h" };
    expect(dedupeKeyFor({ companyId: COMPANY, ...base })).not.toBe(dedupeKeyFor({ companyId: GOAL, ...base }));
    expect(dedupeKeyFor({ companyId: COMPANY, ...base })).toBe(`${COMPANY}|issues|x|issue.snapshot|h`);
  });
});

describe("event-time clamping (rule 4)", () => {
  const arrival = new Date("2026-09-05T12:00:00.000Z");
  it("uses arrival when the claim is absent or later than arrival", () => {
    expect(clampEventTime(null, arrival)).toMatchObject({ eventTime: arrival, clamped: true, suspicious: false });
    expect(clampEventTime(new Date(arrival.getTime() + 60_000), arrival)).toMatchObject({ eventTime: arrival, clamped: true });
    expect(clampEventTime("not a date", arrival)).toMatchObject({ eventTime: arrival, clamped: true });
  });
  it("keeps an earlier claim inside the tolerance without suspicion", () => {
    const claimed = new Date(arrival.getTime() - 4 * 60_000);
    const r = clampEventTime(claimed, arrival);
    expect(r.eventTime).toEqual(claimed);
    expect(r.suspicious).toBe(false);
    expect(r.claimedEarlierByMs).toBe(4 * 60_000);
  });
  it("flags an earlier claim beyond the tolerance as a checkable claim", () => {
    const claimed = new Date(arrival.getTime() - (EVALUATION_SKEW_TOLERANCE_MS + 60_000));
    const r = clampEventTime(claimed, arrival);
    expect(r.eventTime).toEqual(claimed);
    expect(r.suspicious).toBe(true);
  });
});

describe("total order for replay (rule 5)", () => {
  const t0 = new Date("2026-09-05T12:00:00.000Z");
  it("orders by tolerance bucket, then ingest time, then dedupe key", () => {
    const a = row({ dedupeKey: "b", eventTime: new Date(t0.getTime() + 60_000), ingestTime: new Date(t0.getTime() + 10_000) });
    const b = row({ dedupeKey: "a", eventTime: new Date(t0.getTime() + 120_000), ingestTime: new Date(t0.getTime() + 10_000) });
    const c = row({ dedupeKey: "c", eventTime: new Date(t0.getTime() + 30_000), ingestTime: new Date(t0.getTime() + 20_000) });
    const d = row({ dedupeKey: "d", eventTime: new Date(t0.getTime() + EVALUATION_SKEW_TOLERANCE_MS * 3), ingestTime: t0 });
    // a, b, c share a bucket: ingest 10s (a,b) before 20s (c); a vs b by key → b("a") before a("b").
    const ordered = orderEvents([d, c, a, b]).map((r) => r.dedupeKey);
    expect(ordered).toEqual(["a", "b", "c", "d"]);
  });
  it("is a strict comparator (antisymmetric, transitive on equal buckets)", () => {
    const x = row({ dedupeKey: "x", eventTime: t0, ingestTime: t0 });
    const y = row({ dedupeKey: "y", eventTime: t0, ingestTime: t0 });
    expect(compareEvents(x, y)).toBeLessThan(0);
    expect(compareEvents(y, x)).toBeGreaterThan(0);
    expect(compareEvents(x, x)).toBe(0);
  });
  it("does not depend on input order", () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      row({ dedupeKey: `k${(i * 7) % 5}`, eventTime: new Date(t0.getTime() + (i % 3) * 1000), ingestTime: new Date(t0.getTime() + i) }),
    );
    const a = orderEvents(rows).map((r) => r.dedupeKey);
    const b = orderEvents([...rows].reverse()).map((r) => r.dedupeKey);
    expect(a).toEqual(b);
  });
});

describe("T2 handoff payload extraction", () => {
  it("accepts fenced JSON with `type` (as posted on the board) or `handoff_type` (per the MAW schema)", () => {
    const body = [
      "**PM Handoff** (pm_to_builder, 2026-09-01)",
      "",
      "```json",
      JSON.stringify({ type: "pm_to_builder", acceptance_criteria: ["a", "b"], size: "S" }),
      "```",
      "and later",
      "```",
      JSON.stringify({ handoff_type: "tpm_merge_report", pr: 603, merge_result: "merged" }),
      "```",
    ].join("\n");
    const found = extractHandoffPayloads(body);
    expect(found.map((f) => f.type)).toEqual(["pm_to_builder", "tpm_merge_report"]);
    expect(found[0]!.payload.acceptance_criteria).toEqual(["a", "b"]);
  });
  it("ignores prose, non-handoff JSON, arrays and broken JSON", () => {
    const body = "Review text mentioning \"handoff_type\" in prose.\n```json\n{\"type\":\"note\"}\n```\n```json\n[1,2]\n```\n```json\n{not json}\n```";
    expect(extractHandoffPayloads(body)).toEqual([]);
    expect(extractHandoffPayloads("no braces here")).toEqual([]);
  });
});

describe("milestone projection (spec §3 membership, §11 determinism)", () => {
  const t0 = new Date("2026-09-05T12:00:00.000Z");
  const events: EvaluationEventRow[] = [
    row({ id: "e1", dedupeKey: "1", eventTime: t0, ingestTime: t0, projectId: PROJECT, payload: { issueId: "i1" } }),
    row({ id: "e2", dedupeKey: "2", eventTime: new Date(t0.getTime() + 1000), ingestTime: t0, projectId: PROJECT, payload: { issueId: "i2" }, eventType: "run.finished", sourceTable: "heartbeat_runs" }),
    row({ id: "e3", dedupeKey: "3", eventTime: t0, ingestTime: t0, projectId: null, goalId: GOAL, payload: { issueId: "i3" } }),
    row({ id: "e4", dedupeKey: "4", eventTime: t0, ingestTime: t0, projectId: PROJECT, goalId: GOAL, payload: { issueId: "i4" } }),
  ];
  it("selects project members by projectId and goal-as-milestone members only when projectId is null", () => {
    expect(selectMilestoneEvents(events, { kind: "project", id: PROJECT }).map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
    expect(selectMilestoneEvents(events, { kind: "goal", id: GOAL }).map((e) => e.id)).toEqual(["e3"]);
  });
  it("produces the same card and hash regardless of input order, and carries markers", () => {
    const ref = { kind: "project" as const, id: PROJECT };
    const c1 = projectMilestone(events, ref, null, { openMilestone: true });
    const c2 = projectMilestone([...events].reverse(), ref, null, { openMilestone: true });
    expect(cardHash(c1)).toBe(cardHash(c2));
    expect(c1.eventCount).toBe(3);
    expect(c1.byType).toEqual({ "issue.transition": 2, "run.finished": 1 });
    expect(c1.issueIds).toEqual(["i1", "i2", "i4"]);
    expect(c1.markers).toEqual(["open milestone — denominators still moving"]);
    // e1, e2, e4 share one tolerance bucket and one ingest time, so the total
    // order is by dedupe key ("1","2","4"): the last event is e4 (rule 5).
    expect(c1.throughEventId).toBe("e4");
  });
  it("changes the hash when an event is added, and respects throughEventId", () => {
    const ref = { kind: "project" as const, id: PROJECT };
    const before = projectMilestone(events, ref, null);
    const more = [...events, row({ id: "e5", dedupeKey: "5", eventTime: new Date(t0.getTime() + 2000), ingestTime: t0, projectId: PROJECT, payload: { issueId: "i5" } })];
    const after = projectMilestone(more, ref, null);
    expect(cardHash(after)).not.toBe(cardHash(before));
    // Cutting at the original last event reproduces the original card exactly.
    const cut = projectMilestone(more, ref, "e4");
    expect(cardHash(cut)).toBe(cardHash(before));
    // Cutting earlier drops e4 and changes the card.
    expect(cardHash(projectMilestone(more, ref, "e2"))).not.toBe(cardHash(before));
  });
});
