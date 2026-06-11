# MSP Ticket Triage Taxonomy & SLA Risk Classification Schema
**Issue**: AGE-3 | **Status**: Draft v0.1 | **Date**: 2026-05-28

---

## 1. Ticket Category Taxonomy

Every inbound MSP ticket MUST be classified into exactly one **primary category** and may have one **secondary tag**.

### Primary Categories

| Code | Category | Description | Typical SLA |
|------|----------|-------------|-------------|
| `INC` | Incident | Service disruption, outage, degraded performance | P1/P2 |
| `REQ` | Service Request | Standard user request (password reset, access, config) | P3 |
| `CHG` | Change Request | Infrastructure or configuration change | P3/P4 |
| `PROB` | Problem | Root-cause investigation for repeat incidents | P4 |
| `SEC` | Security Event | Suspected breach, phishing, malware, vulnerability | P1 |
| `CAP` | Capacity / Growth | Resource planning, scaling, capacity concern | P3 |
| `INFO` | Information Request | Question from client, no action required | P4 |

### Secondary Tags

| Code | Tag | Applies To | Notes |
|------|-----|------------|-------|
| `CRIT` | Critical Client | All | Client is Tier-1 / enterprise contract |
| `REC` | Recurring | INC, PROB | Same or similar incident seen before |
| `BRK` | Break-fix | INC, CHG | Immediate resolution required |
| `ENH` | Enhancement | REQ | Will be planned, not emergency |
| `OUTAGE` | Active Outage | INC, SEC | Client is currently down |
| `MULTI` | Multi-site | All | Affects multiple client locations |

---

## 2. Asset / Service Classification

| Code | Asset Class | Examples |
|------|-------------|----------|
| ` infra` | Infrastructure | Servers, VMs, network, firewall |
| ` cloud` | Cloud Services | M365, AWS, Azure, Google Workspace |
| ` endpoint` | Endpoints | Workstations, laptops, mobile |
| ` app` | Applications | Line-of-business apps, databases |
| ` sec` | Security | EDR, SIEM, backup, identity |
| ` net` | Networking | VPN, WAN, LAN, SD-WAN |
| ` other` | Other | Anything not above |

---

## 3. Urgency / Priority Tiers

| Tier | Label | Definition | SLA Response | SLA Resolution |
|------|-------|------------|--------------|----------------|
| P1 | Critical | Complete service outage or active security breach | 15 min | 4 hours |
| P2 | High | Major degradation; >50% users impacted | 1 hour | 8 hours |
| P3 | Medium | Partial impact; single user or <50% users | 4 hours | 3 business days |
| P4 | Low | Minor; no immediate business impact | 1 business day | 2 weeks |

---

## 4. SLA Risk Scoring Logic

Each ticket receives a **composite SLA risk score** from 0–100:

```
Risk Score = Base(Priority) + ClientTier_Bonus + Recurring_Bonus + SLA_Window_Bonus + Scope_Bonus
```

| Signal | Values | Score Contribution |
|--------|--------|-------------------|
| **Base (Priority)** | P1=50, P2=35, P3=15, P4=5 | Additive |
| **Client Tier** | Enterprise=+20, Mid-market=+10, SMB=+0 | Additive |
| **Recurring** | Yes=+15, No=+0 | Additive |
| **Active Outage** | Yes=+20, No=+0 | Additive |
| **Multi-site Impact** | Yes=+10, No=+0 | Additive |
| **Security Category** | SEC=+25, else=+0 | Additive |
| **SLA Breach Imminent** | <2h remaining=+15 | Additive |

### Risk Thresholds

| Score | Risk Level | Action |
|-------|-----------|--------|
| 0–29 | 🟢 Low | Queue normally; monitor |
| 30–59 | 🟡 Medium | Escalate to senior tech; notify manager |
| 60–84 | 🟠 High | Immediate dispatch; account manager notified |
| 85–100 | 🔴 Critical | War room; executive sponsor notified |

---

## 5. Skill Tag Matrix for Dispatch

| Skill Tag | Handles | Categories |
|-----------|---------|------------|
| `sysadmin` | Infra, cloud, networking | INC, CHG, CAP |
| `security` | All security events | SEC, INC (if sec-related) |
| `helpdesk` | Endpoints, standard requests | INC, REQ, INFO |
| `cloud` | M365, AWS, Azure | INC, REQ, CHG |
| `app-dev` | Applications, databases | INC, REQ, PROB |
| `network` | VPN, SD-WAN, LAN/WAN | INC, CHG, CAP |
| `escalation` | Senior-level triage | All tiers |

---

## 6. Acceptance Criteria (AGE-3)

- [x] At least 5 ticket categories defined with codes
- [x] Asset/service classification with codes
- [x] 4-tier priority system (P1–P4)
- [x] SLA risk score formula with ≥4 signals
- [x] Health score thresholds (green/amber/red) per SLA risk
- [x] Skill tag dispatch matrix
- [x] Data sources identified for each metric

---

## 7. Data Sources

| Metric | Source | Access |
|--------|--------|--------|
| Ticket category | Inbound ticket `category` field | AgentDash CRM |
| Client tier | Client profile `tier` field | AgentDash CRM |
| Recurring flag | Ticket `relatedTo[]` cross-reference | AgentDash CRM |
| SLA window | Contract `slaTier` + ticket `createdAt` | AgentDash CRM |
| Asset class | Ticket `asset.type` field | AgentDash CRM |
| Open ticket count | Active tickets per client | AgentDash CRM |
| Resolution time | Ticket `resolvedAt - createdAt` | AgentDash CRM |
| Security findings | SEC category or `sec` tag | AgentDash CRM |

---

## 8. Open Questions

1. Should `PROB` (Problem) tickets auto-link to the originating `INC` tickets?
2. Does the client tier map to 3 tiers (Enterprise/Mid-market/SMB) or 5?
3. Is there a budget/cost dimension to add to the health score?
4. Should we surface a "client health trend" (improving/declining) vs. single-week snapshot?
