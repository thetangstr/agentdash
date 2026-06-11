/**
 * MSP Ticket Triage Taxonomy & SLA Risk Classification Schema
 * Issue: AGE-3 | Goal: MSP ticket triage and SLA dispatch automation
 *
 * This module defines:
 * 1. Ticket category taxonomy (how to classify inbound MSP tickets)
 * 2. Urgency tier system (P1–P4 with SLA windows)
 * 3. SLA risk scoring logic (0–100, threshold-based)
 * 4. Client segment tiers
 */

import { z } from "zod";

// ─── Client Segments ────────────────────────────────────────────────────────

export enum ClientSegment {
  SMB = "smb",            // ≤50 seats, reactive support
  MIDMARKET = "midmarket", // 51–500 seats, proactive support
  ENTERPRISE = "enterprise", // 500+ seats, dedicated CSM
}

export const ClientSegmentLabels: Record<ClientSegment, string> = {
  [ClientSegment.SMB]: "SMB (≤50 seats)",
  [ClientSegment.MIDMARKET]: "Mid-Market (51–500 seats)",
  [ClientSegment.ENTERPRISE]: "Enterprise (500+ seats)",
};

// ─── Ticket Categories ─────────────────────────────────────────────────────

export enum TicketCategory {
  // Infrastructure
  INCIDENT_OUTAGE = "incident_outage",     // Service down, degraded performance
  INCIDENT_PARTIAL = "incident_partial",  // Partial degradation
  SECURITY_INCIDENT = "security_incident", // Breach, compromise, ransomware
  SECURITY_QUESTION = "security_question", // Vulnerability scan finding, hardening query

  // Requests
  REQUEST_CHANGE = "request_change",      // Planned change, maintenance
  REQUEST_ACCESS = "request_access",       // User provisioning, permissions
  REQUEST_QUESTION = "request_question",   // How-to, best practice
  REQUEST_BUG = "request_bug",             // Bug report, defect

  // Ongoing
  ONGOING_PROJECT = "ongoing_project",     // In-flight project ticket
  ONGOING_MONTHLY = "ongoing_monthly",     // Recurring retainer work

  // Administrative
  ADMIN_BILLING = "admin_billing",         // Invoice, subscription, quotes
  ADMIN_RENEWAL = "admin_renewal",          // Renewal, upsell, churn risk
  ADMIN_OTHER = "admin_other",              // General admin, not classified above
}

export const TicketCategoryLabels: Record<TicketCategory, string> = {
  [TicketCategory.INCIDENT_OUTAGE]: "Incident — Full Outage",
  [TicketCategory.INCIDENT_PARTIAL]: "Incident — Partial Degradation",
  [TicketCategory.SECURITY_INCIDENT]: "Security Incident",
  [TicketCategory.SECURITY_QUESTION]: "Security Question / Finding",
  [TicketCategory.REQUEST_CHANGE]: "Change Request",
  [TicketCategory.REQUEST_ACCESS]: "Access / Provisioning Request",
  [TicketCategory.REQUEST_QUESTION]: "General Question / How-To",
  [TicketCategory.REQUEST_BUG]: "Bug Report",
  [TicketCategory.ONGOING_PROJECT]: "Ongoing Project",
  [TicketCategory.ONGOING_MONTHLY]: "Monthly Retainer Work",
  [TicketCategory.ADMIN_BILLING]: "Billing / Invoice",
  [TicketCategory.ADMIN_RENEWAL]: "Renewal / Upsell / Churn",
  [TicketCategory.ADMIN_OTHER]: "Other Admin",
};

// ─── Urgency Tiers ──────────────────────────────────────────────────────────

/**
 * Urgency tiers with SLA response windows.
 * Response = first meaningful human engagement.
 * Resolution = ticket fully closed, root cause addressed or workaround confirmed.
 */
export enum UrgencyTier {
  P1_CRITICAL = "p1_critical", // Business-critical system down for ALL users
  P2_HIGH = "p2_high",         // Major feature broken for multiple users / SLA at risk
  P3_MEDIUM = "p3_medium",     // Feature degraded, workaround exists, SLA safe
  P4_LOW = "p4_low",           // General request, no SLA, best-effort
}

export interface SlaWindow {
  responseMinutes: number;   // Max minutes to first meaningful response
  resolutionMinutes: number; // Max minutes to resolution (or acceptable workaround)
  businessHoursOnly: boolean;
}

