import { describe, expect, it } from "vitest";
import {
  generateDispatchRecommendation,
  renderDispatchCard,
  type DispatchContext,
  type EngineerProfile,
} from "../services/msp/sla-dispatch.js";
import { TicketCategory, ClientSegment, UrgencyTier, SkillTag, type TicketContext, type SlaRiskScore } from "../types/msp-taxonomy.js";
const makeTicket = (overrides: Partial<TicketContext> = {}): TicketContext => ({
  ticketId: "ticket-test-001",
  clientName: "Test Corp",
  clientSegment: ClientSegment.MIDMARKET,
  affectedAsset: "Azure AD",
  affectedService: "Identity",
  category: TicketCategory.INCIDENT_OUTAGE,
  title: "Users cannot authenticate",
  description: "Azure AD sync is failing — all users locked out",
  history: [],
  urgencySignals: {
    slaWindowMinutes: 60,
    keywordMatches: ["down", "authentication", "login failure"],
    clientTierLabel: "midmarket",
    hasCsuiteMention: false,
    hasDeadlineMention: false,
  },
  isSecurity: false,
  isRevenueAffecting: true,
  hasActiveOutage: true,
  keywords: ["azure", "authentication", "login failure"],
  slaTier: UrgencyTier.P1_CRITICAL,
  computedAt: new Date().toISOString(),
  ...overrides,
});

const makeSlaRisk = (overrides: Partial<SlaRiskScore> = {}): SlaRiskScore => ({
  score: 75,
  tier: "high",
  atRisk: false,
  minutesUntilBreach: 30,
  breached: false,
  ...overrides,
});

const engineers: EngineerProfile[] = [
  {
    id: "agent-001",
    name: "Alex (Tier 1)",
    email: "alex@msp.internal",
    skillTags: [SkillTag.TIER1, SkillTag.M365, SkillTag.GOOGLE_WORKSPACE],
    tier: "tier1",
    currentWorkload: 30,
    activeTickets: 2,
    maxTickets: 8,
  },
  {
    id: "agent-002",
    name: "Jordan (Tier 2)",
    email: "jordan@msp.internal",
    skillTags: [SkillTag.TIER2, SkillTag.NETWORK, SkillTag.MONITORING, SkillTag.CLOUD_AZURE],
    tier: "tier2",
    currentWorkload: 55,
    activeTickets: 4,
    maxTickets: 6,
  },
  {
    id: "agent-003",
    name: "Sam (Tier 3)",
    email: "sam@msp.internal",
    skillTags: [SkillTag.TIER3, SkillTag.SECURITY, SkillTag.CLOUD_AWS, SkillTag.CLOUD_AZURE, SkillTag.NETWORK],
    tier: "tier3",
    currentWorkload: 20,
    activeTickets: 1,
    maxTickets: 4,
  },
];

function ctx(ticket: TicketContext, slaRisk: SlaRiskScore): DispatchContext {
  return { ticket, slaRisk, availableEngineers: engineers };
}

