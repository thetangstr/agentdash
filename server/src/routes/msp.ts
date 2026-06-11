/**
 * MSP Agent Routes — Ticket Triage, SLA Dispatch, Health & QBR
 *
 * Mounted at /api/msp/*
 * Integrates: ticket taxonomy (AGE-3), ticket summarizer (AGE-4),
 * SLA dispatch (AGE-5), health metrics (AGE-6), QBR generator (AGE-7).
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import {
  generateQbrDraft,
  generateQbrPackSummary,
  formatQbrAsText,
} from "../services/msp/qbr-generator.js";
import { generateHealthScore } from "../services/msp/health-metrics.js";
import type { WeeklyMetricData } from "../services/msp/health-metrics.js";
import { ClientSegment, TicketCategory, UrgencyTier, type TicketContext } from "../types/msp-taxonomy.js";

// ─── Mock data helpers ───────────────────────────────────────────────────────
// TODO(AGE-7): Replace with real DB queries against AgentDash CRM schema.
//   Ticket data   → AgentDash tickets table
//   Risk data     → tickets + security_findings tables
//   Contract data → contracts + proposals tables

function areMspDemoRoutesEnabled(): boolean {
  return process.env.AGENTDASH_MSP_DEMO_ROUTES === "true";
}

function assertMspDemoRoutesEnabled(res: Response): boolean {
  if (areMspDemoRoutesEnabled()) return true;
  res.status(404).json({
    error: "MSP demo routes are disabled",
    detail: "Set AGENTDASH_MSP_DEMO_ROUTES=true to expose mock MSP health and QBR endpoints.",
  });
  return false;
}

function buildMockMetricData(
  clientId: string,
  clientName: string,
  weekStart: string,
  weekEnd: string,
): WeeklyMetricData {
  return {
    clientId,
    clientName,
    weekStart,
    weekEnd,
    ticketVolume: {
      total: 14,
      byCategory: {
        incident_outage: 3,
        request_change: 5,
        request_access: 4,
        admin_billing: 2,
      },
      byPriority: { P1: 1, P2: 4, P3: 6, P4: 3 },
    },
    resolutionTime: {
      avgHours: 6.4,
      medianHours: 4.2,
      p95Hours: 18.1,
      withinSlaCount: 11,
      breachCount: 3,
    },
    slaAdherence: {
      totalTickets: 14,
      onTimeCount: 11,
      adherencePercent: 78.6,
    },
    openRisks: {
      count: 2,
      items: [
        { id: "risk-1", description: "Azure AD sync failure affecting 12 users", severity: "high", openSince: weekStart },
        { id: "risk-2", description: "Backup job failing for past 5 days", severity: "medium", openSince: weekStart },
      ],
    },
    securityFindings: {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      lastScanDate: weekEnd,
    },
    renewalSignals: {
      contractEndDate: "2026-09-30",
      npsScore: 7,
      healthCheckComplete: false,
      expansionContractionSignals: "stable",
      notes: ["Renewal 90 days out", "Mid-year review scheduled"],
    },
  };
}

function resolveMspCompanyId(req: Request, res: Response): string | null {
  const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
  if (!companyId) {
    res.status(400).json({ error: "companyId query parameter is required" });
    return null;
  }
  assertCompanyAccess(req, companyId);
  return companyId;
}

function buildMockOpenTickets(): TicketContext[] {
  const now = new Date().toISOString();
  const midmarketSignals = (keywords: string[]) => ({
    slaWindowMinutes: 60,
    keywordMatches: keywords,
    clientTierLabel: ClientSegment.MIDMARKET,
    hasCsuiteMention: false,
    hasDeadlineMention: false,
  });

  return [
    {
      ticketId: "tkt-001",
      clientName: "Acme Corp (Mid-Market)",
      clientSegment: ClientSegment.MIDMARKET,
      affectedAsset: "Azure AD / Identity",
      affectedService: "Identity",
      category: TicketCategory.INCIDENT_OUTAGE,
      title: "Azure AD sync failure - users unable to authenticate",
      description: "Users are unable to authenticate because Azure AD sync is failing.",
      history: [],
      urgencySignals: midmarketSignals(["azure", "authentication", "login failure"]),
      isSecurity: false,
      isRevenueAffecting: true,
      hasActiveOutage: true,
      keywords: ["azure", "authentication", "login failure"],
      slaTier: UrgencyTier.P1_CRITICAL,
      computedAt: now,
    },
    {
      ticketId: "tkt-002",
      clientName: "Acme Corp (Mid-Market)",
      clientSegment: ClientSegment.MIDMARKET,
      affectedAsset: "Backup Infrastructure",
      affectedService: "Backup",
      category: TicketCategory.INCIDENT_OUTAGE,
      title: "Weekly backup job failed - Veeam error 0x80042308",
      description: "Weekly backup job failed with Veeam error 0x80042308.",
      history: [],
      urgencySignals: midmarketSignals(["backup", "veeam", "storage"]),
      isSecurity: false,
      isRevenueAffecting: false,
      hasActiveOutage: false,
      keywords: ["backup", "veeam", "storage"],
      slaTier: UrgencyTier.P2_HIGH,
      computedAt: now,
    },
    {
      ticketId: "tkt-003",
      clientName: "Acme Corp (Mid-Market)",
      clientSegment: ClientSegment.MIDMARKET,
      affectedAsset: "Active Directory / O365",
      affectedService: "User provisioning",
      category: TicketCategory.REQUEST_ACCESS,
      title: "New user onboarding - finance team hire",
      description: "Provision accounts and access for a new finance team hire.",
      history: [],
      urgencySignals: midmarketSignals(["onboarding", "new hire", "provisioning"]),
      isSecurity: false,
      isRevenueAffecting: false,
      hasActiveOutage: false,
      keywords: ["onboarding", "new hire", "provisioning"],
      slaTier: UrgencyTier.P3_MEDIUM,
      computedAt: now,
    },
  ];
}

// ─── Week utilities ──────────────────────────────────────────────────────────

function computeWeekRange(weekOffset = 0): { weekStart: string; weekEnd: string; isoWeek: string } {
  const now = new Date();
  now.setDate(now.getDate() + weekOffset * 7);
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // ISO week number
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const weekNum = Math.ceil(
    (thursday.getTime() - new Date(thursday.getFullYear(), 0, 1).getTime()) / (7 * 86400000),
  );
  return {
    weekStart: fmt(monday),
    weekEnd: fmt(sunday),
    isoWeek: `${monday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`,
  };
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function mspRoutes(_db: Db) {
  const router = Router();

  /**
   * GET /api/msp/health/clients
   * Returns all known clients (mock for now — real impl queries CRM).
   */
  router.get("/health/clients", async (req, res) => {
    if (!assertMspDemoRoutesEnabled(res)) return;
    const companyId = resolveMspCompanyId(req, res);
    if (!companyId) return;
    // TODO: Query AgentDash CRM for active clients
    const mockClients = [
      { clientId: "client-001", clientName: "Acme Corp (Mid-Market)", segment: "midmarket" },
      { clientId: "client-002", clientName: "GlobalTech Solutions", segment: "enterprise" },
      { clientId: "client-003", clientName: "Summit Ridge Dental", segment: "smb" },
    ];
    res.json({ clients: mockClients });
  });

  /**
   * GET /api/msp/health/:clientId/qbr
   * Query params: week (ISO week string, e.g. "2026-W21"), weekOffset (0=current, -1=last week)
   *
   * Produces a weekly client health QBR draft for operator review.
   * Covers all 5 health metrics + composite score + written operator brief.
   *
   * Acceptance criteria:
   *   (1) report covers all 5 health metrics
   *   (2) includes written summary and risk callouts
   *   (3) output is in a human-reviewable format (JSON + text variant)
   */
  router.get("/health/:clientId/qbr", async (req, res) => {
    if (!assertMspDemoRoutesEnabled(res)) return;
    const companyId = resolveMspCompanyId(req, res);
    if (!companyId) return;

    const { clientId } = req.params;
    const weekParam = req.query.week as string | undefined;
    const weekOffset = parseInt(req.query.weekOffset as string ?? "0", 10);

    // Determine week range
    let weekStart: string, weekEnd: string, isoWeek: string;
    if (weekParam) {
      // Parse ISO week string "2026-W21"
      const match = weekParam.match(/^(\d{4})-W(\d{2})$/);
      if (!match) {
        res.status(400).json({ error: "Invalid week format. Use YYYY-WXX (e.g. 2026-W21)." });
        return;
      }
      const year = parseInt(match[1], 10);
      const week = parseInt(match[2], 10);
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dow = simple.getDay();
      const weekMonday = new Date(simple);
      weekMonday.setDate(simple.getDate() + (dow <= 4 ? 1 - dow : 8 - dow));
      const weekSunday = new Date(weekMonday);
      weekSunday.setDate(weekMonday.getDate() + 6);
      const pad = (n: number) => String(n).padStart(2, "0");
      weekStart = `${weekMonday.getFullYear()}-${pad(weekMonday.getMonth() + 1)}-${pad(weekMonday.getDate())}`;
      weekEnd = `${weekSunday.getFullYear()}-${pad(weekSunday.getMonth() + 1)}-${pad(weekSunday.getDate())}`;
      isoWeek = weekParam;
    } else {
      const computed = computeWeekRange(weekOffset);
      weekStart = computed.weekStart;
      weekEnd = computed.weekEnd;
      isoWeek = computed.isoWeek;
    }

    // TODO(AGE-7): Replace mock with real DB aggregation:
    //   - Fetch ticket data for clientId + date range from AgentDash CRM
    //   - Fetch security findings
    //   - Fetch contract + renewal signals
    const metricData = buildMockMetricData(clientId, clientId, weekStart, weekEnd);
    const openTickets = buildMockOpenTickets();

    // Generate QBR
    const draft = generateQbrDraft(metricData, openTickets);
    const textFormat = formatQbrAsText(draft);

    res.json({
      draft,
      textFormat,
      meta: {
        clientId,
        week: isoWeek,
        periodStart: weekStart,
        periodEnd: weekEnd,
        generatedAt: draft.generatedAt,
        note: "Generated by AgentDash MSP Health Agent. Data is mock for first-week deliverable; replace with live CRM queries.",
      },
    });
  });

  /**
   * GET /api/msp/health/qbr-pack
   * Returns an aggregated QBR pack across all clients for the week.
   * Useful for operators reviewing the full client roster.
   */
  router.get("/health/qbr-pack", async (req, res) => {
    if (!assertMspDemoRoutesEnabled(res)) return;
    const companyId = resolveMspCompanyId(req, res);
    if (!companyId) return;

    const weekOffset = parseInt(req.query.weekOffset as string ?? "0", 10);
    const computed = computeWeekRange(weekOffset);

    // TODO: Query all active clients from CRM, iterate + aggregate
    const mockClientIds = [
      { clientId: "client-001", clientName: "Acme Corp (Mid-Market)" },
      { clientId: "client-002", clientName: "GlobalTech Solutions" },
      { clientId: "client-003", clientName: "Summit Ridge Dental" },
    ];

    const clientScores = mockClientIds.map(({ clientId, clientName }) => {
      const metricData = buildMockMetricData(clientId, clientName, computed.weekStart, computed.weekEnd);
      const openTickets: TicketContext[] = [];
      return generateHealthScore(metricData);
    });

    const summary = generateQbrPackSummary(clientScores);

    res.json({
      summary,
      week: computed.isoWeek,
      periodStart: computed.weekStart,
      periodEnd: computed.weekEnd,
      generatedAt: new Date().toISOString(),
      note: "Aggregated QBR pack. Data is mock for first-week deliverable.",
    });
  });

  return router;
}
