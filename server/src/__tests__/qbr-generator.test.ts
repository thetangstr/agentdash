/**
 * QBR Generator Tests — AGE-7
 * Acceptance criteria:
 *   (1) report covers all 5 health metrics
 *   (2) includes written summary and risk callouts
 *   (3) output is in a human-reviewable format
 */

import { describe, it, expect } from "vitest";
import {
  generateQbrDraft,
  generateQbrPackSummary,
  formatQbrAsText,
  type QbrDraft,
} from "../services/msp/qbr-generator.js";
import {
  HealthMetric,
  type WeeklyMetricData,
  generateHealthScore,
  scoreOpenRisks,
} from "../services/msp/health-metrics.js";
import { ClientSegment, TicketCategory, UrgencyTier, type TicketContext } from "../types/msp-taxonomy.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeMetricData(overrides: Partial<WeeklyMetricData> = {}): WeeklyMetricData {
  return {
    clientId: "client-001",
    clientName: "Acme Corp (Mid-Market)",
    weekStart: "2026-05-18",
    weekEnd: "2026-05-24",
    ticketVolume: { total: 14, byCategory: {}, byPriority: {} },
    resolutionTime: { avgHours: 6.4, medianHours: 4.2, p95Hours: 18.1, withinSlaCount: 11, breachCount: 3 },
    slaAdherence: { totalTickets: 14, onTimeCount: 11, adherencePercent: 78.6 },
    openRisks: {
      count: 2,
      items: [
        { id: "risk-1", description: "Azure AD sync failure", severity: "high", openSince: "2026-05-18" },
      ],
    },
    securityFindings: { critical: 0, high: 1, medium: 2, low: 3, lastScanDate: "2026-05-24" },
    renewalSignals: {
      contractEndDate: "2026-09-30",
      npsScore: 7,
      healthCheckComplete: false,
      expansionContractionSignals: "stable",
      notes: ["Renewal 90 days out"],
    },
    ...overrides,
  };
}

