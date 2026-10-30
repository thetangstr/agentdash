import { describe, expect, it } from "vitest";
import {
  buildAgentProfileDerived,
  deriveHeartbeat,
  matchPlanEntry,
  responsibilityKeys,
  type AgentProfileDerivedInput,
} from "../services/agent-profile-derived.js";

/**
 * AgentDash: APM gate 1 — the derived operating profile (revision 0) is a pure
 * function of today's records. Every field names its source or says it is
 * missing; gaps always name what no record supplies.
 */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-29T12:00:00.000Z");

function planPayload(overrides: Record<string, unknown> = {}) {
  return {
    rationale: "Grow pipeline",
    alignmentToShortTerm: "Q4 targets",
    alignmentToLongTerm: "Durable growth",
    agents: [
      { name: "Writer", role: "marketing", adapterType: "claude_local", responsibilities: ["Other duty"], kpis: ["Other KPI"] },
      {
        name: "Analyst",
        role: "research",
        adapterType: "claude_local",
        responsibilities: ["Weekly pipeline report", "  ", "Weekly pipeline report", "Flag churn risk"],
        kpis: ["Report on time", ""],
      },
    ],
    confirmedAt: "2026-10-01T00:00:00.000Z",
    confirmedAgentIds: [OTHER_ID, AGENT_ID],
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentProfileDerivedInput> = {}): AgentProfileDerivedInput {
  return {
    generatedAt: NOW,
    agent: {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Analyst",
      role: "research",
      title: "Pipeline Analyst",
      capabilities: "Reads CRM exports and writes summaries",
      reportsTo: OTHER_ID,
      adapterType: "claude_local",
      adapterConfig: { paperclipSkillSync: { desiredSkills: ["crm-read", "crm-read", "report-writer"] } },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: false } },
      defaultEnvironmentId: null,
    },
    reportsToAgent: { id: OTHER_ID, name: "Chief of Staff" },
    accountableUserId: "user-accountable",
    planCards: [{ messageId: "msg-plan", createdAt: new Date("2026-10-01T00:00:00.000Z"), payload: planPayload() }],
    enrollment: { id: "enr-1", objective: "Keep the pipeline honest", metrics: ["Weekly report shipped"], installedSkillKeys: ["installed-skill"] },
    routines: [
      {
        id: "routine-1",
        title: "Weekly pipeline report",
        status: "active",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        triggers: [
          {
            id: "trigger-1",
            kind: "schedule",
            enabled: true,
            cronExpression: "0 9 * * 1",
            timezone: "America/New_York",
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
      },
    ],
    model: "claude-sonnet",
    ...overrides,
  };
}

function gapCodes(profile: ReturnType<typeof buildAgentProfileDerived>) {
  return profile.gaps.map((gap) => gap.code);
}

describe("buildAgentProfileDerived", () => {
  it("derives a labelled starting point from the plan card, enrollment and agent row", () => {
    const profile = buildAgentProfileDerived(baseInput());

    expect(profile).toMatchObject({
      kind: "agent_profile_derived",
      version: "agent-profile-derived/0",
      derived: true,
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      generatedAt: NOW.toISOString(),
    });
    expect(profile.identity).toEqual({
      name: { value: "Analyst", provenance: "proposed", source: "agent.name" },
      title: { value: "Pipeline Analyst", provenance: "proposed", source: "agent.title" },
      role: { value: "research", provenance: "proposed", source: "agent.role" },
      summary: { value: "Reads CRM exports and writes summaries", provenance: "proposed", source: "agent.capabilities" },
    });
    expect(profile.objective).toEqual({ value: "Keep the pipeline honest", provenance: "proposed", source: "workforce_enrollment:enr-1" });

    // Position 1 in confirmedAgentIds is entry 1; blanks dropped, duplicate titles get distinct keys.
    expect(profile.responsibilities).toEqual([
      { key: "weekly-pipeline-report", title: "Weekly pipeline report", source: "plan_card:msg-plan", obligation: { kind: "unknown" } },
      { key: "weekly-pipeline-report-2", title: "Weekly pipeline report", source: "plan_card:msg-plan", obligation: { kind: "unknown" } },
      { key: "flag-churn-risk", title: "Flag churn risk", source: "plan_card:msg-plan", obligation: { kind: "unknown" } },
    ]);
    expect(profile.kpis).toEqual({ value: ["Report on time"], provenance: "proposed", source: "plan_card:msg-plan" });
    expect(profile.skills).toEqual({
      value: ["crm-read", "report-writer"],
      provenance: "proposed",
      source: "agent.adapterConfig.paperclipSkillSync.desiredSkills",
    });
    expect(profile.rhythm).toEqual({
      heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: false },
      routines: [
        {
          routineId: "routine-1",
          title: "Weekly pipeline report",
          status: "active",
          triggers: [{ id: "trigger-1", kind: "schedule", cronExpression: "0 9 * * 1", timezone: "America/New_York", enabled: true }],
        },
      ],
      reportsTo: { agentId: OTHER_ID, agentName: "Chief of Staff" },
      accountableUserId: "user-accountable",
    });
    expect(profile.runtime).toEqual({ adapterType: "claude_local", model: "claude-sonnet", environmentId: null });

    // A routine with the same title as a duty is NOT treated as its obligation: no record links them.
    expect(gapCodes(profile)).toEqual(["NO_STRUCTURED_OBLIGATIONS", "NO_CRITERIA", "NO_ACCESS_REQUEST", "NO_STYLE"]);
  });

  it("marks everything no record supplies as missing, and says there is no plan card", () => {
    const profile = buildAgentProfileDerived(
      baseInput({
        agent: { ...baseInput().agent, title: "  ", capabilities: null, reportsTo: null, adapterConfig: {}, runtimeConfig: {} },
        reportsToAgent: null,
        accountableUserId: null,
        planCards: [],
        enrollment: null,
        routines: [],
        model: null,
      }),
    );
    expect(profile.identity.title).toEqual({ value: null, provenance: "missing", source: null });
    expect(profile.identity.summary).toEqual({ value: null, provenance: "missing", source: null });
    expect(profile.objective).toEqual({ value: null, provenance: "missing", source: null });
    expect(profile.kpis).toEqual({ value: [], provenance: "missing", source: null });
    expect(profile.skills).toEqual({ value: [], provenance: "missing", source: null });
    expect(profile.responsibilities).toEqual([]);
    expect(profile.rhythm.heartbeat).toEqual({ enabled: false, intervalSec: null, wakeOnDemand: true });
    expect(profile.rhythm.reportsTo).toEqual({ agentId: null, agentName: null });
    expect(profile.rhythm.accountableUserId).toBeNull();
    expect(profile.runtime.model).toBeNull();
    expect(gapCodes(profile)).toEqual([
      "NO_PLAN_CARD",
      "NO_RESPONSIBILITIES",
      "NO_STRUCTURED_OBLIGATIONS",
      "NO_CRITERIA",
      "NO_ACCESS_REQUEST",
      "NO_STYLE",
    ]);
  });

  it("falls back to the enrollment's metrics and installed skills, citing the enrollment", () => {
    const profile = buildAgentProfileDerived(
      baseInput({ planCards: [], agent: { ...baseInput().agent, adapterConfig: {} } }),
    );
    expect(profile.kpis).toEqual({ value: ["Weekly report shipped"], provenance: "proposed", source: "workforce_enrollment:enr-1" });
    expect(profile.skills).toEqual({ value: ["installed-skill"], provenance: "proposed", source: "workforce_enrollment:enr-1" });
  });

  it("reports an ambiguous plan mapping instead of guessing, and uses none of its duties", () => {
    const profile = buildAgentProfileDerived(
      baseInput({ planCards: [{ messageId: "msg-short", createdAt: NOW, payload: planPayload({ confirmedAgentIds: [AGENT_ID] }) }] }),
    );
    expect(profile.responsibilities).toEqual([]);
    expect(profile.kpis.source).toBe("workforce_enrollment:enr-1");
    expect(gapCodes(profile)).toEqual([
      "AMBIGUOUS_PLAN_MAPPING",
      "NO_RESPONSIBILITIES",
      "NO_STRUCTURED_OBLIGATIONS",
      "NO_CRITERIA",
      "NO_ACCESS_REQUEST",
      "NO_STYLE",
    ]);
    const gap = profile.gaps.find((g) => g.code === "AMBIGUOUS_PLAN_MAPPING")!;
    expect(gap.message).toContain("msg-short");
    expect(gap.message).toContain("2 agent(s) but records 1 hired id(s)");
  });

  it("says the matched entry has no responsibilities when the card lists none", () => {
    const payload = planPayload();
    (payload.agents[1] as Record<string, unknown>).responsibilities = [];
    const profile = buildAgentProfileDerived(baseInput({ planCards: [{ messageId: "m", createdAt: NOW, payload }] }));
    expect(profile.gaps.find((g) => g.code === "NO_RESPONSIBILITIES")?.message).toContain("lists no responsibilities");
  });
});

