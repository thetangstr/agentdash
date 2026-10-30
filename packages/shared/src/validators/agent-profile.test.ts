import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  agentOperatingProfileV1Schema,
  agentProfileChangePayloadSchema,
  agentProfileProvenanceMapSchema,
  canonicalProfileJson,
  agentProfileDiffEntrySchema,
  diffProfiles,
  findProfileResponsibility,
  findResponsibilityByRoutineTrigger,
  mapIssueResponsibilitySchema,
  profileBodyHash,
  profileResponsibilityKeys,
  updateAgentAccessEnforcementSchema,
  type AgentOperatingProfileV1,
} from "./agent-profile.js";
import {
  evaluationContractV1Schema,
  evaluationContractV2Schema,
  evaluationContractVersionOf,
  evaluationSubjectRefSchema,
} from "../evaluation.js";
import type { AgentAccessPolicy } from "../types/agent-governance.js";
import type { AgentProfileChangePayload } from "../types/agent-profile.js";

// AgentDash: Agent Performance Management gate 2 — the operating profile (overview LLD §3–4).

const COMPANY = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-00000000000a";
const TRIGGER = "00000000-0000-4000-8000-0000000000f1";
const GOAL = "00000000-0000-4000-8000-0000000000e1";
const REVISION = "00000000-0000-4000-8000-0000000000d1";

function profile(): AgentOperatingProfileV1 {
  return {
    profileVersion: 1,
    identity: {
      name: "Weekly Reporter",
      title: "Reporting analyst",
      summary: "Writes the weekly pipeline report.",
      audience: "Sales leadership",
      style: { tone: "Plain and brief", uncertaintyRule: "Say what is unknown and why" },
    },
    responsibilities: [
      {
        key: "weekly-report",
        title: "Weekly pipeline report",
        outcome: "Leadership sees the pipeline every Monday",
        notOwned: ["Forecast sign-off"],
        stakeholders: [{ userId: "user-vp", need: "A Monday summary" }],
        obligation: { kind: "routine", routineTriggerId: TRIGGER },
        deliverable: { what: "A one-page report", destination: "The #pipeline issue" },
        escalation: { toUserId: "user-vp", when: "Data is missing by Monday 9:00" },
        performance: {
          criteria: [
            { id: "c1", text: "Report shipped", check: { kind: "record", record: "deliverable.shipped" }, source: "human" },
            { id: "c2", text: "Numbers reconcile with the CRM", source: "human" },
          ],
          coverage: ["deliverable_shipped", "human_acceptance"],
          deadline: { kind: "after_trigger", hours: 4 },
          outcomeLinks: [{ goalId: GOAL }],
          expectedHumanSteps: ["sign_off"],
          judges: { automated: ["independent_agent"], human: { userId: "user-vp", sampleRate: 0.25, minPerWindow: 1 } },
          thresholds: null,
        },
      },
      {
        key: "ad-hoc",
        title: "Ad-hoc questions",
        outcome: "Answers within a day",
        stakeholders: [],
        obligation: { kind: "assigned" },
        deliverable: { what: "An answer on the issue", destination: "The issue" },
        escalation: { when: "Blocked for more than a day" },
        performance: { criteria: [], coverage: [], outcomeLinks: [], expectedHumanSteps: [], judges: { automated: [] } },
      },
    ],
    knowledge: [{ source: "CRM pipeline", kind: "connection" }],
    skills: ["reporting", "crm-read"],
    access: {
      permissions: ["tasks:assign"],
      monthlyBudgetCents: 10000,
      destructiveActions: "approval_required",
      dataScopes: ["*"],
      providers: ["*"],
      minimumApproval: "steward",
      policyVersion: 2,
      do: { skills: { mode: "listed", ids: ["reporting", "crm-read"] } },
      talk: { agents: { mode: "reports_chain", via: ["assign", "mention"] } },
    },
    rhythm: { timezone: "America/New_York", reportTo: { userId: "user-vp" }, reportCadence: "weekly" },
  };
}