function makeTicket(
  overrides: Partial<TicketContext> = {},
): TicketContext {
  const now = new Date().toISOString();
  return {
    ticketId: "tkt-001",
    clientName: "Acme Corp (Mid-Market)",
    clientSegment: ClientSegment.MIDMARKET,
    affectedAsset: "Azure AD",
    affectedService: "Identity",
    category: TicketCategory.INCIDENT_OUTAGE,
    title: "Azure AD sync failure",
    description: "Users cannot authenticate.",
    history: [],
    urgencySignals: {
      slaWindowMinutes: 60,
      keywordMatches: ["azure", "authentication"],
      clientTierLabel: ClientSegment.MIDMARKET,
      hasCsuiteMention: false,
      hasDeadlineMention: false,
    },
    isSecurity: false,
    isRevenueAffecting: true,
    hasActiveOutage: true,
    keywords: ["azure", "authentication"],
    slaTier: UrgencyTier.P1_CRITICAL,
    computedAt: now,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("QBR Generator — AGE-7 Acceptance Criteria", () => {

  // ── AC1: All 5 health metrics covered ──────────────────────────────────────

  describe("AC1: report covers all health metrics", () => {
    it("generateQbrDraft includes all six metric components in the output", () => {
      const current = makeMetricData();
      const prior = makeMetricData({ ticketVolume: { total: 18, byCategory: {}, byPriority: {} } });
      const draft = generateQbrDraft(current, [], prior);

      const metricHeadings = draft.sections
        .filter(s => s.heading === "Metric Breakdown")
        .flatMap(s => s.body.split("\n"))
        .map(l => l.replace(/\*\*/g, "").trim());

      // All six HealthMetric labels must appear in the metric breakdown
      const expectedLabels = [
        "Ticket Volume",
        "Resolution Time",
        "SLA Adherence",
        "Open Risks",
        "Security Findings",
        "Renewal",
      ];
      for (const label of expectedLabels) {
        expect(metricHeadings.some(l => l.includes(label)), `Missing metric label: ${label}`)
          .toBe(true);
      }
    });

    it("generateHealthScore produces a score for each of the six metrics", () => {
      const data = makeMetricData();
      const score = generateHealthScore(data);

      expect(score.componentScores).toHaveLength(6);
      const metricKeys = score.componentScores.map(c => c.metric);
      expect(metricKeys).toContain(HealthMetric.TICKET_VOLUME);
      expect(metricKeys).toContain(HealthMetric.RESOLUTION_TIME);
      expect(metricKeys).toContain(HealthMetric.SLA_ADHERENCE);
      expect(metricKeys).toContain(HealthMetric.OPEN_RISKS);
      expect(metricKeys).toContain(HealthMetric.SECURITY_FINDINGS);
      expect(metricKeys).toContain(HealthMetric.RENEWAL_SIGNALS);
    });

    it("generateQbrPackSummary aggregates multiple client scores", () => {
      const clients = [
        generateHealthScore(makeMetricData({ clientId: "c1", clientName: "Client A" })),
        generateHealthScore(makeMetricData({ clientId: "c2", clientName: "Client B" })),
      ];
      const summary = generateQbrPackSummary(clients);

      expect(summary.totalClients).toBe(2);
      expect(typeof summary.avgScore).toBe("number");
      expect(summary.greenCount + summary.amberCount + summary.redCount).toBe(2);
    });
  });

  // ── AC2: Written summary and risk callouts ──────────────────────────────────

  describe("AC2: written summary and risk callouts", () => {
    it("generateQbrDraft produces a non-empty executive summary", () => {
      const draft = generateQbrDraft(makeMetricData(), []);

      expect(draft.executiveSummary).toBeTruthy();
      expect(draft.executiveSummary.length).toBeGreaterThan(10);
      expect(draft.executiveSummary).toContain("Acme Corp");
    });

    it("generateQbrDraft surfaces risk callouts for amber/red metrics", () => {
      const amberData = makeMetricData({
        slaAdherence: { totalTickets: 10, onTimeCount: 7, adherencePercent: 70.0 },
      });
      const draft = generateQbrDraft(amberData, []);

      expect(draft.riskCallouts.length).toBeGreaterThan(0);
      expect(draft.riskCallouts.some(r => r.includes("SLA"))).toBe(true);
    });

    it("scores open risks as amber/red instead of healthy", () => {
      const amber = scoreOpenRisks(makeMetricData({
        openRisks: {
          count: 2,
          items: [
            { id: "r1", description: "Backup verification pending", severity: "medium", openSince: "2026-05-18" },
            { id: "r2", description: "Firewall firmware overdue", severity: "low", openSince: "2026-05-18" },
          ],
        },
      }));
      const red = scoreOpenRisks(makeMetricData({
        openRisks: {
          count: 1,
          items: [
            { id: "r1", description: "Azure AD sync failure", severity: "high", openSince: "2026-05-18" },
          ],
        },
      }));

      expect(amber.status).toBe("amber");
      expect(red.status).toBe("red");
    });

    it("generateQbrDraft includes a Metric Breakdown section", () => {
      const draft = generateQbrDraft(makeMetricData(), []);

      const breakdown = draft.sections.find(s => s.heading === "Metric Breakdown");
      expect(breakdown).toBeDefined();
      expect(breakdown!.body).toContain("SLA Adherence");
    });

    it("generateQbrDraft flags top risks section as action-required", () => {
      const redData = makeMetricData({
        openRisks: {
          count: 3,
          items: [
            { id: "r1", description: "DB corruption", severity: "critical", openSince: "2026-05-01" },
            { id: "r2", description: "Auth failure", severity: "high", openSince: "2026-05-01" },
            { id: "r3", description: "Disk space low", severity: "high", openSince: "2026-05-01" },
          ],
        },
      });
      const draft = generateQbrDraft(redData, []);

      const topRisks = draft.sections.find(s => s.heading === "Top Risks");
      expect(topRisks).toBeDefined();
      expect(topRisks!.isActionRequired).toBe(true);
    });

    it("generateQbrDraft includes renewal signals when present", () => {
      const expansionData = makeMetricData({
        renewalSignals: {
          contractEndDate: "2026-09-30",
          npsScore: 9,
          healthCheckComplete: true,
          expansionContractionSignals: "expansion",
          notes: ["Upsell opportunity identified"],
        },
      });
      const draft = generateQbrDraft(expansionData, []);

      const renewalSection = draft.sections.find(s => s.heading === "Renewal & Upsell Signals");
      expect(renewalSection).toBeDefined();
      expect(draft.renewalSignals.some(s => s.includes("expansion") || s.includes("growth"))).toBe(true);
    });

    it("generateQbrDraft includes churn risk in renewal signals when flagged", () => {
      const churnData = makeMetricData({
        renewalSignals: {
          contractEndDate: "2026-06-30",
          npsScore: 4,
          healthCheckComplete: false,
          expansionContractionSignals: "churn_risk",
          notes: [],
        },
      });
      const draft = generateQbrDraft(churnData, []);

      expect(draft.renewalSignals.some(s => s.toLowerCase().includes("churn"))).toBe(true);
    });

    it("open tickets are included in the draft when provided", () => {
      const tickets = [
        makeTicket({ ticketId: "tkt-001", title: "Azure AD sync failure" }),
        makeTicket({ ticketId: "tkt-002", title: "Weekly backup job failed" }),
      ];
      const draft = generateQbrDraft(makeMetricData(), tickets);

      expect(draft.openTicketsSummary).toBeTruthy();
      expect(draft.openTicketsSummary).toContain("Azure AD sync failure");
      expect(draft.openTicketsSummary).toContain("Weekly backup job failed");
    });

    it("priorWeek data produces trend indicators (improving/declining/stable)", () => {
      const current = makeMetricData({
        ticketVolume: { total: 10, byCategory: {}, byPriority: {} },
        slaAdherence: { totalTickets: 10, onTimeCount: 8, adherencePercent: 80.0 },
      });
      const prior = makeMetricData({
        ticketVolume: { total: 20, byCategory: {}, byPriority: {} },
        slaAdherence: { totalTickets: 10, onTimeCount: 6, adherencePercent: 60.0 },
      });
      const draft = generateQbrDraft(current, [], prior);

      // Ticket volume improved (20 → 10), SLA declined (60% → 80%)
      const score = generateHealthScore(current, prior);
      const ticketScore = score.componentScores.find(c => c.metric === HealthMetric.TICKET_VOLUME)!;
      const slaScore = score.componentScores.find(c => c.metric === HealthMetric.SLA_ADHERENCE)!;

      expect(ticketScore.trend).toBe("improving");
      expect(slaScore.trend).toBe("improving"); // 60% → 80% is an improvement
    });
  });

  // ── AC3: Human-reviewable output format ────────────────────────────────────

  describe("AC3: human-reviewable output format", () => {
    it("formatQbrAsText produces a readable document with all key sections", () => {
      const draft = generateQbrDraft(makeMetricData(), [makeTicket()]);
      const text = formatQbrAsText(draft);

      expect(text).toContain("QBR DRAFT");
      expect(text).toContain("Acme Corp");
      expect(text).toContain("EXECUTIVE SUMMARY");
      // Section headings are uppercased in formatQbrAsText
      expect(text).toContain("METRIC BREAKDOWN");
      expect(text).toContain("OPEN TICKETS");
      expect(text).toContain("Overall Score:");
      expect(text).toContain("/100");
    });

    it("QbrDraft JSON structure contains all required fields", () => {
      const draft = generateQbrDraft(makeMetricData(), []);

      expect(draft.clientId).toBeTruthy();
      expect(draft.clientName).toBeTruthy();
      expect(draft.periodStart).toBeTruthy();
      expect(draft.periodEnd).toBeTruthy();
      expect(draft.overallScore).toBeGreaterThanOrEqual(0);
      expect(draft.overallScore).toBeLessThanOrEqual(100);
      expect(["green", "amber", "red"]).toContain(draft.overallStatus);
      expect(draft.executiveSummary).toBeTruthy();
      expect(Array.isArray(draft.sections)).toBe(true);
      expect(draft.sections.length).toBeGreaterThan(0);
      expect(draft.riskCallouts).toBeTruthy();
      expect(Array.isArray(draft.riskCallouts));
      expect(draft.renewalSignals).toBeTruthy();
      expect(Array.isArray(draft.renewalSignals));
      expect(draft.generatedAt).toBeTruthy();
      expect(["draft", "pending_review", "approved"]).toContain(draft.status);
    });

    it("status badge is included in the text output for overall score", () => {
      const draft = generateQbrDraft(makeMetricData(), []);
      const text = formatQbrAsText(draft);

      // Text output should contain the status emoji (green=✅, amber=⚠️, red=🔴)
      expect(text).toMatch(/[✅⚠️🔴]/);
    });

    it("operator notes section is present", () => {
      const draft = generateQbrDraft(makeMetricData(), []);

      const notes = draft.sections.find(s => s.heading === "Operator Notes");
      expect(notes).toBeDefined();
      expect(notes!.body.trim().length).toBeGreaterThan(0);
    });

    it("generatedAt timestamp is ISO format", () => {
      const draft = generateQbrDraft(makeMetricData(), []);
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
      expect(draft.generatedAt).toMatch(isoRegex);
    });
  });

  // ── Bug regression: Bulgarian text in executive summary ──────────────────────

  describe("bug regression: no foreign-language text in executive summary", () => {
    it("executive summary is pure English", () => {
      const draft = generateQbrDraft(makeMetricData(), []);

      // Should not contain Bulgarian characters (Cyrillic)
      const cyrillicRegex = /[\u0400-\u04FF]/;
      expect(draft.executiveSummary).not.toMatch(cyrillicRegex);
      expect(draft.executiveSummary).toMatch(/trend|Trend|health|score|Health|Score/);
    });
  });
});