describe("matchPlanEntry", () => {
  it("uses the newest card only", () => {
    const older = { messageId: "old", createdAt: new Date("2026-01-01"), payload: planPayload() };
    const newer = { messageId: "new", createdAt: new Date("2026-02-01"), payload: planPayload({ confirmedAgentIds: [AGENT_ID, OTHER_ID] }) };
    const match = matchPlanEntry([newer, older], AGENT_ID);
    expect(match).toMatchObject({ kind: "matched", messageId: "new", index: 0, responsibilities: ["Other duty"] });
  });

  it("is ambiguous when the id repeats, and none when the card does not name the agent", () => {
    expect(matchPlanEntry([{ messageId: "m", createdAt: NOW, payload: planPayload({ confirmedAgentIds: [AGENT_ID, AGENT_ID] }) }], AGENT_ID))
      .toMatchObject({ kind: "ambiguous", reason: "the card lists this agent's id more than once" });
    expect(matchPlanEntry([{ messageId: "m", createdAt: NOW, payload: planPayload({ confirmedAgentIds: [OTHER_ID, OTHER_ID] }) }], AGENT_ID))
      .toEqual({ kind: "none" });
    expect(matchPlanEntry([{ messageId: "m", createdAt: NOW, payload: "not an object" }], AGENT_ID)).toEqual({ kind: "none" });
    expect(matchPlanEntry([], AGENT_ID)).toEqual({ kind: "none" });
  });
});

describe("responsibilityKeys and deriveHeartbeat", () => {
  it("slugs titles stably and falls back for titles with no slug characters", () => {
    expect(responsibilityKeys(["Ship the Deck!", "ship the deck", "Ünïcode café", "—"])).toEqual([
      "ship-the-deck",
      "ship-the-deck-2",
      "unicode-cafe",
      "responsibility",
    ]);
  });

  it("reads the heartbeat with the scheduler's defaults and the legacy wake key", () => {
    expect(deriveHeartbeat({ runtimeConfig: { heartbeat: { intervalSec: -5, wakeOnAssignment: false } } })).toEqual({
      enabled: false,
      intervalSec: 0,
      wakeOnDemand: false,
    });
    expect(deriveHeartbeat({ runtimeConfig: { heartbeat: { intervalSec: "600" } } }).intervalSec).toBeNull();
  });
});
