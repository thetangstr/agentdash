# MSP Client Health Metrics Dashboard — Schema & KPI Definitions
**Issue**: AGE-6 | **Status**: Draft v0.1 | **Date**: 2026-05-28

---

## 1. Overview

This document defines the weekly client health reporting schema for the MSP design partner launch.
It specifies: (1) which metrics to track, (2) how to aggregate them weekly, (3) how to score overall client health (green/amber/red).

The five core health metrics form the basis of the weekly QBR draft pack (AGE-7).

---

## 2. Core Health Metrics

### H1 — Ticket Volume (Weekly)
**What**: Number of new tickets opened in the past 7 days.
**Formula**: `COUNT(tickets WHERE createdAt >= NOW() - 7d AND clientId = :clientId)`
**Thresholds** (monthly normalized to weekly = monthly/4.33):

| Tier | Weekly Tickets | Signal |
|------|---------------|--------|
| 🟢 Green | 0 – baseline × 1.0 | On track |
| 🟡 Amber | baseline × 1.0 – × 2.0 | Watch |
| 🔴 Red | > baseline × 2.0 | At risk |

Baseline = client's historical monthly average ÷ 4.33.

**Data source**: AgentDash CRM `tickets` table

---

### H2 — Average Resolution Time (Weekly)
**What**: Mean time from ticket open to ticket resolved, in hours.
**Formula**: `AVG(resolvedAt - createdAt) WHERE resolvedAt IS NOT NULL AND createdAt >= NOW() - 7d`
**Thresholds**:

| Tier | P1/P2 Tickets | P3/P4 Tickets |
|------|--------------|--------------|
| 🟢 Green | < 4h | < 3 days |
| 🟡 Amber | 4h – 8h | 3 – 5 days |
| 🔴 Red | > 8h | > 5 days |

**Data source**: AgentDash CRM `tickets` table

---

### H3 — SLA Adherence Rate (Weekly)
**What**: Percentage of tickets resolved within the contracted SLA window.
**Formula**: `COUNT(tickets WHERE resolvedAt - createdAt <= SLA_window_hours) / COUNT(all resolved tickets) × 100`
**Thresholds**:

| Tier | Adherence Rate |
|------|---------------|
| 🟢 Green | ≥ 90% |
| 🟡 Amber | 75% – 89% |
| 🔴 Red | < 75% |

**Data source**: AgentDash CRM `tickets` + `contracts` tables

---

### H4 — Open Risk Count (Weekly Snapshot)
**What**: Number of unresolved P1/P2 incidents + unaddressed security findings as of the report date.
**Formula**: `COUNT(tickets WHERE priority IN (P1,P2) AND status NOT IN (done,cancelled) AND clientId = :clientId) + COUNT(security_findings WHERE status != resolved AND clientId = :clientId)`
**Thresholds**:

| Tier | Open Risks |
|------|----------|
| 🟢 Green | 0 |
| 🟡 Amber | 1–2 non-critical risks |
| 🔴 Red | ≥3 risks, or any critical/high risk |

**Data source**: AgentDash CRM `tickets` + `security_findings` tables

The temporary `/api/msp/*` mock endpoints are disabled by default. Set
`AGENTDASH_MSP_DEMO_ROUTES=true` only when intentionally exposing demo data.

---

### H5 — Renewal / Upsell Signal (Monthly, surfaced weekly)
**What**: Composite score of renewal risk and upsell opportunity indicators.
**Signals**:
- Contract renewal within 90 days: +30 risk
- Downturn in H1–H4 health scores vs. prior month: +20 risk per metric dropped
- Security incident in past 90 days: +25 risk
- Open upsell提案 pending > 30 days: +15 opportunity
- Net promoter health (green on all H1–H4 for 3+ months): +10 upsell

**Thresholds**:

| Tier | Renewal Risk Score | Signal |
|------|------------------|--------|
| 🟢 Green | 0–29 | On track for renewal |
| 🟡 Amber | 30–59 | At risk — monitor closely |
| 🔴 Red | 60–100 | Likely to churn — escalate |

**Data source**: AgentDash CRM `contracts`, `tickets`, `security_findings`, `proposals`

---

## 3. Composite Health Score Formula

Each metric H1–H4 is mapped to a 0–100 score (green=100, amber=60, red=20).

```
Health Score = (H1_score × 0.20) + (H2_score × 0.25) + (H3_score × 0.25) + (H4_score × 0.20) + (H5_score × 0.10)
```

| Composite Score | Health Tier |
|----------------|-------------|
| 80–100 | 🟢 Healthy |
| 50–79 | 🟡 Needs Attention |
| 0–49 | 🔴 At Risk |

---

## 4. Data Sources Summary

| Metric | Primary Source | Key Fields |
|--------|---------------|-----------|
| H1 Ticket Volume | `tickets` | `createdAt`, `clientId`, `status` |
| H2 Resolution Time | `tickets` | `createdAt`, `resolvedAt`, `priority` |
| H3 SLA Adherence | `tickets` + `contracts` | `slaTier`, `resolvedAt`, `createdAt` |
| H4 Open Risks | `tickets` + `security_findings` | `priority`, `status`, `severity` |
| H5 Renewal Signal | `contracts` + `proposals` | `renewalDate`, `status`, `submittedAt` |

---

## 5. Report Output Schema (for AGE-7 consumption)

The weekly report generator (AGE-7) will produce:

```json
{
  "clientId": "uuid",
  "reportWeek": "2026-W21",
  "generatedAt": "ISO8601",
  "metrics": {
    "H1": { "raw": 12, "tier": "green", "score": 100 },
    "H2": { "raw": 6.2, "unit": "hours", "tier": "amber", "score": 60 },
    "H3": { "raw": 87.5, "unit": "percent", "tier": "amber", "score": 60 },
    "H4": { "raw": 2, "tier": "amber", "score": 60 },
    "H5": { "raw": 35, "tier": "amber", "score": 60 }
  },
  "compositeHealthScore": 68,
  "healthTier": "needs_attention",
  "trend": "stable",
  "topRisks": ["SLA adherence at 87.5%", "2 open P2 incidents"],
  "renewalSignal": { "score": 35, "tier": "amber", "renewalDate": "2026-09-30" },
  "openTickets": [...],
  "operatorBrief": "string"
}
```

---

## 6. Open Questions

1. Should H5 renewal signal pull from a dedicated CRM field or derive entirely from H1–H4?
2. Is there a minimum ticket volume threshold below which H1–H3 become statistically meaningless (small clients)?
3. Do we need a client-satisfaction (CSAT) dimension? It was mentioned in the goal but not in the original issue description.
4. Should we surface month-over-month trend arrows in the QBR output (improving / declining / stable)?
