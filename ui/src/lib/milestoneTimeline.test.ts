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
import { issueDocumentKeySchema } from "@paperclipai/shared";
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
    expect(discover?.log).toEqual({ status: "anchored", ledgerId: "ledger-77", blockHeight: "1203" });
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
    expect(timelineMatchesRun({ ...timeline, agentdash: null }, { id: "anything", companyId: "x" })).toBe(true);
  });

  it("reads join keys from agency.agentdash too", () => {
    const { agentdash, ...rest } = SAMPLE_MILESTONE_TIMELINE;
    const timeline = parsed({ ...rest, agency: { runtime: "hermes", agentdash } });
    expect(timeline.agentdash?.heartbeatRunId).toBe(RUN_ID);
  });
});
