/**
 * MSP Ticket Context Summarizer Service
 * Issue: AGE-4 | Depends on: AGE-3 (taxonomy must exist first)
 *
 * Takes a raw inbound MSP ticket and extracts:
 * 1. Client name and segment
 * 2. Affected asset / service
 * 3. Ticket history and prior resolutions
 * 4. Urgency signals (keywords, SLA window, client tier)
 *
 * Output: structured TicketContext object attached to the ticket record.
 */

import {
  TicketContext,
  TicketHistoryEntry,
  UrgencySignals,
  UrgencyTier,
  TicketCategory,
  ClientSegment,
  SlaWindows,
  computeSlaRiskScore,
  extractUrgencyKeywords,
} from "../../types/msp-taxonomy.js";

export interface RawTicket {
  id: string;
  title: string;
  description: string;
  clientId: string;
  clientName: string;
  clientSegment: ClientSegment;
  affectedAsset?: string;
  affectedService?: string;
  createdAt: string; // ISO timestamp
  history?: Array<{
    timestamp: string;
    action: string;
    actor: string;
    note: string;
  }>;
  tags?: string[];
  metadata?: {
    isSecurity?: boolean;
    isRevenueAffecting?: boolean;
    hasActiveOutage?: boolean;
    outageStart?: string;
  };
}

/**
 * Classify a raw ticket into a TicketCategory based on content signals.
 * This is the routing logic that feeds into urgency assignment.
 */
export function classifyTicketCategory(ticket: Pick<RawTicket, "title" | "description" | "tags" | "metadata">): TicketCategory {
  const text = `${ticket.title} ${ticket.description}`.toLowerCase();
  const tags = (ticket.tags ?? []).map(t => t.toLowerCase());
  const meta = ticket.metadata ?? {};

  // Security signals
  if (meta.isSecurity || /breach|ransomware|compromised|phishing|malware|vulnerability|unauthorized/.test(text)) {
    return TicketCategory.SECURITY_INCIDENT;
  }
  if (tags.includes("security") || tags.includes("vulnerability")) {
    return TicketCategory.SECURITY_QUESTION;
  }

  // Incident signals
  if (/\b(down|outage|offline|critical|emergency|not working|cannot access)\b/.test(text)) {
    return TicketCategory.INCIDENT_OUTAGE;
  }
  if (/\b(degraded|slow|timeout|slowness|partial)\b/.test(text)) {
    return TicketCategory.INCIDENT_PARTIAL;
  }

  // Change / project signals
  if (/\b(change|maintenance|update|upgrade|migration)\b/.test(text)) {
    return TicketCategory.REQUEST_CHANGE;
  }

  // Access signals
  if (/\b(access|permission|provision|add user|remove user|mfa|unlock|reset)\b/.test(text)) {
    return TicketCategory.REQUEST_ACCESS;
  }

  // Bug signals
  if (/\b(bug|defect|error|issue|broken|failing)\b/.test(text)) {
    return TicketCategory.REQUEST_BUG;
  }

  // Admin signals
  if (/\b(billing|invoice|quote|subscription|price|cost)\b/.test(text)) {
    return TicketCategory.ADMIN_BILLING;
  }
  if (/\b(renew|renewal|upsell|churn|cancel|expire)\b/.test(text)) {
    return TicketCategory.ADMIN_RENEWAL;
  }

  return TicketCategory.REQUEST_QUESTION;
}

/**
 * Assign urgency tier based on category and urgency keyword matches.
 */
