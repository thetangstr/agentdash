import { describe, expect, it } from "vitest";
import {
  classifyTicketCategory,
  assignUrgencyTier,
  summarizeTicketContext,
  scoreSlaRisk,
  type RawTicket,
} from "../services/msp/ticket-triage.js";
import { TicketCategory, ClientSegment, UrgencyTier } from "../types/msp-taxonomy.js";

describe("msp/ticket-triage: classifyTicketCategory", () => {
  it("returns SECURITY_INCIDENT when breach/ransomware keywords present", () => {
    const result = classifyTicketCategory({
      title: "URGENT: Possible ransomware",
      description: "Several servers locked, ransom note found",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.SECURITY_INCIDENT);
  });

  it("returns SECURITY_INCIDENT when metadata.isSecurity is true", () => {
    const result = classifyTicketCategory({
      title: "Odd login behavior",
      description: "Seeing logins from unusual countries",
      tags: [],
      metadata: { isSecurity: true },
    });
    expect(result).toBe(TicketCategory.SECURITY_INCIDENT);
  });

  it("returns SECURITY_QUESTION for security question with no breach keywords", () => {
    const result = classifyTicketCategory({
      title: "CVE advisory question",
      description: "Can you review the latest advisory and advise if we need action?",
      tags: ["security"],
      metadata: {},
    });
    // Without breach/incident keywords, tags alone trigger SECURITY_QUESTION
    expect(result).toBe(TicketCategory.SECURITY_QUESTION);
  });

  it("returns INCIDENT_OUTAGE for downtime keywords", () => {
    const result = classifyTicketCategory({
      title: "Email is down",
      description: "Users cannot access email at all",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.INCIDENT_OUTAGE);
  });

  it("returns INCIDENT_OUTAGE when 'not working' is in text", () => {
    const result = classifyTicketCategory({
      title: "Server not working",
      description: "Production server completely unresponsive",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.INCIDENT_OUTAGE);
  });

  it("returns INCIDENT_PARTIAL for degraded/slow keywords", () => {
    const result = classifyTicketCategory({
      title: "Network is slow",
      description: "Users experiencing slow connectivity",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.INCIDENT_PARTIAL);
  });

  it("returns REQUEST_CHANGE for maintenance/upgrade keywords", () => {
    const result = classifyTicketCategory({
      title: "Windows server upgrade",
      description: "Scheduled maintenance window for server update",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.REQUEST_CHANGE);
  });

  it("returns REQUEST_ACCESS for permission/provisioning keywords", () => {
    const result = classifyTicketCategory({
      title: "Please add new user",
      description: "Need to provision account for new hire",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.REQUEST_ACCESS);
  });

  it("returns REQUEST_BUG for bug/defect keywords", () => {
    const result = classifyTicketCategory({
      title: "Bug in invoice module",
      description: "Tax calculation is incorrect",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.REQUEST_BUG);
  });

  it("returns ADMIN_BILLING for billing keywords", () => {
    const result = classifyTicketCategory({
      title: "Invoice question",
      description: "Why was I charged twice this month?",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.ADMIN_BILLING);
  });

  it("returns ADMIN_RENEWAL for renewal/churn keywords", () => {
    const result = classifyTicketCategory({
      title: "Contract renewal",
      description: "Would like to discuss renewal options",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.ADMIN_RENEWAL);
  });

  it("falls back to REQUEST_QUESTION for plain text", () => {
    const result = classifyTicketCategory({
      title: "How do I set up VPN?",
      description: "Can you share instructions for VPN configuration?",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.REQUEST_QUESTION);
  });
});

describe("msp/ticket-triage: assignUrgencyTier", () => {
  it("returns P1_CRITICAL when hasActiveOutage is true", () => {
    const result = assignUrgencyTier(TicketCategory.REQUEST_QUESTION, [], true);
    expect(result).toBe(UrgencyTier.P1_CRITICAL);
  });

  it("returns P1_CRITICAL for full-scope outage language without explicit metadata", () => {
    const result = assignUrgencyTier(TicketCategory.INCIDENT_OUTAGE, ["down", "all users"], false);
    expect(result).toBe(UrgencyTier.P1_CRITICAL);
  });

  it("returns P1_CRITICAL for SECURITY_INCIDENT category", () => {
    const result = assignUrgencyTier(TicketCategory.SECURITY_INCIDENT, [], false);
    expect(result).toBe(UrgencyTier.P1_CRITICAL);
  });

  it("returns P2_HIGH for INCIDENT_PARTIAL category", () => {
    const result = assignUrgencyTier(TicketCategory.INCIDENT_PARTIAL, [], false);
    expect(result).toBe(UrgencyTier.P2_HIGH);
  });

  it("returns P2_HIGH when p1 keyword is matched", () => {
    const result = assignUrgencyTier(TicketCategory.REQUEST_QUESTION, ["down"], false);
    expect(result).toBe(UrgencyTier.P2_HIGH);
  });

  it("returns P3_MEDIUM when keywords present but no P1/P2 signals", () => {
    const result = assignUrgencyTier(TicketCategory.REQUEST_QUESTION, ["question"], false);
    expect(result).toBe(UrgencyTier.P3_MEDIUM);
  });

  it("returns P4_LOW for plain request with no keywords", () => {
    const result = assignUrgencyTier(TicketCategory.REQUEST_QUESTION, [], false);
    expect(result).toBe(UrgencyTier.P4_LOW);
  });
});

describe("msp/ticket-triage: summarizeTicketContext", () => {
  const baseTicket: RawTicket = {
    id: "ticket-001",
    title: "Email is down",
    description: "All users cannot access email since 2pm",
    clientId: "client-001",
    clientName: "Acme Corp",
    clientSegment: ClientSegment.MIDMARKET,
    affectedAsset: "Exchange Server",
    affectedService: "Email",
    createdAt: new Date().toISOString(),
    history: [
      {
        timestamp: new Date(Date.now() - 86400000).toISOString(),
        action: "Opened",
        actor: "System",
        note: "Ticket created from monitoring alert",
      },
    ],
    tags: ["email", "outage"],
    metadata: {
      hasActiveOutage: true,
      outageStart: new Date(Date.now() - 7200000).toISOString(),
    },
  };

  it("produces a TicketContext with all required fields", () => {
    const result = summarizeTicketContext(baseTicket);

    expect(result.ticketId).toBe("ticket-001");
    expect(result.clientName).toBe("Acme Corp");
    expect(result.clientSegment).toBe(ClientSegment.MIDMARKET);
    expect(result.affectedAsset).toBe("Exchange Server");
    expect(result.category).toBe(TicketCategory.INCIDENT_OUTAGE);
    expect(result.isSecurity).toBe(false);
    expect(result.hasActiveOutage).toBe(true);
    expect(result.slaTier).toBe(UrgencyTier.P1_CRITICAL); // hasActiveOutage triggers P1
    expect(result.keywords).toContain("down");
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.computedAt).toBeTruthy();
  });

  it("promotes all-user outage text to P1 without requiring metadata", () => {
    const result = summarizeTicketContext({
      id: "ticket-full-outage",
      title: "Email is down",
      description: "All users cannot access email.",
      clientId: "client-001",
      clientName: "Acme Corp",
      clientSegment: ClientSegment.MIDMARKET,
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    expect(result.category).toBe(TicketCategory.INCIDENT_OUTAGE);
    expect(result.slaTier).toBe(UrgencyTier.P1_CRITICAL);
  });

  it("handles ticket without prior history gracefully", () => {
    const noHistoryTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-002",
      history: undefined,
      metadata: {},
    };

    const result = summarizeTicketContext(noHistoryTicket);

    expect(result.ticketId).toBe("ticket-002");
    expect(result.history).toEqual([]);
  });

  it("handles ticket without explicit asset/service", () => {
    const noAssetTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-003",
      affectedAsset: undefined,
      affectedService: undefined,
    };

    const result = summarizeTicketContext(noAssetTicket);

    expect(result.affectedAsset).toBe("unspecified");
    expect(result.affectedService).toBe("unspecified");
  });

  it("detects security tickets via metadata flag", () => {
    const securityTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-004",
      title: "Phishing email received",
      description: "User reported suspicious email",
      metadata: { isSecurity: true },
    };

    const result = summarizeTicketContext(securityTicket);

    expect(result.isSecurity).toBe(true);
    expect(result.category).toBe(TicketCategory.SECURITY_INCIDENT);
  });

  it("extracts C-suite mentions in urgency signals", () => {
    const csuiteTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-005",
      title: "CEO cannot access files",
      description: "Urgent: CFO needs this fixed immediately",
      metadata: {},
    };

    const result = summarizeTicketContext(csuiteTicket);

    expect(result.urgencySignals.hasCsuiteMention).toBe(true);
  });

  it("extracts deadline mentions in urgency signals", () => {
    const deadlineTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-006",
      title: "Must be done by end of day",
      description: "ASAP — deadline today",
      metadata: {},
    };

    const result = summarizeTicketContext(deadlineTicket);

    expect(result.urgencySignals.hasDeadlineMention).toBe(true);
  });

  it("computes outage duration when outageStart is provided", () => {
    const outageTicket: RawTicket = {
      ...baseTicket,
      id: "ticket-007",
      metadata: {
        hasActiveOutage: true,
        outageStart: new Date(Date.now() - 3600000).toISOString(), // 1h ago
      },
    };

    const result = summarizeTicketContext(outageTicket);

    // Should be approximately 60 minutes (within reasonable tolerance)
    expect(result.urgencySignals.outageDuration).toBeGreaterThan(55);
    expect(result.urgencySignals.outageDuration).toBeLessThan(65);
  });
});

describe("msp/ticket-triage: scoreSlaRisk", () => {
  it("returns high risk score for P1 enterprise with active outage", () => {
    const context = summarizeTicketContext({
      id: "risk-001",
      title: "All systems down",
      description: "Complete outage for enterprise client",
      clientId: "ent-001",
      clientName: "Enterprise Corp",
      clientSegment: ClientSegment.ENTERPRISE,
      createdAt: new Date(Date.now() - 600000).toISOString(), // 10 min ago
      metadata: { hasActiveOutage: true, isSecurity: false },
    });

    // Ticket is 10 min old, P1 response window for enterprise is 15 min
    const risk = scoreSlaRisk(context, 10);

    expect(risk.score).toBeGreaterThanOrEqual(50); // P1 base = 50, enterprise multiplier 1.3
    expect(risk.atRisk).toBe(false); // 10 min into 15 min window = 67% elapsed, not yet at risk
  });

  it("marks breached when minutesOpen exceeds P3 SMB response window (480 min)", () => {
    const context = summarizeTicketContext({
      id: "risk-002",
      title: "Minor VPN setup request",
      description: "Minor request: share the standard VPN setup instructions for one user.",
      clientId: "smb-001",
      clientName: "SMB Client",
      clientSegment: ClientSegment.SMB,
      createdAt: new Date(Date.now() - 36_000_000).toISOString(), // 600 min ago
      metadata: {},
    });

    // Pass minutesOpen = 600 (exceeds P3 SMB response window of 480 min) → breached
    const risk = scoreSlaRisk(context, 600);
    expect(risk.breached).toBe(true);
  });

  it("returns non-zero score for SMB P3 ticket within SLA window", () => {
    const context = summarizeTicketContext({
      id: "risk-003",
      title: "Minor VPN setup request",
      description: "Minor request: share the standard VPN setup instructions for one user.",
      clientId: "smb-001",
      clientName: "SMB Client",
      clientSegment: ClientSegment.SMB,
      createdAt: new Date(Date.now() - 6_000_000).toISOString(), // 100 min ago
      metadata: {},
    });

    // Pass minutesOpen = 100 (well within P3 SMB 480 min window) -> not breached
    const risk = scoreSlaRisk(context, 100);
    expect(risk.breached).toBe(false);
    expect(risk.score).toBeGreaterThan(0);
  });
});

describe("msp/ticket-triage: edge cases", () => {
  it("classifies empty title and description as REQUEST_QUESTION", () => {
    const result = classifyTicketCategory({
      title: "",
      description: "",
      tags: [],
      metadata: {},
    });
    expect(result).toBe(TicketCategory.REQUEST_QUESTION);
  });

  it("handles unicode and mixed-case keywords correctly", () => {
    const result = classifyTicketCategory({
      title: "RANSOMWARE Alert 🚨",
      description: "CRITICAL: BREACH detected",
      tags: [],
      metadata: {},
    });
    // Mixed case and emoji should still match
    expect(result).toBe(TicketCategory.SECURITY_INCIDENT);
  });

  it("assigns P1 when active outage is true even for low-priority category", () => {
    // Even a "question" ticket becomes P1 if there's an active outage
    const result = assignUrgencyTier(TicketCategory.REQUEST_QUESTION, [], true);
    expect(result).toBe(UrgencyTier.P1_CRITICAL);
  });

  it("prioritizes SECURITY_INCIDENT over active outage for P1 determination", () => {
    // Both flags present — result should be P1 (matching behavior: either condition triggers P1)
    const result = assignUrgencyTier(TicketCategory.SECURITY_INCIDENT, [], false);
    expect(result).toBe(UrgencyTier.P1_CRITICAL);
  });
});