describe("agentOperatingProfileV1Schema", () => {
  it("round-trips a full profile, including through JSON", () => {
    const body = profile();
    expect(agentOperatingProfileV1Schema.parse(body)).toEqual(body);
    expect(agentOperatingProfileV1Schema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });

  it("is assignable to the V2 access policy type (compile-time)", () => {
    const access: AgentAccessPolicy = profile().access;
    expect(access.policyVersion).toBe(2);
  });

  const rejects: Array<[string, (body: AgentOperatingProfileV1) => unknown]> = [
    ["unknown top-level key", (body) => ({ ...body, extra: true })],
    ["wrong profile version", (body) => ({ ...body, profileVersion: 2 })],
    ["duplicate responsibility key", (body) => ({ ...body, responsibilities: [body.responsibilities[0], body.responsibilities[0]] })],
    ["bad key format", (body) => ({ ...body, responsibilities: [{ ...body.responsibilities[0], key: "Weekly Report" }] })],
    [
      "routine obligation without a trigger",
      (body) => ({ ...body, responsibilities: [{ ...body.responsibilities[0], obligation: { kind: "routine" } }] }),
    ],
    [
      "binding that does not apply to the obligation kind",
      (body) => ({ ...body, responsibilities: [{ ...body.responsibilities[1], obligation: { kind: "assigned", goalId: GOAL } }] }),
    ],
    [
      "duplicate criterion ids",
      (body) => {
        const [first] = body.responsibilities;
        return { ...body, responsibilities: [{ ...first, performance: { ...first.performance, criteria: [first.performance.criteria[0], first.performance.criteria[0]] } }] };
      },
    ],
    [
      "unknown coverage class",
      (body) => {
        const [first] = body.responsibilities;
        return { ...body, responsibilities: [{ ...first, performance: { ...first.performance, coverage: ["vibes"] } }] };
      },
    ],
    [
      "non-positive relative deadline",
      (body) => {
        const [first] = body.responsibilities;
        return { ...body, responsibilities: [{ ...first, performance: { ...first.performance, deadline: { kind: "after_trigger", hours: 0 } } }] };
      },
    ],
    [
      "human sample rate above 1",
      (body) => {
        const [first] = body.responsibilities;
        return {
          ...body,
          responsibilities: [{ ...first, performance: { ...first.performance, judges: { automated: [], human: { userId: "u", sampleRate: 2, minPerWindow: 0 } } } }],
        };
      },
    ],
    ["access without policyVersion", (body) => ({ ...body, access: { ...body.access, policyVersion: undefined } })],
    ["access mixing the wildcard", (body) => ({ ...body, access: { ...body.access, permissions: ["*", "tasks:assign"] } })],
    ["unknown access section key", (body) => ({ ...body, access: { ...body.access, see: { everything: true } } })],
    ["empty name", (body) => ({ ...body, identity: { ...body.identity, name: "" } })],
    ["non-uuid environment", (body) => ({ ...body, runtime: { environmentId: "local" } })],
  ];
  it.each(rejects)("rejects %s", (_label, mutate) => {
    expect(agentOperatingProfileV1Schema.safeParse(mutate(profile())).success).toBe(false);
  });

  it("allows empty descriptive text in a draft (provenance marks it missing)", () => {
    const body = profile();
    expect(parsesAsProfile({ ...body, identity: { ...body.identity, summary: "", audience: "" } })).toBe(true);
  });
});

function parsesAsProfile(body: unknown): boolean {
  return agentOperatingProfileV1Schema.safeParse(body).success;
}

describe("provenance map", () => {
  it("accepts stored states keyed by JSON pointer", () => {
    const map = {
      "/identity/title": { state: "owner_confirmed", by: "user:u1", at: "2026-10-29T12:00:00.000Z" },
      "/responsibilities/0/performance/thresholds/a~1b": { state: "proposed", sourceRef: "plan_card:1" },
      "": { state: "from_brief" },
    };
    expect(agentProfileProvenanceMapSchema.parse(map)).toEqual(map);
  });

  it("never stores setup_verified (computed on read) and rejects non-pointers", () => {
    expect(agentProfileProvenanceMapSchema.safeParse({ "/identity": { state: "setup_verified" } }).success).toBe(false);
    expect(agentProfileProvenanceMapSchema.safeParse({ "identity/title": { state: "proposed" } }).success).toBe(false);
    expect(agentProfileProvenanceMapSchema.safeParse({ "/a~2": { state: "proposed" } }).success).toBe(false);
  });
});

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeysDeep((value as Record<string, unknown>)[key])]));
  }
  return value;
}

