/**
 * Client Health Metrics Schema & KPI Definitions
 * Issue: AGE-6 | Goal: Client health and QBR reporting pack
 *
 * Defines:
 * 1. Five health metrics with data sources
 * 2. Health score formula (green / amber / red)
 * 3. Aggregation logic for weekly reports
 */

import { z } from "zod";

// ─── Health Metrics ────────────────────────────────────────────────────────

export enum HealthMetric {
  TICKET_VOLUME = "ticket_volume",
  RESOLUTION_TIME = "resolution_time",
  SLA_ADHERENCE = "sla_adherence",
  OPEN_RISKS = "open_risks",
  SECURITY_FINDINGS = "security_findings",
  RENEWAL_SIGNALS = "renewal_signals",
}

export const HealthMetricLabels: Record<HealthMetric, string> = {
  [HealthMetric.TICKET_VOLUME]: "Ticket Volume",
  [HealthMetric.RESOLUTION_TIME]: "Resolution Time",
  [HealthMetric.SLA_ADHERENCE]: "SLA Adherence",
  [HealthMetric.OPEN_RISKS]: "Open Risks & Blockers",
  [HealthMetric.SECURITY_FINDINGS]: "Security Findings",
  [HealthMetric.RENEWAL_SIGNALS]: "Renewal & Upsell Signals",
};

// ─── Health Score Thresholds ───────────────────────────────────────────────

/**
 * Thresholds for converting raw metric values into component scores (0–100).
 * Higher = healthier. Each metric has its own scale and thresholds.
 */

export interface MetricThresholds {
  greenMin: number;  // Score ≥ greenMin → green
  amberMin: number; // Score ≥ amberMin → amber
  // Below amberMin → red
}

/** Ticket volume: lower is better. Green = 0–3/week, Amber = 4–7, Red = 8+ */
export const TicketVolumeThresholds: MetricThresholds = {
  greenMin: 75,   // 0–3 tickets/week → 75–100
  amberMin: 40,   // 4–7 tickets/week → 40–74
  // <40 → red
};

/** Resolution time: lower is better (in hours). Green = ≤4h, Amber = 4–24h, Red = 24h+ */
export const ResolutionTimeThresholds: MetricThresholds = {
  greenMin: 75,   // ≤4 hours → 75–100
  amberMin: 40,   // 4–24 hours → 40–74
  // <40 → red (>24 hours)
};

/** SLA adherence: higher is better. Green = ≥90%, Amber = 75–89%, Red = <75% */
export const SlaAdherenceThresholds: MetricThresholds = {
  greenMin: 90,   // ≥90% on-time → green
  amberMin: 75,   // 75–89% → amber
  // <75% → red
};

/** Open risks: lower is better. Green = 0, Amber = 1–2, Red = 3+ */
export const OpenRisksThresholds: MetricThresholds = {
  greenMin: 75,   // 0 open risks → 75–100
  amberMin: 40,   // 1–2 → 40–74
  // <40 → red (3+)
};

/** Security findings: lower is better. Green = 0, Amber = 1–2, Red = 3+ critical/high */
export const SecurityFindingsThresholds: MetricThresholds = {
  greenMin: 75,   // 0 critical/high findings → 75–100
  amberMin: 40,   // 1–2 medium findings → 40–74
  // <40 → red (3+ findings or any critical)
};

/** Renewal signals: higher is better (composite). Green = strong positive, Amber = mixed, Red = churn signals */
export const RenewalSignalsThresholds: MetricThresholds = {
  greenMin: 70,
  amberMin: 40,
};

// ─── Data Source Mapping ───────────────────────────────────────────────────

export enum DataSource {
  TICKET_SYSTEM = "ticket_system",
  MONITORING = "monitoring",
  SECURITY_SCAN = "security_scan",
  CRM = "crm",
  CONTRACT_META = "contract_meta",
  SURVEY = "survey",
}

export const MetricDataSources: Record<HealthMetric, DataSource[]> = {
  [HealthMetric.TICKET_VOLUME]:       [DataSource.TICKET_SYSTEM],
  [HealthMetric.RESOLUTION_TIME]:     [DataSource.TICKET_SYSTEM, DataSource.MONITORING],
  [HealthMetric.SLA_ADHERENCE]:       [DataSource.TICKET_SYSTEM],
  [HealthMetric.OPEN_RISKS]:          [DataSource.TICKET_SYSTEM, DataSource.MONITORING],
  [HealthMetric.SECURITY_FINDINGS]:   [DataSource.SECURITY_SCAN],
  [HealthMetric.RENEWAL_SIGNALS]:     [DataSource.CRM, DataSource.CONTRACT_META, DataSource.SURVEY],
};