export const SlaWindows: Record<UrgencyTier, Record<ClientSegment, SlaWindow>> = {
  [UrgencyTier.P1_CRITICAL]: {
    [ClientSegment.SMB]:        { responseMinutes: 15,  resolutionMinutes: 240,  businessHoursOnly: false },
    [ClientSegment.MIDMARKET]:  { responseMinutes: 15,  resolutionMinutes: 180,  businessHoursOnly: false },
    [ClientSegment.ENTERPRISE]: { responseMinutes: 15,  resolutionMinutes: 120,  businessHoursOnly: false },
  },
  [UrgencyTier.P2_HIGH]: {
    [ClientSegment.SMB]:        { responseMinutes: 60,  resolutionMinutes: 480,  businessHoursOnly: false },
    [ClientSegment.MIDMARKET]:  { responseMinutes: 60,  resolutionMinutes: 360,  businessHoursOnly: false },
    [ClientSegment.ENTERPRISE]: { responseMinutes: 30,  resolutionMinutes: 240,  businessHoursOnly: false },
  },
  [UrgencyTier.P3_MEDIUM]: {
    [ClientSegment.SMB]:        { responseMinutes: 480, resolutionMinutes: 2880, businessHoursOnly: true },
    [ClientSegment.MIDMARKET]:  { responseMinutes: 240, resolutionMinutes: 1440, businessHoursOnly: true },
    [ClientSegment.ENTERPRISE]: { responseMinutes: 120, resolutionMinutes: 720,  businessHoursOnly: true },
  },
  [UrgencyTier.P4_LOW]: {
    [ClientSegment.SMB]:        { responseMinutes: 1440, resolutionMinutes: 10080, businessHoursOnly: true },
    [ClientSegment.MIDMARKET]:  { responseMinutes: 720,  resolutionMinutes: 7200,  businessHoursOnly: true },
    [ClientSegment.ENTERPRISE]: { responseMinutes: 480,  resolutionMinutes: 2880,  businessHoursOnly: true },
  },
};

export const UrgencyTierLabels: Record<UrgencyTier, string> = {
  [UrgencyTier.P1_CRITICAL]: "P1 — Critical (Business Down)",
  [UrgencyTier.P2_HIGH]: "P2 — High (Major Impact / SLA Risk)",
  [UrgencyTier.P3_MEDIUM]: "P3 — Medium (Degraded / Workaround Available)",
  [UrgencyTier.P4_LOW]: "P4 — Low (General Request)",
};

// ─── Skill Tags ─────────────────────────────────────────────────────────────

/** Skill tags used to match tickets to engineers */
export enum SkillTag {
  WINDOWS = "windows",
  LINUX = "linux",
  MACOS = "macos",
  NETWORK = "network",
  SECURITY = "security",
  CLOUD_AZURE = "cloud_azure",
  CLOUD_AWS = "cloud_aws",
  CLOUD_GCP = "cloud_gcp",
  M365 = "m365",
  GOOGLE_WORKSPACE = "google_workspace",
  BACKUP = "backup",
  MONITORING = "monitoring",
  TIER1 = "tier1",
  TIER2 = "tier2",
  TIER3 = "tier3",
  ACCOUNT_MANAGER = "account_manager",
  BILLING_ADMIN = "billing_admin",
}

// ─── SLA Risk Score ─────────────────────────────────────────────────────────

export interface SlaRiskScore {
  score: number;           // 0–100 (higher = more risk)
  tier: "critical" | "high" | "medium" | "low";
  atRisk: boolean;         // true if breach is likely without immediate action
  minutesUntilBreach: number | null;  // null if no SLA at risk
  breached: boolean;
}

/**
 * Compute SLA risk score from ticket metadata.
 *
 * Score components:
 *  - Urgency tier (P1=50, P2=35, P3=15, P4=0 base)
 *  - SLA proximity: up to +30 as breach window approaches
 *  - Client segment multiplier: Enterprise=1.3, Midmarket=1.1, SMB=1.0
 *  - Security flag: +15
 *  - Revenue-at-risk flag: +5
 */
export function computeSlaRiskScore(params: {
  urgency: UrgencyTier;
  segment: ClientSegment;
  minutesOpen: number;
  slaWindow: SlaWindow;
  isSecurity: boolean;
  isRevenueAffecting: boolean;
  hasActiveOutage: boolean;
}): SlaRiskScore {
  const { urgency, segment, minutesOpen, slaWindow, isSecurity, isRevenueAffecting, hasActiveOutage } = params;

  // Base score by urgency tier
  const urgencyBase: Record<UrgencyTier, number> = {
    [UrgencyTier.P1_CRITICAL]: 50,
    [UrgencyTier.P2_HIGH]: 35,
    [UrgencyTier.P3_MEDIUM]: 15,
    [UrgencyTier.P4_LOW]: 0,
  };

  // Segment multiplier (enterprise clients have tighter expectations)
  const segmentMultiplier: Record<ClientSegment, number> = {
    [ClientSegment.ENTERPRISE]: 1.3,
    [ClientSegment.MIDMARKET]: 1.1,
    [ClientSegment.SMB]: 1.0,
  };

  // Calculate SLA proximity
  const remainingMinutes = slaWindow.responseMinutes - minutesOpen;
  const timeElapsedFraction = Math.min(minutesOpen / slaWindow.responseMinutes, 1);
  const slaProximity = timeElapsedFraction > 0.7
    ? (timeElapsedFraction - 0.7) / 0.3 * 30  // +0 to +30 in final 30% of window
    : 0;

  let score = urgencyBase[urgency];
  score += slaProximity;
  if (isSecurity) score += 15;
  if (isRevenueAffecting) score += 5;
  if (hasActiveOutage) score += 10;
  score *= segmentMultiplier[segment];

  const tier: SlaRiskScore["tier"] =
    score >= 80 ? "critical" :
    score >= 55 ? "high" :
    score >= 25 ? "medium" : "low";

  const breached = remainingMinutes < 0;
  const atRisk = !breached && remainingMinutes < slaWindow.responseMinutes * 0.25; // risk if <25% time remains

  return {
    score: Math.round(Math.min(score, 100)),
    tier,
    atRisk,
    minutesUntilBreach: breached ? null : remainingMinutes,
    breached,
  };
}