export function assignUrgencyTier(
  category: TicketCategory,
  keywordMatches: string[],
  hasActiveOutage: boolean,
): UrgencyTier {
  // P1: full outage or active security incident
  if (hasActiveOutage) return UrgencyTier.P1_CRITICAL;
  if (category === TicketCategory.SECURITY_INCIDENT) return UrgencyTier.P1_CRITICAL;
  const outageKeywords = ["down", "outage", "offline", "not working", "cannot access"];
  const fullScopeKeywords = ["all users", "everyone", "whole company", "entire team", "production"];
  if (
    category === TicketCategory.INCIDENT_OUTAGE &&
    outageKeywords.some(k => keywordMatches.includes(k)) &&
    fullScopeKeywords.some(k => keywordMatches.includes(k))
  ) {
    return UrgencyTier.P1_CRITICAL;
  }

  // P2: partial degradation or high-urgency keyword match
  if (category === TicketCategory.INCIDENT_PARTIAL) return UrgencyTier.P2_HIGH;
  const p1Keywords = [...outageKeywords, "critical", "emergency", "breach", "ransomware"];
  if (p1Keywords.some(k => keywordMatches.includes(k))) return UrgencyTier.P2_HIGH;

  // P3: everything else with some urgency signal
  if (keywordMatches.length > 0) return UrgencyTier.P3_MEDIUM;

  return UrgencyTier.P4_LOW;
}

function buildHistory(history: RawTicket["history"] = []): TicketHistoryEntry[] {
  return history.map(h => ({
    timestamp: h.timestamp,
    action: h.action,
    actor: h.actor,
    note: h.note,
  }));
}

function buildUrgencySignals(params: {
  ticket: RawTicket;
  category: TicketCategory;
  urgency: UrgencyTier;
  keywordMatches: string[];
}): UrgencySignals {
  const { ticket, category, urgency, keywordMatches } = params;
  const segment = ticket.clientSegment;
  const slaWindow = SlaWindows[urgency][segment];

  const signals: UrgencySignals = {
    slaWindowMinutes: slaWindow.responseMinutes,
    keywordMatches,
    clientTierLabel: ticket.clientSegment,
    hasCsuiteMention: /ceo|cto|cfo|coo|vp |vice president|director of it/.test(
      `${ticket.title} ${ticket.description}`.toLowerCase()
    ),
    hasDeadlineMention: /deadline|asap|urgent|by end of|must be done/.test(
      `${ticket.title} ${ticket.description}`.toLowerCase()
    ),
  };

  if (ticket.metadata?.hasActiveOutage && ticket.metadata.outageStart) {
    const outageStart = new Date(ticket.metadata.outageStart).getTime();
    const now = Date.now();
    signals.outageDuration = Math.round((now - outageStart) / 60000);
  }

  return signals;
}

/**
 * Main summarizer function — produces a structured TicketContext from a raw ticket.
 * Handles tickets with and without prior history.
 */
export function summarizeTicketContext(ticket: RawTicket): TicketContext {
  const keywordMatches = extractUrgencyKeywords(`${ticket.title} ${ticket.description}`);
  const category = classifyTicketCategory(ticket);
  const hasActiveOutage = ticket.metadata?.hasActiveOutage ?? false;
  const urgency = assignUrgencyTier(category, keywordMatches, hasActiveOutage);
  const history = buildHistory(ticket.history);
  const urgencySignals = buildUrgencySignals({ ticket, category, urgency, keywordMatches });
  const isSecurity = ticket.metadata?.isSecurity ?? category === TicketCategory.SECURITY_INCIDENT;
  const isRevenueAffecting = ticket.metadata?.isRevenueAffecting ?? false;

  return {
    ticketId: ticket.id,
    clientName: ticket.clientName,
    clientSegment: ticket.clientSegment,
    affectedAsset: ticket.affectedAsset ?? "unspecified",
    affectedService: ticket.affectedService ?? "unspecified",
    category,
    title: ticket.title,
    description: ticket.description,
    history,
    urgencySignals,
    isSecurity,
    isRevenueAffecting,
    hasActiveOutage,
    keywords: keywordMatches,
    slaTier: urgency,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Compute SLA risk score for a given ticket context.
 */
export function scoreSlaRisk(context: TicketContext, minutesOpen: number) {
  const slaWindow = SlaWindows[context.slaTier][context.clientSegment];
  return computeSlaRiskScore({
    urgency: context.slaTier,
    segment: context.clientSegment,
    minutesOpen,
    slaWindow,
    isSecurity: context.isSecurity,
    isRevenueAffecting: context.isRevenueAffecting,
    hasActiveOutage: context.hasActiveOutage,
  });
}