// ─── Raw Metric Data ───────────────────────────────────────────────────────

export interface WeeklyMetricData {
  clientId: string;
  clientName: string;
  weekStart: string; // ISO date
  weekEnd: string;   // ISO date

  ticketVolume: {
    total: number;
    byCategory: Record<string, number>;
    byPriority: Record<string, number>;
  };
  resolutionTime: {
    avgHours: number;
    medianHours: number;
    p95Hours: number;
    withinSlaCount: number;
    breachCount: number;
  };
  slaAdherence: {
    totalTickets: number;
    onTimeCount: number;
    adherencePercent: number;
  };
  openRisks: {
    count: number;
    items: Array<{ id: string; description: string; severity: "low" | "medium" | "high" | "critical"; openSince: string }>;
  };
  securityFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    lastScanDate: string | null;
  };
  renewalSignals: {
    contractEndDate: string | null;
    npsScore: number | null;
    healthCheckComplete: boolean;
    expansionContractionSignals: "expansion" | "stable" | "contraction" | "churn_risk" | "unknown";
    notes: string[];
  };
}

// ─── Component Scores (0–100 each) ─────────────────────────────────────────

export interface MetricComponentScore {
  metric: HealthMetric;
  rawValue: number;    // original unit (e.g., hours, percent, count)
  score: number;       // 0–100
  status: "green" | "amber" | "red";
  trend: "improving" | "stable" | "declining" | "new";
  detail: string;      // human-readable explanation
}

