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
import { allowlistHandoffPayload, extractHandoffPayloads, keysetRead } from "../services/evaluation/sources.js";
import {
  cardHash,
  isRetrospective,
  MARKER_OPEN_MILESTONE,
  MARKER_RETROSPECTIVE,
  projectMilestone,
  selectMilestoneEvents,
} from "../services/evaluation/replay.js";
import type { EvaluationEventRow } from "../services/evaluation/ledger.js";

// AgentDash: Company Evaluator — Milestone 1 unit tests for the pure ledger
// helpers (spec §8 rules 4–6, §11 replay order and window, §6 T2 parsing). No database.

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const GOAL = "33333333-3333-4333-8333-333333333333";

function row(partial: Partial<EvaluationEventRow> & { seq: number; dedupeKey: string; eventTime: Date; ingestTime: Date }): EvaluationEventRow {
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
  it("escapes the separator so a version containing it cannot alias another key", () => {
    const a = dedupeKeyFor({ companyId: COMPANY, sourceTable: "t", sourceId: "a|b", eventType: "issue.snapshot", sourceVersion: "c" });
    const b = dedupeKeyFor({ companyId: COMPANY, sourceTable: "t", sourceId: "a", eventType: "issue.snapshot", sourceVersion: "b|c" });
    expect(a).not.toBe(b);
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

describe("total order inside a window (rule 5)", () => {
  const t0 = new Date("2026-09-05T12:00:00.000Z");
  it("orders by tolerance bucket, then ingest time, then dedupe key", () => {
    const a = row({ seq: 1, dedupeKey: "b", eventTime: new Date(t0.getTime() + 60_000), ingestTime: new Date(t0.getTime() + 10_000) });
    const b = row({ seq: 2, dedupeKey: "a", eventTime: new Date(t0.getTime() + 120_000), ingestTime: new Date(t0.getTime() + 10_000) });
    const c = row({ seq: 3, dedupeKey: "c", eventTime: new Date(t0.getTime() + 30_000), ingestTime: new Date(t0.getTime() + 20_000) });
    const d = row({ seq: 4, dedupeKey: "d", eventTime: new Date(t0.getTime() + EVALUATION_SKEW_TOLERANCE_MS * 3), ingestTime: t0 });
    expect(orderEvents([d, c, a, b]).map((r) => r.dedupeKey)).toEqual(["a", "b", "c", "d"]);
  });
  it("is a strict comparator", () => {
    const x = row({ seq: 1, dedupeKey: "x", eventTime: t0, ingestTime: t0 });
    const y = row({ seq: 2, dedupeKey: "y", eventTime: t0, ingestTime: t0 });
    expect(compareEvents(x, y)).toBeLessThan(0);
    expect(compareEvents(y, x)).toBeGreaterThan(0);
    expect(compareEvents(x, x)).toBe(0);
  });
  it("does not depend on input order", () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      row({ seq: i, dedupeKey: `k${(i * 7) % 5}`, eventTime: new Date(t0.getTime() + (i % 3) * 1000), ingestTime: new Date(t0.getTime() + i) }),
    );
    expect(orderEvents(rows).map((r) => r.dedupeKey)).toEqual(orderEvents([...rows].reverse()).map((r) => r.dedupeKey));
  });
});

describe("T2 handoff payload extraction and allowlisting", () => {
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
  it("keeps the schema's structured fields and drops prose (D4-A)", () => {
    const { kept, droppedKeys } = allowlistHandoffPayload("pm_to_builder", {
      type: "pm_to_builder",
      acceptance_criteria: ["works"],
      size: "S",
      test_plan: "long prose here",
      implementation_notes: "more prose",
      user_stories: ["as a user…"],
      timestamp: "2026-09-01T00:00:00Z",
    });
    expect(Object.keys(kept).sort()).toEqual(["acceptance_criteria", "size", "timestamp"]);
    expect(droppedKeys).toEqual(["implementation_notes", "test_plan", "user_stories"]);
  });
});

describe("milestone projection (spec §3 membership, §11 window and determinism)", () => {
  const t0 = new Date("2026-09-05T12:00:00.000Z");
  const events: EvaluationEventRow[] = [
    row({ id: "e1", seq: 1, dedupeKey: "1", eventTime: t0, ingestTime: t0, projectId: PROJECT, payload: { issueId: "i1" } }),
    row({ id: "e2", seq: 2, dedupeKey: "2", eventTime: new Date(t0.getTime() + 1000), ingestTime: t0, projectId: PROJECT, payload: { issueId: "i2" }, eventType: "run.finished", sourceTable: "heartbeat_runs" }),
    row({ id: "e3", seq: 3, dedupeKey: "3", eventTime: t0, ingestTime: t0, projectId: null, goalId: GOAL, payload: { issueId: "i3" } }),
    row({ id: "e4", seq: 4, dedupeKey: "4", eventTime: t0, ingestTime: t0, projectId: PROJECT, goalId: GOAL, payload: { issueId: "i4" } }),
  ];
  const ref = { kind: "project" as const, id: PROJECT };
  const state = { open: true, retrospective: false };

  it("selects project members by projectId and goal-as-milestone members only when projectId is null", () => {
    expect(selectMilestoneEvents(events, ref).map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
    expect(selectMilestoneEvents(events, { kind: "goal", id: GOAL }).map((e) => e.id)).toEqual(["e3"]);
  });

  it("produces the same card and hash regardless of input order, and carries derived markers", () => {
    const c1 = projectMilestone(events, ref, 4, state);
    const c2 = projectMilestone([...events].reverse(), ref, 4, state);
    expect(cardHash(c1)).toBe(cardHash(c2));
    expect(c1.eventCount).toBe(3);
    expect(c1.byType).toEqual({ "issue.transition": 2, "run.finished": 1 });
    expect(c1.issueIds).toEqual(["i1", "i2", "i4"]);
    expect(c1.markers).toContain(MARKER_OPEN_MILESTONE);
    expect(c1.throughSeq).toBe(4);
    // e1, e2, e4 share one tolerance bucket and one ingest time → ordered by dedupe key; last is e4.
    expect(c1.throughEventId).toBe("e4");
    const c3 = projectMilestone(events, ref, 4, { open: false });
    expect(c3.markers).not.toContain(MARKER_OPEN_MILESTONE); // retrospective is derived from the window, never supplied
    expect(cardHash(c3)).not.toBe(cardHash(c1));
  });

  it("is pinned by seq: a later-inserted but earlier-dated event cannot change a stored window (A2)", () => {
    const before = projectMilestone(events, ref, 4, state);
    const backdated = row({
      id: "e5",
      seq: 5,
      dedupeKey: "5",
      eventTime: new Date("2020-01-01T00:00:00.000Z"),
      ingestTime: new Date(t0.getTime() + 60_000),
      projectId: PROJECT,
      payload: { issueId: "i5" },
      eventType: "handoff.tpm_merge_report",
    });
    const more = [...events, backdated];
    expect(cardHash(projectMilestone(more, ref, 4, state))).toBe(cardHash(before));
    expect(cardHash(projectMilestone(more, ref, 5, state))).not.toBe(cardHash(before));
  });

  it("projects an empty milestone deterministically at any cut (A3)", async () => {
    const empty = projectMilestone(events, { kind: "project", id: GOAL }, 4, state);
    expect(empty.eventCount).toBe(0);
    expect(empty.membership.items).toBe(0);
    expect(empty.throughEventId).toBeNull();
    // the same window in any input order yields the same bytes; the card is a function of the whole company window (asOf, sources), not only of the milestone's events
    expect(cardHash(projectMilestone([...events].reverse(), { kind: "project", id: GOAL }, 4, state))).toBe(cardHash(empty));
    expect(cardHash(projectMilestone(events, { kind: "project", id: GOAL }, 3, state))).not.toBe(cardHash(empty));
  });
});

describe("retrospective detection (spec §4.6)", () => {
  const t0 = new Date("2026-09-05T12:00:00.000Z");
  it("is retrospective when the milestone's records predate the first ingest by more than a day", () => {
    const old = row({ seq: 1, dedupeKey: "a", eventTime: new Date("2026-08-01T00:00:00Z"), ingestTime: t0, projectId: PROJECT });
    expect(isRetrospective([old], [old])).toBe(true);
    const recent = row({ seq: 2, dedupeKey: "b", eventTime: new Date(t0.getTime() - 3600_000), ingestTime: t0, projectId: PROJECT });
    expect(isRetrospective([recent], [recent])).toBe(false);
    expect(isRetrospective([], [])).toBe(false);
  });
});

describe("keysetRead (two-part cursor read)", () => {
  type Row = { id: string; cursorTime: string };
  it("reads progress forwards after the cursor, re-reads the lag window backwards from it, dedupes by row key, and advances the cursor from progress only", async () => {
    const calls: Array<{ predicate: boolean; take: number; direction: string }> = [];
    const run = async (predicate: unknown, take: number, direction: "asc" | "desc"): Promise<Row[]> => {
      calls.push({ predicate: !!predicate, take, direction });
      return direction === "asc" ? [{ id: "b", cursorTime: "t2" }, { id: "c", cursorTime: "t3" }] : [{ id: "b", cursorTime: "t2" }, { id: "a", cursorTime: "t1" }];
    };
    const r = await keysetRead({ time: "2026-09-05 10:00:00+00", id: "00000000-0000-4000-8000-000000000001" }, 2, {}, {}, run, (x) => x.id);
    expect(calls).toEqual([
      { predicate: true, take: 2, direction: "asc" },
      { predicate: true, take: 2, direction: "desc" },
    ]);
    expect(r.rows.map((x) => x.id)).toEqual(["b", "c", "a"]); // lag row "b" already seen
    expect(r.scanned).toBe(2);
    expect(r.nextCursor).toEqual({ time: "t3", id: "c" });
  });
  it("the first read has no predicate and no lag query; an empty progress read leaves the cursor where it was", async () => {
    const calls: string[] = [];
    const empty = async (_p: unknown, _t: number, direction: "asc" | "desc"): Promise<Row[]> => {
      calls.push(direction);
      return [];
    };
    const first = await keysetRead({}, 10, {}, {}, empty, (x) => x.id);
    expect(calls).toEqual(["asc"]);
    expect(first.nextCursor).toEqual({});
    calls.length = 0;
    const later = await keysetRead({ time: "t9", id: "00000000-0000-4000-8000-000000000009" }, 10, {}, {}, empty, (x) => x.id);
    expect(calls).toEqual(["asc", "desc"]);
    expect(later.scanned).toBe(0);
    expect(later.nextCursor).toEqual({ time: "t9", id: "00000000-0000-4000-8000-000000000009" });
  });
});