describe("profileBodyHash", () => {
  const nodeHash = (body: unknown) => createHash("sha256").update(canonicalProfileJson(body)).digest("hex");

  it("equals SHA-256 of the canonical JSON, the evaluator ledger's rule", () => {
    const body = profile();
    expect(profileBodyHash(body)).toBe(nodeHash(body));
    expect(profileBodyHash(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches node:crypto across block boundaries and multi-byte text", () => {
    for (const summary of ["", "a", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000), "Zürich — 東京 — 🚀"]) {
      const body = { ...profile(), identity: { ...profile().identity, summary } };
      expect(profileBodyHash(body)).toBe(nodeHash(body));
    }
  });

  it("is stable across key order and undefined members, and changes with any value", () => {
    const body = profile();
    const reordered = reverseKeysDeep(body) as AgentOperatingProfileV1;
    expect(Object.keys(reordered)[0]).toBe(Object.keys(body).at(-1));
    const { rhythm, ...rest } = body;
    const shuffled = { rhythm, ...rest, runtime: undefined };
    expect(profileBodyHash(reordered)).toBe(profileBodyHash(body));
    expect(profileBodyHash(shuffled)).toBe(profileBodyHash(body));
    expect(profileBodyHash({ ...body, skills: ["crm-read", "reporting"] })).not.toBe(profileBodyHash(body));
    expect(profileBodyHash({ ...body, identity: { ...body.identity, title: "Analyst" } })).not.toBe(profileBodyHash(body));
  });
});

describe("diffProfiles", () => {
  it("is empty for identical bodies and a single add for a first profile", () => {
    expect(diffProfiles(profile(), profile())).toEqual([]);
    expect(diffProfiles(null, profile())).toEqual([{ op: "add", pointer: "", after: profile() }]);
  });

  it("reports leaf changes as JSON pointers", () => {
    const b = profile();
    b.identity.style.tone = "Formal";
    b.rhythm.quietHours = "22:00-07:00";
    b.runtime = { model: "fast" };
    expect(diffProfiles(profile(), b)).toEqual([
      { op: "replace", pointer: "/identity/style/tone", before: "Plain and brief", after: "Formal" },
      { op: "add", pointer: "/rhythm/quietHours", after: "22:00-07:00" },
      { op: "add", pointer: "/runtime", after: { model: "fast" } },
    ]);
  });

  it("treats a list of plain values as one field", () => {
    const b = { ...profile(), skills: ["reporting"] };
    expect(diffProfiles(profile(), b)).toEqual([{ op: "replace", pointer: "/skills", before: ["reporting", "crm-read"], after: ["reporting"] }]);
  });

  it("aligns responsibilities by key: edits point into b, removals into a, reorders are one entry", () => {
    const a = profile();
    const reordered = { ...a, responsibilities: [a.responsibilities[1], a.responsibilities[0]] };
    expect(diffProfiles(a, reordered)).toEqual([
      { op: "reorder", pointer: "/responsibilities", before: ["weekly-report", "ad-hoc"], after: ["ad-hoc", "weekly-report"] },
    ]);

    const edited = structuredClone(reordered);
    edited.responsibilities[1].title = "Monday pipeline report";
    expect(diffProfiles(a, edited)).toContainEqual({
      op: "replace",
      pointer: "/responsibilities/1/title",
      before: "Weekly pipeline report",
      after: "Monday pipeline report",
      key: "weekly-report",
      title: "Monday pipeline report",
    });

    const removedAndAdded = { ...a, responsibilities: [{ ...a.responsibilities[1], key: "questions" }] };
    const diff = diffProfiles(a, removedAndAdded);
    expect(diff.filter((entry) => entry.op === "remove").map((entry) => [entry.pointer, entry.key])).toEqual([
      ["/responsibilities/0", "weekly-report"],
      ["/responsibilities/1", "ad-hoc"],
    ]);
    expect(diff.filter((entry) => entry.op === "add").map((entry) => [entry.pointer, entry.key])).toEqual([["/responsibilities/0", "questions"]]);
  });

  it("compares unkeyed arrays of objects by index and escapes pointer tokens", () => {
    const a = profile();
    const b = structuredClone(a);
    b.responsibilities[0].stakeholders.push({ agentId: AGENT, need: "Inputs" });
    b.responsibilities[0].performance.thresholds = { "on/time": 0.9 };
    const member = { key: "weekly-report", title: "Weekly pipeline report" };
    expect(diffProfiles(a, b)).toEqual([
      { op: "replace", pointer: "/responsibilities/0/performance/thresholds", before: null, after: { "on/time": 0.9 }, ...member },
      { op: "add", pointer: "/responsibilities/0/stakeholders/1", after: { agentId: AGENT, need: "Inputs" }, ...member },
    ]);
    const c = structuredClone(b);
    c.responsibilities[0].performance.thresholds = { "on/time": 0.8 };
    expect(diffProfiles(b, c)).toEqual([
      { op: "replace", pointer: "/responsibilities/0/performance/thresholds/on~1time", before: 0.9, after: 0.8, ...member },
    ]);
  });

  it("names the responsibility (key and title) on every entry for or inside it, and on nothing else", () => {
    const a = profile();
    const b = structuredClone(a);
    b.responsibilities[1].outcome = "Answers within an hour";
    b.responsibilities[0].performance.criteria[1].text = "Numbers match the CRM";
    b.responsibilities.push({ ...structuredClone(a.responsibilities[1]), key: "forecast", title: "Forecast notes" });
    b.identity.audience = "Everyone";
    const diff = diffProfiles(a, b);
    expect(diff).toEqual([
      { op: "replace", pointer: "/identity/audience", before: "Sales leadership", after: "Everyone" },
      {
        op: "replace",
        pointer: "/responsibilities/0/performance/criteria/1/text",
        before: "Numbers reconcile with the CRM",
        after: "Numbers match the CRM",
        key: "weekly-report",
        title: "Weekly pipeline report",
      },
      { op: "replace", pointer: "/responsibilities/1/outcome", before: "Answers within a day", after: "Answers within an hour", key: "ad-hoc", title: "Ad-hoc questions" },
      { op: "add", pointer: "/responsibilities/2", after: b.responsibilities[2], key: "forecast", title: "Forecast notes" },
    ]);
    // A removed member is named from `a`.
    const removed = { ...a, responsibilities: [a.responsibilities[1]] };
    expect(diffProfiles(a, removed)).toEqual([
      { op: "remove", pointer: "/responsibilities/0", before: a.responsibilities[0], key: "weekly-report", title: "Weekly pipeline report" },
    ]);
    for (const entry of diff) expect(agentProfileDiffEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("names the first responsibility added to an empty list, and the last one removed", () => {
    const a = profile();
    const empty = { ...a, responsibilities: [] };
    expect(diffProfiles(empty, a)).toEqual([
      { op: "add", pointer: "/responsibilities/0", after: a.responsibilities[0], key: "weekly-report", title: "Weekly pipeline report" },
      { op: "add", pointer: "/responsibilities/1", after: a.responsibilities[1], key: "ad-hoc", title: "Ad-hoc questions" },
    ]);
    expect(diffProfiles(a, empty)).toEqual([
      { op: "remove", pointer: "/responsibilities/0", before: a.responsibilities[0], key: "weekly-report", title: "Weekly pipeline report" },
      { op: "remove", pointer: "/responsibilities/1", before: a.responsibilities[1], key: "ad-hoc", title: "Ad-hoc questions" },
    ]);
    // Other empty arrays are unaffected: a plain list is still one field, unkeyed objects still go by index.
    expect(diffProfiles({ ...a, skills: [] }, a)).toEqual([{ op: "replace", pointer: "/skills", before: [], after: ["reporting", "crm-read"] }]);
    expect(diffProfiles({ ...a, knowledge: [] }, { ...a, knowledge: [{ source: "CRM", kind: "connection" }] })).toEqual([
      { op: "add", pointer: "/knowledge/0", after: { source: "CRM", kind: "connection" } },
    ]);
  });

  it("is deterministic", () => {
    const b = profile();
    b.skills = [];
    b.identity.title = "x";
    expect(diffProfiles(profile(), b)).toEqual(diffProfiles(profile(), structuredClone(b)));
  });
});

describe("lookups", () => {
  it("finds responsibilities by key and by bound routine trigger", () => {
    const body = profile();
    expect(profileResponsibilityKeys(body)).toEqual(["weekly-report", "ad-hoc"]);
    expect(findProfileResponsibility(body, "ad-hoc")?.title).toBe("Ad-hoc questions");
    expect(findProfileResponsibility(body, "missing")).toBeNull();
    expect(findResponsibilityByRoutineTrigger(body, TRIGGER)?.key).toBe("weekly-report");
    expect(findResponsibilityByRoutineTrigger(body, GOAL)).toBeNull();
  });
});

describe("route bodies", () => {
  it("mapping needs a uuid agent and a well-formed key", () => {
    expect(mapIssueResponsibilitySchema.safeParse({ agentId: AGENT, responsibilityKey: "weekly-report" }).success).toBe(true);
    expect(mapIssueResponsibilitySchema.safeParse({ agentId: "a", responsibilityKey: "weekly-report" }).success).toBe(false);
    expect(mapIssueResponsibilitySchema.safeParse({ agentId: AGENT, responsibilityKey: "Weekly" }).success).toBe(false);
  });

  it("the enforcement body parses all three modes (the route answers enforce with 409) and nothing else", () => {
    for (const mode of ["off", "shadow", "enforce"]) expect(updateAgentAccessEnforcementSchema.safeParse({ mode }).success).toBe(true);
    expect(updateAgentAccessEnforcementSchema.safeParse({ mode: "on" }).success).toBe(false);
  });
});

describe("agent_profile_change payload", () => {
  const payload: AgentProfileChangePayload = {
    agentId: AGENT,
    profileId: "00000000-0000-4000-8000-0000000000b1",
    revisionId: REVISION,
    revisionNumber: 2,
    basedOnRevisionId: null,
    bases: { basedOnRevisionId: null, governanceRevision: 3, configRevisionId: null },
    bodyHash: profileBodyHash(profile()),
    diff: diffProfiles(null, profile()),
    fieldAuthority: [{ pointer: "", required: "steward_or_accountable" }],
    requiredAuthority: "steward_or_accountable",
    affectedResponsibilities: ["weekly-report", "ad-hoc"],
    accessChanges: [{ dimension: "talk.agents", change: "narrows", clippedByCeiling: false }],
    evidence: { ledgerEventIds: [] },
    reason: "First profile",
    expectedBenefit: null,
    risks: null,
    proposedBy: { kind: "user", userId: "user-vp" },
  };

  it("round-trips, and its schema output is the DTO type (compile-time)", () => {
    const parsed: AgentProfileChangePayload = agentProfileChangePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
    expect(parsed).toEqual(payload);
    const inferred: z.infer<typeof agentProfileChangePayloadSchema> = payload;
    expect(inferred.revisionId).toBe(REVISION);
  });

  it("rejects an unknown authority and a malformed hash", () => {
    expect(agentProfileChangePayloadSchema.safeParse({ ...payload, requiredAuthority: "owner" }).success).toBe(false);
    expect(agentProfileChangePayloadSchema.safeParse({ ...payload, bodyHash: "abc" }).success).toBe(false);
  });
});

describe("evaluation contract v2 (additive)", () => {
  const body = profile();
  const contract = {
    contractVersion: "v2",
    companyId: COMPANY,
    subjectRef: { kind: "agent", id: AGENT },
    accountableUserId: "user-vp",
    profileRevisionId: REVISION,
    independenceRule: "independence/v1",
    responsibilities: body.responsibilities.map((responsibility) => ({ key: responsibility.key, ...responsibility.performance })),
  };

  it("parses an agent contract and refuses other subjects", () => {
    expect(evaluationContractV2Schema.parse(contract)).toEqual(contract);
    expect(evaluationContractV2Schema.safeParse({ ...contract, subjectRef: { kind: "project", id: AGENT } }).success).toBe(false);
    expect(
      evaluationContractV2Schema.safeParse({ ...contract, responsibilities: [contract.responsibilities[0], contract.responsibilities[0]] }).success,
    ).toBe(false);
    expect(evaluationSubjectRefSchema.safeParse({ kind: "goal", id: GOAL }).success).toBe(true);
  });

  it("V1 parsing is unchanged: a V2 contract is not a V1 contract, and the version is readable without parsing", () => {
    expect(evaluationContractV1Schema.safeParse(contract).success).toBe(false);
    expect(evaluationContractVersionOf({ contract, companyId: COMPANY })).toBe("v2");
    expect(evaluationContractVersionOf(contract)).toBe("v2");
    expect(evaluationContractVersionOf({ contract: { contractVersion: "v1" } })).toBe("v1");
    expect(evaluationContractVersionOf({ contractVersion: 2 })).toBeNull();
    expect(evaluationContractVersionOf(null)).toBeNull();
  });
});
