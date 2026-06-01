/**
 * Weekly Client Health Report Generator (QBR Draft Pack)
 * Issue: AGE-7 | Depends on: AGE-6
 *
 * Produces a weekly client health report:
 * 1. Aggregates the week's metrics from the health schema
 * 2. Generates a written operator brief (executive summary, top risks, open tickets, renewal/upsell signals)
 * 3. Formats it as a reviewable QBR draft pack
 *
 * Output: structured QBR draft document.
 */

import {
  ClientHealthScore,
  HealthMetric,
  HealthMetricLabels,
  HealthStatus,
  WeeklyMetricData,
  generateHealthScore,
} from "./health-metrics.js";
import { TicketContext } from "../../types/msp-taxonomy.js";

// ─── QBR Document Types ────────────────────────────────────────────────────

export interface QbrSection {
  heading: string;
  body: string;
  isActionRequired: boolean;
}

export interface QbrDraft {
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  overallStatus: HealthStatus;
  overallScore: number;
  executiveSummary: string;
  sections: QbrSection[];
  openTicketsSummary: string;
  riskCallouts: string[];
  renewalSignals: string[];
  operatorNotes: string;
  preparedBy: string;
  generatedAt: string;
  status: "draft" | "pending_review" | "approved";
}

// ─── Health Status Labels ──────────────────────────────────────────────────

const StatusEmoji: Record<HealthStatus, string> = {
  green: "✅",
  amber: "⚠️",
  red: "🔴",
};

const StatusLabel: Record<HealthStatus, string> = {
  green: "Healthy",
  amber: "Needs Attention",
  red: "At Risk",
};

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatNumber(n: number, decimals = 1): string {
  return typeof n === "number" ? n.toFixed(decimals) : "—";
}

/**
 * Generate a one-line status badge for a metric.
 */
function metricBadge(status: HealthStatus): string {
  return `${StatusEmoji[status]} ${StatusLabel[status]}`;
}

/**
 * Build the executive summary paragraph.
 */
function buildExecutiveSummary(score: ClientHealthScore): string {
  const status = metricBadge(score.overallStatus);
  const trend = score.componentScores.some(c => c.trend === "declining")
    ? " Trend is downward — review required."
    : score.componentScores.some(c => c.trend === "improving")
    ? " Trend is positive — current approach is working."
    : " Trends are stable.";

  const riskSummary = score.riskCallouts.length > 0
    ? ` ${score.riskCallouts.length} risk callout${score.riskCallouts.length !== 1 ? "s" : ""} identified.`
    : "";

  return `${score.clientName} health score: ${score.overallScore}/100 — ${status}.${trend}${riskSummary}`;
}

/**
 * Build the operator notes section.
 */
function buildOperatorNotes(score: ClientHealthScore): string {
  const notes: string[] = [];

  const redComponents = score.componentScores.filter(c => c.status === "red");
  if (redComponents.length > 0) {
    notes.push(`RED FLAGS: ${redComponents.map(c => HealthMetricLabels[c.metric]).join(", ")} require immediate attention.`);
  }

  const amberComponents = score.componentScores.filter(c => c.status === "amber");
  if (amberComponents.length > 0) {
    notes.push(`WATCH LIST: ${amberComponents.map(c => HealthMetricLabels[c.metric]).join(", ")} are trending — monitor closely.`);
  }

  const improvingComponents = score.componentScores.filter(c => c.trend === "improving");
  if (improvingComponents.length > 0) {
    notes.push(`IMPROVING: ${improvingComponents.map(c => HealthMetricLabels[c.metric]).join(", ")} showing positive trend.`);
  }

  if (score.componentScores.some(c => c.metric === HealthMetric.SLA_ADHERENCE && c.status !== "green")) {
    notes.push("SLA NOTE: SLA adherence is below target. Review escalation procedures and capacity.");
  }

  if (score.componentScores.some(c => c.metric === HealthMetric.SECURITY_FINDINGS && c.status !== "green")) {
    notes.push("SECURITY NOTE: Open security findings exist. Ensure remediation is scheduled and tracked.");
  }

  return notes.length > 0 ? notes.join("\n") : "No specific operator action required this week.";
}

/**
 * Generate the full QBR draft for a single client.
 */