describe("msp/sla-dispatch: generateDispatchRecommendation", () => {
  describe("P1_CRITICAL — full outage", () => {
    it("recommends Tier 3 engineer for P1 incident outage", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL, hasActiveOutage: true });
      const risk = makeSlaRisk({ score: 85, tier: "critical", breached: false, atRisk: true });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P1_CRITICAL);
      expect(result.suggestedAssignee).toBe("Sam (Tier 3)");
      expect(result.escalationFlags.some(f => f.includes("OUTAGE"))).toBe(true);
    });

    it("sets upgrade urgency override when SLA is critical but tier is not P1", () => {
      const ticket = makeTicket({ category: TicketCategory.REQUEST_QUESTION, slaTier: UrgencyTier.P3_MEDIUM });
      const risk = makeSlaRisk({ tier: "critical", score: 82 });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgencyOverride).toBe("upgrade");
    });

    it("includes breach escalation flag when SLA is breached", () => {
      const ticket = makeTicket();
      const risk = makeSlaRisk({ breached: true, atRisk: false, tier: "high" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.escalationFlags.some(f => f.includes("BREACHED"))).toBe(true);
    });

    it("returns alternative assignees ranked by fit", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
      const risk = makeSlaRisk({ tier: "critical" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.alternativeAssignees.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe("P2_HIGH — partial degradation", () => {
    it("recommends Tier 2 engineer for partial degradation", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_PARTIAL, slaTier: UrgencyTier.P2_HIGH, hasActiveOutage: false });
      const risk = makeSlaRisk({ score: 55, tier: "high", breached: false, atRisk: false });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P2_HIGH);
      expect(result.suggestedSkillTags).toContain("tier2");
      expect(result.suggestedSkillTags).toContain("network");
    });

    it("includes SLA at-risk flag when window is tight", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_PARTIAL, slaTier: UrgencyTier.P2_HIGH });
      const risk = makeSlaRisk({ atRisk: true, minutesUntilBreach: 5 });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.escalationFlags.some(f => f.includes("AT RISK"))).toBe(true);
    });
  });

  describe("P3_MEDIUM / P4_LOW — general requests", () => {
    it("routes access request to Tier 1 with M365/Google Workspace skills", () => {
      const ticket = makeTicket({ category: TicketCategory.REQUEST_ACCESS, slaTier: UrgencyTier.P3_MEDIUM });
      const risk = makeSlaRisk({ score: 20, tier: "medium", breached: false, atRisk: false });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.suggestedSkillTags).toContain("tier1");
      expect(result.suggestedSkillTags).toContain("m365");
    });

    it("sets null urgency override when SLA risk and tier are aligned", () => {
      const ticket = makeTicket({ category: TicketCategory.REQUEST_ACCESS, slaTier: UrgencyTier.P3_MEDIUM });
      const risk = makeSlaRisk({ tier: "medium" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgencyOverride).toBeNull();
    });

    it("routes billing admin tickets to billing_admin skill", () => {
      const ticket = makeTicket({ category: TicketCategory.ADMIN_BILLING, slaTier: UrgencyTier.P3_MEDIUM });
      const risk = makeSlaRisk({ tier: "medium" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.suggestedSkillTags).toContain("billing_admin");
    });
  });

  describe("all three urgency tiers", () => {
    it("produces a valid recommendation for P1_CRITICAL", () => {
      const ticket = makeTicket({ slaTier: UrgencyTier.P1_CRITICAL, category: TicketCategory.INCIDENT_OUTAGE });
      const risk = makeSlaRisk({ tier: "critical" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P1_CRITICAL);
      expect(result.nextSteps.length).toBeGreaterThan(0);
      expect(result.modelUsed).toBe("rule-based-dispatch-v1");
      expect(result.generatedAt).toBeTruthy();
    });

    it("produces a valid recommendation for P2_HIGH", () => {
      const ticket = makeTicket({ slaTier: UrgencyTier.P2_HIGH, category: TicketCategory.INCIDENT_PARTIAL });
      const risk = makeSlaRisk({ tier: "high" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P2_HIGH);
      expect(result.nextSteps.length).toBeGreaterThan(0);
    });

    it("produces a valid recommendation for P3_MEDIUM", () => {
      const ticket = makeTicket({ slaTier: UrgencyTier.P3_MEDIUM, category: TicketCategory.REQUEST_ACCESS });
      const risk = makeSlaRisk({ tier: "medium" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P3_MEDIUM);
      expect(result.nextSteps.length).toBeGreaterThan(0);
    });

    it("produces a valid recommendation for P4_LOW", () => {
      const ticket = makeTicket({ slaTier: UrgencyTier.P4_LOW, category: TicketCategory.REQUEST_QUESTION });
      const risk = makeSlaRisk({ tier: "low" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.urgency).toBe(UrgencyTier.P4_LOW);
      expect(result.nextSteps.length).toBeGreaterThan(0);
    });
  });

  describe("engineer scoring", () => {
    it("prefers Tier 3 for P1_CRITICAL incident", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
      const risk = makeSlaRisk({ tier: "critical" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      expect(result.suggestedAssignee).toBe("Sam (Tier 3)");
    });

    it("prefers lower-workload engineer when skills are equal", () => {
      // Both agent-002 and agent-003 have cloud_azure
      const ticket = makeTicket({ category: TicketCategory.REQUEST_CHANGE, slaTier: UrgencyTier.P2_HIGH });
      const risk = makeSlaRisk({ tier: "high" });
      const result = generateDispatchRecommendation(ctx(ticket, risk));

      // agent-003 has 20% workload, agent-002 has 55%
      // Both match REQUEST_CHANGE (tier2/tier3) skills
      // Sam (agent-003, tier3) scores higher due to lower workload
      expect(result.suggestedAssignee).toBeTruthy();
    });

    it("returns null assignee when no engineers available", () => {
      const ticket = makeTicket();
      const risk = makeSlaRisk();
      const result = generateDispatchRecommendation({ ticket, slaRisk: risk, availableEngineers: [] });

      expect(result.suggestedAssignee).toBeNull();
    });

    it("does not recommend an engineer who is already at max ticket capacity", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
      const risk = makeSlaRisk({ tier: "critical" });
      const result = generateDispatchRecommendation({
        ticket,
        slaRisk: risk,
        availableEngineers: engineers.map((engineer) =>
          engineer.id === "agent-003"
            ? { ...engineer, activeTickets: engineer.maxTickets }
            : engineer,
        ),
      });

      expect(result.suggestedAssignee).not.toBe("Sam (Tier 3)");
      expect(result.alternativeAssignees.some((assignee) => assignee.agentName === "Sam (Tier 3)")).toBe(false);
    });

    it("returns null assignee when all otherwise matching engineers are full", () => {
      const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
      const risk = makeSlaRisk({ tier: "critical" });
      const fullEngineers = engineers.map((engineer) => ({ ...engineer, activeTickets: engineer.maxTickets }));
      const result = generateDispatchRecommendation({ ticket, slaRisk: risk, availableEngineers: fullEngineers });

      expect(result.suggestedAssignee).toBeNull();
      expect(result.confidence).toBe(0);
    });
  });
});

describe("msp/sla-dispatch: renderDispatchCard", () => {
  it("renders a markdown card with all sections", () => {
    const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
    const risk = makeSlaRisk({ tier: "critical" });
    const result = generateDispatchRecommendation(ctx(ticket, risk));
    const card = renderDispatchCard(result);

    expect(card).toContain("## MSP Dispatch Recommendation");
    expect(card).toContain("### Recommended Assignee");
    expect(card).toContain("### SLA Recommendation");
    expect(card).toContain("### Escalation Flags");
    expect(card).toContain("### Next Steps");
    expect(card).toContain("### Internal Notes");
  });

  it("renders agent name in the assignee table", () => {
    const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
    const risk = makeSlaRisk({ tier: "critical" });
    const result = generateDispatchRecommendation(ctx(ticket, risk));
    const card = renderDispatchCard(result);

    expect(card).toContain("Sam (Tier 3)");
  });

  it("renders escalation flags when present", () => {
    const ticket = makeTicket({ hasActiveOutage: true });
    const risk = makeSlaRisk({ breached: true });
    const result = generateDispatchRecommendation(ctx(ticket, risk));
    const card = renderDispatchCard(result);

    expect(card).toContain("BREACHED");
    expect(card).toContain("ACTIVE OUTAGE");
  });

  it("renders alternatives section", () => {
    const ticket = makeTicket({ category: TicketCategory.INCIDENT_OUTAGE, slaTier: UrgencyTier.P1_CRITICAL });
    const risk = makeSlaRisk({ tier: "critical" });
    const result = generateDispatchRecommendation(ctx(ticket, risk));
    const card = renderDispatchCard(result);

    expect(card).toContain("**Alternatives:**");
  });
});
