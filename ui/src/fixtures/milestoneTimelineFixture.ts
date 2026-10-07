// AgentDash: a small `ac.milestone-timeline/v1` document in the harness's
// exact shape (RunTimeline in the ac_travel_mvp repo), used by unit tests, the
// run-transcript UX lab and the business-view e2e spec. Hand-written and
// fictional; no real run data.

export const SAMPLE_TIMELINE_RUN_ID = "5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
export const SAMPLE_TIMELINE_COMPANY_ID = "c0ffee00-0000-4000-8000-000000000001";

function event(
  id: string,
  ts: string,
  lane: "agency" | "traveler",
  milestone: string,
  kind: string,
  summary: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    ts,
    lane,
    actor: lane,
    kind,
    milestone,
    basis: "exact",
    summary,
    source: lane === "agency" ? { file: "agency-run-log.ndjson", ref: `seq=${extra.seq ?? 1}` } : { file: "front-door.ndjson", ref: `line=${id}` },
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "seq")),
  };
}

function planned(runId: string, index: number, milestone: string) {
  return {
    status: "not-yet-logged",
    assetReferenceId: `ac-milestone:${runId}:${index}-${milestone}`,
    subjectDigest: "0x" + "0".repeat(64),
    payload: {},
    coveredBy: [],
  };
}

export const SAMPLE_MILESTONE_TIMELINE = {
  schema: "ac.milestone-timeline/v1",
  label: "Tanaka family, Kyoto 5 nights",
  runId: "p9-sample-2026-10-06-1",
  pairingId: "pairing-sample",
  level: "L",
  terminal: "settled",
  traveler: { kind: "claude.ai", runtime: null, modelId: null, mode: "demo" },
  agency: { runtime: "hermes", modelId: null, company: "Sample Travel", agent: "Maya", agentdash: null },
  agentdash: {
    companyId: SAMPLE_TIMELINE_COMPANY_ID,
    agentId: "a9e1b2c3-0000-4000-8000-000000000002",
    heartbeatRunId: SAMPLE_TIMELINE_RUN_ID,
    issueId: "i5500000-0000-4000-8000-000000000003",
  },
  startedAt: "2026-10-06T09:00:00.000Z",
  endedAt: "2026-10-06T09:06:30.000Z",
  milestones: [
    {
      milestone: "discover",
      label: "Discover",
      firstTs: "2026-10-06T09:00:00.000Z",
      lastTs: "2026-10-06T09:01:00.000Z",
      total: 3,
      log: { ...planned("p9", 1, "discover"), status: "anchored", ledgerId: "ledger-77", blockHeight: 1203 },
    },
    { milestone: "proposal", label: "Proposal", firstTs: null, lastTs: null, total: 2, log: planned("p9", 2, "proposal") },
    { milestone: "negotiation", label: "Negotiation", firstTs: null, lastTs: null, total: 2, log: planned("p9", 3, "negotiation") },
    { milestone: "agreement", label: "Agreement", firstTs: null, lastTs: null, total: 1, log: planned("p9", 4, "agreement") },
    { milestone: "execution", label: "Execution", firstTs: null, lastTs: null, total: 1, log: planned("p9", 5, "execution") },
    { milestone: "settlement", label: "Settlement", firstTs: null, lastTs: null, total: 1, log: planned("p9", 6, "settlement") },
  ],
  events: [
    event("t-0", "2026-10-06T09:00:00.000Z", "traveler", "discover", "tool-call", "The family's assistant searched for agencies that serve Kyoto", { tool: "search_agencies" }),
    event("a-1", "2026-10-06T09:00:20.000Z", "agency", "discover", "server-receipt", "Handshake with the family's assistant confirmed", { seq: 3, tool: "handshake_join" }),
    event("a-2", "2026-10-06T09:00:40.000Z", "agency", "discover", "narration", "I'll confirm their spending limit before quoting anything.", { seq: 4, basis: "inferred", subtype: "message" }),
    event("a-3", "2026-10-06T09:01:30.000Z", "agency", "proposal", "tool-call", "Quoted a 5-night Kyoto ryokan package at $4,180", {
      seq: 7,
      tool: "offer_submit",
      detail: "Ryokan Hanaya, 2 rooms, breakfast included. Fares are SIMULATED.",
      simulated: "SIMULATED",
    }),
    event("t-1", "2026-10-06T09:02:00.000Z", "traveler", "negotiation", "tool-call", "The family asked for a lower price", { tool: "offer_counter" }),
    event("a-4", "2026-10-06T09:02:30.000Z", "agency", "negotiation", "server-receipt", "Counter-offer below the floor price was refused", {
      seq: 9,
      tool: "offer_submit",
      outcome: "refused",
    }),
    event("a-5", "2026-10-06T09:03:00.000Z", "agency", "negotiation", "tool-call", "Offered $3,950 with a late checkout", { seq: 11, tool: "offer_submit" }),
    event("a-6", "2026-10-06T09:04:00.000Z", "agency", "agreement", "signer-decision", "Agency signer approved the agreed terms", { seq: 13, subtype: "agreement" }),
    event("a-7", "2026-10-06T09:05:00.000Z", "agency", "execution", "server-receipt", "Booking made", {
      seq: 15,
      tool: "booking_execute",
      simulated: "SIMULATED",
    }),
    event("a-8", "2026-10-06T09:06:30.000Z", "agency", "settlement", "server-receipt", "Payment of $3,950 authorised", {
      seq: 18,
      tool: "settlement_authorize",
      simulated: "Stripe TEST mode",
    }),
  ],
  clockchain: {
    milestoneLog: "not-yet-logged",
    existingAnchors: [
      {
        id: "cc-0",
        ts: "2026-10-06T09:00:25.000Z",
        lane: "traveler",
        actor: "clockchain",
        kind: "clockchain-anchor",
        milestone: "discover",
        basis: "exact",
        summary: "Handshake host anchored the handshake certificate (block 998)",
        source: { file: "bundle.json#handshakeCertificate.result.anchors", ref: "ledgerId=ledger-12" },
        ids: { ledgerId: "ledger-12", digest: "0xabc", blockHeight: "998" },
      },
    ],
    identityRegistrations: [],
  },
  honesty: [
    "Ticketing and fares are SIMULATED; payment runs on Stripe TEST mode (no real money).",
    "Narration milestones are inferred from the agent's nearest tool call.",
  ],
} as const;
