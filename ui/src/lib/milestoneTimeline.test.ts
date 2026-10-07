import { describe, expect, it } from "vitest";
import {
  extractTimelineJson,
  milestoneTimelineDocumentKey,
  parseMilestoneTimeline,
  parseSourceSeq,
  timelineMatchesRun,
  timelineSchemaMajor,
  timelineSimulatedLabels,
  TIMELINE_MILESTONES,
} from "./milestoneTimeline";
import { issueDocumentKeySchema, normalizeEscapedLineBreaks } from "@paperclipai/shared";
import realArtefact from "../fixtures/milestone-timeline-p9-at-2026-10-06-4.trimmed.json";
import { SAMPLE_MILESTONE_TIMELINE, SAMPLE_TIMELINE_RUN_ID } from "../fixtures/milestoneTimelineFixture";

const RUN_ID = SAMPLE_TIMELINE_RUN_ID;

function parsed(input: unknown) {
  const result = parseMilestoneTimeline(input);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  return result.timeline;
}

describe("milestone timeline document key", () => {
  it("is milestone-timeline-<runId> and passes the issue document key rule", () => {
    const key = milestoneTimelineDocumentKey(RUN_ID.toUpperCase());
    expect(key).toBe(`milestone-timeline-${RUN_ID}`);
    expect(issueDocumentKeySchema.safeParse(key).success).toBe(true);
  });
});

describe("parseMilestoneTimeline", () => {
  it("accepts a v1 timeline and keeps the taxonomy order", () => {
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    expect(timeline.schema).toBe("ac.milestone-timeline/v1");
    expect(timeline.milestones.map((m) => m.milestone)).toEqual([...TIMELINE_MILESTONES]);
    expect(timeline.milestones.map((m) => m.label)).toEqual([
      "Discover",
      "Proposal",
      "Negotiation",
      "Agreement",
      "Execution",
      "Settlement",
    ]);
    expect(timeline.events.length).toBeGreaterThan(0);
    expect(timeline.droppedEvents).toBe(0);
    expect(timeline.agentdash?.heartbeatRunId).toBe(RUN_ID);
  });

  it("accepts the JSON as a string, bare or in a ```json fence", () => {
    const json = JSON.stringify(SAMPLE_MILESTONE_TIMELINE);
    expect(parseMilestoneTimeline(json).ok).toBe(true);
    expect(parseMilestoneTimeline("```json\n" + json + "\n```\n").ok).toBe(true);
    expect(extractTimelineJson("not json at all")).toBeUndefined();
    expect(parseMilestoneTimeline("not json at all")).toMatchObject({ ok: false, reason: "not-json" });
  });

  it("rejects an unknown major version so the page falls back", () => {
    const result = parseMilestoneTimeline({ ...SAMPLE_MILESTONE_TIMELINE, schema: "ac.milestone-timeline/v2" });
    expect(result).toMatchObject({ ok: false, reason: "unsupported-version" });
    expect(timelineSchemaMajor("ac.milestone-timeline/v1.3")).toBe(1);
    expect(parseMilestoneTimeline({ ...SAMPLE_MILESTONE_TIMELINE, schema: "something-else/v1" })).toMatchObject({
      ok: false,
      reason: "not-a-timeline",
    });
  });

  it("ignores additive unknown fields", () => {
    const timeline = parsed({
      ...SAMPLE_MILESTONE_TIMELINE,
      futureField: { anything: true },
      events: SAMPLE_MILESTONE_TIMELINE.events.map((event) => ({ ...event, newHint: "x" })),
    });
    expect(timeline.events.length).toBe(SAMPLE_MILESTONE_TIMELINE.events.length);
  });

  it("preserves the simulated label verbatim", () => {
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    const settlement = timeline.events.find((e) => e.milestone === "settlement" && e.lane === "agency");
    expect(settlement?.simulated).toBe("Stripe TEST mode");
    expect(timelineSimulatedLabels(timeline)).toEqual(expect.arrayContaining(["SIMULATED", "Stripe TEST mode"]));
    const fromBoolean = parsed({
      ...SAMPLE_MILESTONE_TIMELINE,
      events: [{ ...SAMPLE_MILESTONE_TIMELINE.events[0], simulated: true }],
    });
    expect(fromBoolean.events[0]!.simulated).toBe("SIMULATED");
  });

  it("flags inferred milestones", () => {
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    const narration = timeline.events.find((e) => e.basis === "inferred");
    expect(narration?.inferred).toBe(true);
    expect(timeline.events.filter((e) => e.basis !== "inferred").every((e) => !e.inferred)).toBe(true);
  });

  it("reads seq=<n> source refs as links into the run log", () => {
    expect(parseSourceSeq("seq=42")).toBe(42);
    expect(parseSourceSeq("digest=0xabc")).toBeNull();
    expect(parseSourceSeq(undefined)).toBeNull();
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    const agency = timeline.events.filter((e) => e.lane === "agency");
    expect(agency.some((e) => e.sourceSeq !== null)).toBe(true);
  });

  it("keeps outcomes and drops malformed events instead of failing the whole timeline", () => {
    const timeline = parsed({
      ...SAMPLE_MILESTONE_TIMELINE,
      events: [
        ...SAMPLE_MILESTONE_TIMELINE.events,
        { id: "bad", lane: "agency", kind: "tool-call", milestone: "not-a-stage", summary: "?" },
        "nope",
      ],
    });
    expect(timeline.droppedEvents).toBe(2);
    expect(timeline.events.some((e) => e.outcome === "refused")).toBe(true);
  });

  it("reads Clockchain status and ledger ids without calling Clockchain", () => {
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    const discover = timeline.milestones.find((m) => m.milestone === "discover");
    expect(discover?.log).toEqual({ status: "anchored", ledgerId: "ledger-77", blockHeight: "1203", coveredBy: [] });
    expect(timeline.milestones.find((m) => m.milestone === "proposal")?.log?.status).toBe("not-yet-logged");
    expect(timeline.anchors[0]).toMatchObject({ milestone: "discover", ledgerId: "ledger-12", blockHeight: "998" });
  });
});