function scoreFromThresholds(
  raw: number,
  thresholds: MetricThresholds,
  invert: boolean = false, // true = lower raw = higher score
): { score: number; status: "green" | "amber" | "red" } {
  let score: number;
  if (invert) {
    // For "lower is better" metrics
    if (raw <= 3) score = 100;
    else if (raw <= 7) score = 100 - (raw - 3) * 10;
    else if (raw <= 14) score = 60 - (raw - 7) * 5;
    else score = Math.max(0, 30 - (raw - 14) * 3);
  } else {
    // For "higher is better" metrics (e.g., SLA adherence percent)
    score = raw;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const status: "green" | "amber" | "red" =
    score >= thresholds.greenMin ? "green" :
    score >= thresholds.amberMin ? "amber" : "red";

  return { score, status };
}

export function scoreTicketVolume(data: WeeklyMetricData, priorWeek?: WeeklyMetricData): MetricComponentScore {
  const raw = data.ticketVolume.total;
  const { score, status } = scoreFromThresholds(raw, TicketVolumeThresholds, true);
  const trend = priorWeek
    ? raw < priorWeek.ticketVolume.total ? "improving"
    : raw === priorWeek.ticketVolume.total ? "stable" : "declining"
    : "new";

  return {
    metric: HealthMetric.TICKET_VOLUME,
    rawValue: raw,
    score,
    status,
    trend,
    detail: `${raw} tickets opened this week (prev: ${priorWeek?.ticketVolume.total ?? "n/a"})`,
  };
}

export function scoreResolutionTime(data: WeeklyMetricData, priorWeek?: WeeklyMetricData): MetricComponentScore {
  const raw = data.resolutionTime.avgHours;
  const { score, status } = scoreFromThresholds(raw, ResolutionTimeThresholds, true);
  const trend = priorWeek
    ? data.resolutionTime.avgHours < priorWeek.resolutionTime.avgHours ? "improving"
    : data.resolutionTime.avgHours === priorWeek.resolutionTime.avgHours ? "stable" : "declining"
    : "new";

  return {
    metric: HealthMetric.RESOLUTION_TIME,
    rawValue: Math.round(raw * 10) / 10,
    score,
    status,
    trend,
    detail: `Avg resolution: ${raw.toFixed(1)}h (median: ${data.resolutionTime.medianHours.toFixed(1)}h, p95: ${data.resolutionTime.p95Hours.toFixed(1)}h)`,
  };
}

export function scoreSlaAdherence(data: WeeklyMetricData, priorWeek?: WeeklyMetricData): MetricComponentScore {
  const raw = data.slaAdherence.adherencePercent;
  const { score, status } = scoreFromThresholds(raw, SlaAdherenceThresholds, false);
  const trend = priorWeek
    ? data.slaAdherence.adherencePercent > priorWeek.slaAdherence.adherencePercent ? "improving"
    : data.slaAdherence.adherencePercent === priorWeek.slaAdherence.adherencePercent ? "stable" : "declining"
    : "new";

  return {
    metric: HealthMetric.SLA_ADHERENCE,
    rawValue: Math.round(raw),
    score,
    status,
    trend,
    detail: `${raw.toFixed(1)}% SLA adherence (${data.slaAdherence.onTimeCount}/${data.slaAdherence.totalTickets} on time)`,
  };
}

export function scoreOpenRisks(data: WeeklyMetricData, priorWeek?: WeeklyMetricData): MetricComponentScore {
  const raw = data.openRisks.count;
  const criticalHigh = data.openRisks.items.filter(i => i.severity === "critical" || i.severity === "high").length;
  const score = raw === 0
    ? 100
    : criticalHigh > 0
      ? Math.max(0, 35 - Math.max(raw - 1, 0) * 5)
      : raw <= 2
        ? 65
        : Math.max(0, 35 - (raw - 3) * 5);
  const status: "green" | "amber" | "red" =
    score >= OpenRisksThresholds.greenMin ? "green" :
    score >= OpenRisksThresholds.amberMin ? "amber" : "red";
  const trend = priorWeek
    ? data.openRisks.count < priorWeek.openRisks.count ? "improving"
    : data.openRisks.count === priorWeek.openRisks.count ? "stable" : "declining"
    : "new";

  return {
    metric: HealthMetric.OPEN_RISKS,
    rawValue: raw,
    score,
    status,
    trend,
    detail: `${raw} open risk${raw !== 1 ? "s" : ""} (${criticalHigh} critical/high)${raw > 0 ? ": " + data.openRisks.items.map(i => i.description).join("; ") : ""}`,
  };
}

export function scoreSecurityFindings(data: WeeklyMetricData, priorWeek?: WeeklyMetricData): MetricComponentScore {
  const criticalHigh = data.securityFindings.critical + data.securityFindings.high;
  const total = criticalHigh + data.securityFindings.medium + data.securityFindings.low;
  const { score, status } = scoreFromThresholds(
    data.securityFindings.critical > 0 ? 0 : criticalHigh > 0 ? 30 : data.securityFindings.medium > 0 ? 60 : 100,
    SecurityFindingsThresholds,
    false,
  );
  const trend = priorWeek
    ? total < (priorWeek.securityFindings.critical + priorWeek.securityFindings.high + priorWeek.securityFindings.medium + priorWeek.securityFindings.low) ? "improving"
    : total === (priorWeek.securityFindings.critical + priorWeek.securityFindings.high + priorWeek.securityFindings.medium + priorWeek.securityFindings.low) ? "stable" : "declining"
    : "new";

  return {
    metric: HealthMetric.SECURITY_FINDINGS,
    rawValue: total,
    score,
    status,
    trend,
    detail: `${data.securityFindings.critical} critical, ${data.securityFindings.high} high, ${data.securityFindings.medium} medium, ${data.securityFindings.low} low — last scan: ${data.securityFindings.lastScanDate ?? "never"}`,
  };
}

export function scoreRenewalSignals(data: WeeklyMetricData): MetricComponentScore {
  const signals = data.renewalSignals.expansionContractionSignals;
  const nps = data.renewalSignals.npsScore;
  const healthCheck = data.renewalSignals.healthCheckComplete;

  let score = 50; // baseline
  if (signals === "expansion") score = 90;
  else if (signals === "stable") score = 70;
  else if (signals === "contraction") score = 35;
  else if (signals === "churn_risk") score = 15;

  if (healthCheck) score = Math.min(100, score + 10);
  if (nps !== null) {
    if (nps >= 9) score = Math.min(100, score + 5);
    else if (nps <= 6) score = Math.max(0, score - 10);
  }

  score = Math.round(score);
  const status: "green" | "amber" | "red" =
    score >= RenewalSignalsThresholds.greenMin ? "green" :
    score >= RenewalSignalsThresholds.amberMin ? "amber" : "red";

  return {
    metric: HealthMetric.RENEWAL_SIGNALS,
    rawValue: score,
    score,
    status,
    trend: "new", // trend requires prior week data
    detail: signals === "unknown" ? "Renewal signals not yet assessed" :
      `Contract ${signals}${nps !== null ? `, NPS: ${nps}/10` : ""}${healthCheck ? ", health check complete" : ""}`,
  };
}

// ─── Overall Health Score ───────────────────────────────────────────────────

export type HealthStatus = "green" | "amber" | "red";

export interface ClientHealthScore {
  clientId: string;
  clientName: string;
  weekStart: string;
  weekEnd: string;
  overallScore: number;  // 0–100 weighted average
  overallStatus: HealthStatus;
  componentScores: MetricComponentScore[];
  riskCallouts: string[];   // High-priority items requiring human attention
  topRisks: string[];       // The most urgent risk callouts
  openTickets: Array<{ id: string; title: string; urgency: string; age: string }>;
  renewalSignals: string[]; // Upsell / churn signals
  generatedAt: string;      // ISO timestamp
}

/**
 * Compute overall health score from component scores.
 * Weights: SLA adherence (30%), resolution time (25%), open risks (20%), security (15%), ticket volume (5%), renewal (5%)
 */
const METRIC_WEIGHTS: Record<HealthMetric, number> = {
  [HealthMetric.SLA_ADHERENCE]: 0.30,
  [HealthMetric.RESOLUTION_TIME]: 0.25,
  [HealthMetric.OPEN_RISKS]: 0.20,
  [HealthMetric.SECURITY_FINDINGS]: 0.15,
  [HealthMetric.TICKET_VOLUME]: 0.05,
  [HealthMetric.RENEWAL_SIGNALS]: 0.05,
};

export function computeOverallHealthScore(components: MetricComponentScore[]): {
  overallScore: number;
  overallStatus: HealthStatus;
} {
  const totalWeight = Object.values(METRIC_WEIGHTS).reduce((a, b) => a + b, 0); // = 1.0
  const overallScore = Math.round(
    components.reduce((sum, c) => sum + c.score * (METRIC_WEIGHTS[c.metric] ?? 0), 0) / totalWeight
  );

  const statuses = components.map(c => c.status);
  let overallStatus: HealthStatus;
  if (statuses.includes("red")) overallStatus = "red";
  else if (statuses.includes("amber")) overallStatus = "amber";
  else overallStatus = "green";

  return { overallScore: Math.max(0, Math.min(100, overallScore)), overallStatus };
}

export function generateHealthScore(
  data: WeeklyMetricData,
  priorWeek?: WeeklyMetricData,
): ClientHealthScore {
  const components = [
    scoreTicketVolume(data, priorWeek),
    scoreResolutionTime(data, priorWeek),
    scoreSlaAdherence(data, priorWeek),
    scoreOpenRisks(data, priorWeek),
    scoreSecurityFindings(data, priorWeek),
    scoreRenewalSignals(data),
  ];

  const { overallScore, overallStatus } = computeOverallHealthScore(components);

  const riskCallouts = components
    .filter(c => c.status === "red" || c.status === "amber")
    .map(c => `[${c.status.toUpperCase()}] ${HealthMetricLabels[c.metric]}: ${c.detail}`);

  const topRisks = riskCallouts.filter((_, i) => i < 3);

  const renewalSignals: string[] = [];
  if (data.renewalSignals.expansionContractionSignals === "expansion") {
    renewalSignals.push("Expansion signal: client showing growth indicators");
  }
  if (data.renewalSignals.expansionContractionSignals === "churn_risk") {
    renewalSignals.push("Churn risk: renewal conversation required");
  }
  if (data.renewalSignals.npsScore !== null && data.renewalSignals.npsScore <= 6) {
    renewalSignals.push(`Low NPS (${data.renewalSignals.npsScore}/10): proactive outreach recommended`);
  }

  return {
    clientId: data.clientId,
    clientName: data.clientName,
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    overallScore,
    overallStatus,
    componentScores: components,
    riskCallouts,
    topRisks,
    openTickets: [], // AGE-7 QBR generator will populate this from ticket system
    renewalSignals,
    generatedAt: new Date().toISOString(),
  };
}