export function generateQbrDraft(
  metricData: WeeklyMetricData,
  openTickets: TicketContext[],
  priorWeek?: WeeklyMetricData,
): QbrDraft {
  const score = generateHealthScore(metricData, priorWeek);

  // Build sections
  const sections: QbrSection[] = [];

  // 1. Metric breakdown
  const metricLines = score.componentScores
    .map(c => `**${HealthMetricLabels[c.metric]}**: ${c.score}/100 ${metricBadge(c.status)} — ${c.detail}`)
    .join("\n");

  sections.push({
    heading: "Metric Breakdown",
    body: metricLines,
    isActionRequired: score.componentScores.some(c => c.status !== "green"),
  });

  // 2. Open tickets summary
  const openTicketsSummary = openTickets.length === 0
    ? "No open tickets this week."
    : openTickets
        .map(t => `- [${t.slaTier.toUpperCase()}] ${t.title} (${t.category}, ${t.clientSegment})`)
        .join("\n");

  // 3. Top risks
  if (score.topRisks.length > 0) {
    sections.push({
      heading: "Top Risks",
      body: score.topRisks.map(r => `- ${r}`).join("\n"),
      isActionRequired: true,
    });
  }

  // 4. Renewal signals
  if (score.renewalSignals.length > 0) {
    sections.push({
      heading: "Renewal & Upsell Signals",
      body: score.renewalSignals.map(s => `- ${s}`).join("\n"),
      isActionRequired: score.renewalSignals.some(s => s.includes("churn") || s.includes("expansion")),
    });
  }

  // 5. Operator notes
  sections.push({
    heading: "Operator Notes",
    body: buildOperatorNotes(score),
    isActionRequired: score.componentScores.some(c => c.status === "red"),
  });

  const openTicketsSection = openTickets.length > 0
    ? openTickets.map(t => `[${t.slaTier.toUpperCase()}] ${t.title} — ${t.category}`).join("\n")
    : "No open tickets.";

  return {
    clientId: metricData.clientId,
    clientName: metricData.clientName,
    periodStart: metricData.weekStart,
    periodEnd: metricData.weekEnd,
    overallStatus: score.overallStatus,
    overallScore: score.overallScore,
    executiveSummary: buildExecutiveSummary(score),
    sections,
    openTicketsSummary: openTicketsSection,
    riskCallouts: score.riskCallouts,
    renewalSignals: score.renewalSignals,
    operatorNotes: buildOperatorNotes(score),
    preparedBy: "AgentDash MSP Health Agent",
    generatedAt: new Date().toISOString(),
    status: "draft",
  };
}

/**
 * Generate a multi-client QBR pack summary (for internal operator view).
 */
export function generateQbrPackSummary(
  clientScores: ClientHealthScore[],
): {
  totalClients: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  avgScore: number;
  atRiskClients: string[];
  improvingClients: string[];
  summaryByStatus: string;
} {
  const greenCount = clientScores.filter(s => s.overallStatus === "green").length;
  const amberCount = clientScores.filter(s => s.overallStatus === "amber").length;
  const redCount = clientScores.filter(s => s.overallStatus === "red").length;
  const avgScore = clientScores.length > 0
    ? Math.round(clientScores.reduce((sum, s) => sum + s.overallScore, 0) / clientScores.length)
    : 0;

  const atRiskClients = clientScores
    .filter(s => s.overallStatus === "red" || s.overallStatus === "amber")
    .map(s => `${s.clientName} (${s.overallScore}/100 ${metricBadge(s.overallStatus)})`);

  const improvingClients = clientScores
    .filter(s => s.componentScores.some(c => c.trend === "improving"))
    .map(s => s.clientName);

  const summaryByStatus = [
    `${StatusEmoji.green} ${greenCount} healthy`,
    `${StatusEmoji.amber} ${amberCount} needs attention`,
    `${StatusEmoji.red} ${redCount} at risk`,
  ].join(" | ");

  return {
    totalClients: clientScores.length,
    greenCount,
    amberCount,
    redCount,
    avgScore,
    atRiskClients,
    improvingClients,
    summaryByStatus,
  };
}

/**
 * Format QBR draft as a readable text document (for review / Slack digest).
 */
export function formatQbrAsText(draft: QbrDraft): string {
  const lines: string[] = [];
  lines.push("═".repeat(60));
  lines.push(`QBR DRAFT — ${draft.clientName}`);
  lines.push(`${formatDate(draft.periodStart)} → ${formatDate(draft.periodEnd)}`);
  lines.push(`Overall Score: ${draft.overallScore}/100  ${metricBadge(draft.overallStatus)}`);
  lines.push("═".repeat(60));
  lines.push("");
  lines.push("EXECUTIVE SUMMARY");
  lines.push("-".repeat(40));
  lines.push(draft.executiveSummary);
  lines.push("");

  for (const section of draft.sections) {
    lines.push(section.heading.toUpperCase());
    lines.push("-".repeat(40));
    lines.push(section.body);
    if (section.isActionRequired) lines.push("[ACTION REQUIRED]");
    lines.push("");
  }

  lines.push("OPEN TICKETS");
  lines.push("-".repeat(40));
  lines.push(draft.openTicketsSummary);
  lines.push("");
  lines.push(`Generated: ${formatDate(draft.generatedAt)} | Status: ${draft.status.toUpperCase()}`);
  lines.push("═".repeat(60));

  return lines.join("\n");
}