describe("timelineMatchesRun", () => {
  it("matches by heartbeatRunId and company, and tolerates missing keys", () => {
    const timeline = parsed(SAMPLE_MILESTONE_TIMELINE);
    const companyId = timeline.agentdash!.companyId!;
    expect(timelineMatchesRun(timeline, { id: RUN_ID, companyId })).toBe(true);
    expect(timelineMatchesRun(timeline, { id: "11111111-1111-4111-8111-111111111111", companyId })).toBe(false);
    expect(timelineMatchesRun(timeline, { id: RUN_ID, companyId: "other" })).toBe(false);
    // A timeline must name its run: no join key, no timeline.
    expect(timelineMatchesRun({ ...timeline, agentdash: null }, { id: RUN_ID, companyId })).toBe(false);
    expect(
      timelineMatchesRun({ ...timeline, agentdash: { ...timeline.agentdash!, heartbeatRunId: null } }, { id: RUN_ID, companyId }),
    ).toBe(false);
  });

  it("reads join keys from agency.agentdash too", () => {
    const { agentdash, ...rest } = SAMPLE_MILESTONE_TIMELINE;
    const timeline = parsed({ ...rest, agency: { runtime: "hermes", agentdash } });
    expect(timeline.agentdash?.heartbeatRunId).toBe(RUN_ID);
  });
});

// AgentDash (PR #1059 review): a real Track C artefact (ac_travel_mvp
// f869eeeb, p9-at-2026-10-06-4, trimmed to 47 events, usernames scrubbed).
describe("real Track C artefact", () => {
  const REAL_RUN = realArtefact.agency.agentdash.heartbeatRunId;
  const REAL_COMPANY = realArtefact.agency.agentdash.companyId;
  const plain = JSON.stringify(realArtefact);

  it("has multi-line strings, so it exercises the newline escapes", () => {
    expect(plain).toContain("\\n");
  });

  it("survives the issue-document PUT normalizer, fenced or bare, and parses", () => {
    for (const body of ["```json\n" + plain + "\n```", plain, JSON.stringify(realArtefact, null, 2)]) {
      const stored = normalizeEscapedLineBreaks(body);
      const result = parseMilestoneTimeline(stored);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.timeline.events).toHaveLength(realArtefact.events.length);
      expect(result.timeline.droppedEvents).toBe(0);
      expect(timelineMatchesRun(result.timeline, { id: REAL_RUN, companyId: REAL_COMPANY })).toBe(true);
      const multiLine = result.timeline.events.find((e) => e.detail?.includes("\n"));
      expect(multiLine).toBeTruthy();
    }
  });

  it("repairs a document stored by the old normalizer (raw line breaks inside strings)", () => {
    const oldNormalizer = (v: string) => v.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
    const stored = oldNormalizer("```json\n" + plain + "\n```");
    expect(() => JSON.parse(stored.slice(8, -4))).toThrow();
    const result = parseMilestoneTimeline(stored);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.timeline.events).toHaveLength(realArtefact.events.length);
  });

  it("reads the real Clockchain shape: not-yet-logged with coveredBy, anchors with ledger and block", () => {
    const result = parseMilestoneTimeline(plain);
    if (!result.ok) throw new Error(result.detail);
    const discover = result.timeline.milestones[0]!;
    expect(discover.log?.status).toBe("not-yet-logged");
    expect(discover.log?.ledgerId).toBeNull();
    expect(discover.log?.coveredBy.length).toBeGreaterThan(0);
    expect(discover.log?.coveredBy[0]).not.toMatch(/^ledger:/);
    expect(result.timeline.anchors[0]?.blockHeight).toMatch(/^\d+$/);
    expect(result.timeline.events.some((e) => e.simulated)).toBe(true);
  });
});

describe("harness text redaction", () => {
  it("redacts secrets in summary, detail and honesty", () => {
    const secret = "SUPERSECRETvalue123";
    const result = parseMilestoneTimeline({
      ...SAMPLE_MILESTONE_TIMELINE,
      honesty: [`token=${secret}`],
      events: [{ ...SAMPLE_MILESTONE_TIMELINE.events[1], summary: `api_key=${secret}`, detail: `Bearer ${secret}` }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