// ─── Dispatch Recommendation ───────────────────────────────────────────────

export interface DispatchRecommendation {
  urgency: UrgencyTier;
  category: TicketCategory;
  slaRisk: SlaRiskScore;
  suggestedAssignee: string | null;   // agent ID or name
  suggestedSkillTags: SkillTag[];
  nextSteps: string[];
  internalNote: string;
  /** Per-ticket escalation flags (e.g. SLA breached, active outage) */
  escalationFlags: string[];
  /** Alternative assignee candidates ranked by fit score */
  alternativeAssignees: Array<{ agentId: string; agentName: string; reason: string; fitScore: number }>;
  /** Confidence score 0-1 for the dispatch decision */
  confidence: number;
  /** Urgency tier adjustment recommendation */
  urgencyOverride: "upgrade" | "downgrade" | "confirm" | null;
  /** Estimated hours to resolution */
  estimatedResolutionHours: number | null;
  /** Human-readable SLA action recommendation */
  slaRecommendation: string;
  /** Model label used to generate this recommendation */
  modelUsed: string;
  /** ISO timestamp of generation */
  generatedAt: string;
}

// ─── Ticket Context Object (output of AGE-4 summarizer) ─────────────────────

export interface TicketContext {
  ticketId: string;
  clientName: string;
  clientSegment: ClientSegment;
  affectedAsset: string;
  affectedService: string;
  category: TicketCategory;
  title: string;
  description: string;
  history: TicketHistoryEntry[];
  urgencySignals: UrgencySignals;
  isSecurity: boolean;
  isRevenueAffecting: boolean;
  hasActiveOutage: boolean;
  keywords: string[];
  slaTier: UrgencyTier;
  computedAt: string; // ISO timestamp
}

export interface TicketHistoryEntry {
  timestamp: string;
  action: string;
  actor: string;
  note: string;
}

export interface UrgencySignals {
  slaWindowMinutes: number;
  keywordMatches: string[];       // matched urgency keywords from description
  clientTierLabel: string;
  hasCsuiteMention: boolean;
  hasDeadlineMention: boolean;
  outageDuration?: number;        // minutes if active outage
}

// ─── Zod Schemas for API Validation ────────────────────────────────────────

export const TicketContextSchema = z.object({
  ticketId: z.string(),
  clientName: z.string(),
  clientSegment: z.nativeEnum(ClientSegment),
  affectedAsset: z.string(),
  affectedService: z.string(),
  category: z.nativeEnum(TicketCategory),
  title: z.string(),
  description: z.string(),
  history: z.array(z.object({
    timestamp: z.string(),
    action: z.string(),
    actor: z.string(),
    note: z.string(),
  })),
  urgencySignals: z.object({
    slaWindowMinutes: z.number(),
    keywordMatches: z.array(z.string()),
    clientTierLabel: z.string(),
    hasCsuiteMention: z.boolean(),
    hasDeadlineMention: z.boolean(),
    outageDuration: z.number().optional(),
  }),
  isSecurity: z.boolean(),
  isRevenueAffecting: z.boolean(),
  hasActiveOutage: z.boolean(),
  keywords: z.array(z.string()),
  slaTier: z.nativeEnum(UrgencyTier),
  computedAt: z.string(),
});

// ─── Urgency Keyword Dictionary ─────────────────────────────────────────────

/** Keywords that signal elevated urgency when found in ticket description/title */
export const UrgencyKeywords: string[] = [
  // P1 signals
  "down", "outage", "offline", "not working", "cannot access",
  "critical", "emergency", "production", "breach", "ransomware",
  "all users", "everyone", "whole company", "entire team",
  // P2 signals
  "multiple users", "several people", "many users", "slow", "degraded",
  "slowness", "timeout", "error", "failing", "cannot connect",
  "sla", "risk", "deadline", "escalating",
  // P3 signals
  "when possible", "when you get a chance", "no rush", "minor",
  // Security signals
  "security", "vulnerability", "phishing", "malware", "compromised",
  "suspicious", "unauthorized", "mfa", "password", "attack",
];

export function extractUrgencyKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return UrgencyKeywords.filter(kw => lower.includes(kw));
}
