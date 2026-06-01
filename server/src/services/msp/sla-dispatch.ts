/**
 * SLA Dispatch Draft Generator Service
 * Issue: AGE-5 | Depends on: AGE-3 and AGE-4
 *
 * Takes a TicketContext and SLA risk score and recommends:
 * 1. Best assignee based on skill tags and current workload
 * 2. Urgency level
 * 3. Next-step action
 *
 * Output: DispatchRecommendation card attached to the ticket.
 */

import {
  DispatchRecommendation,
  TicketContext,
  SlaRiskScore,
  SkillTag,
  UrgencyTier,
  TicketCategory,
} from "../../types/msp-taxonomy.js";

export interface EngineerProfile {
  id: string;
  name: string;
  email: string;
  skillTags: SkillTag[];
  tier: "tier1" | "tier2" | "tier3";
  currentWorkload: number; // 0–100 (percent capacity used)
  activeTickets: number;
  maxTickets: number;
}

export interface DispatchContext {
  ticket: TicketContext;
  slaRisk: SlaRiskScore;
  availableEngineers: EngineerProfile[];
}

export interface DispatchNextStep {
  step: number;
  action: string;
  rationale: string;
  agentHint: string | null;
  timeEstimateMinutes: number | null;
}

// ─── Skill-category routing ─────────────────────────────────────────────────

/** Maps ticket categories to the skill tags best suited for first response */
const CategorySkillMap: Record<TicketCategory, SkillTag[]> = {
  [TicketCategory.INCIDENT_OUTAGE]:    [SkillTag.TIER3, SkillTag.NETWORK, SkillTag.CLOUD_AZURE, SkillTag.CLOUD_AWS],
  [TicketCategory.INCIDENT_PARTIAL]:   [SkillTag.TIER2, SkillTag.NETWORK, SkillTag.MONITORING],
  [TicketCategory.SECURITY_INCIDENT]: [SkillTag.SECURITY, SkillTag.TIER3],
  [TicketCategory.SECURITY_QUESTION]: [SkillTag.SECURITY, SkillTag.TIER2],
  [TicketCategory.REQUEST_CHANGE]:     [SkillTag.TIER2, SkillTag.TIER3, SkillTag.CLOUD_AZURE, SkillTag.CLOUD_AWS],
  [TicketCategory.REQUEST_ACCESS]:     [SkillTag.TIER1, SkillTag.M365, SkillTag.GOOGLE_WORKSPACE],
  [TicketCategory.REQUEST_QUESTION]:  [SkillTag.TIER1, SkillTag.TIER2],
  [TicketCategory.REQUEST_BUG]:        [SkillTag.TIER2, SkillTag.TIER3],
  [TicketCategory.ONGOING_PROJECT]:    [SkillTag.TIER3, SkillTag.CLOUD_AZURE, SkillTag.CLOUD_AWS],
  [TicketCategory.ONGOING_MONTHLY]:   [SkillTag.TIER1, SkillTag.TIER2],
  [TicketCategory.ADMIN_BILLING]:      [SkillTag.BILLING_ADMIN, SkillTag.ACCOUNT_MANAGER],
  [TicketCategory.ADMIN_RENEWAL]:      [SkillTag.ACCOUNT_MANAGER],
  [TicketCategory.ADMIN_OTHER]:        [SkillTag.TIER1],
};

/** Tier escalation rules by SLA risk level */
const TierEscalation: Record<string, UrgencyTier> = {
  critical: UrgencyTier.P1_CRITICAL,
  high:     UrgencyTier.P2_HIGH,
  medium:   UrgencyTier.P3_MEDIUM,
  low:      UrgencyTier.P4_LOW,
};

/** Estimated resolution hours by category */
const ESTIMATED_RESOLUTION_HOURS: Partial<Record<TicketCategory, number>> = {
  [TicketCategory.INCIDENT_OUTAGE]:    4,
  [TicketCategory.INCIDENT_PARTIAL]:   4,
  [TicketCategory.SECURITY_INCIDENT]:  2,
  [TicketCategory.SECURITY_QUESTION]:  8,
  [TicketCategory.REQUEST_CHANGE]:     8,
  [TicketCategory.REQUEST_ACCESS]:     2,
  [TicketCategory.REQUEST_QUESTION]:  24,
  [TicketCategory.REQUEST_BUG]:        8,
  [TicketCategory.ONGOING_PROJECT]:   24,
  [TicketCategory.ONGOING_MONTHLY]:   48,
  [TicketCategory.ADMIN_BILLING]:       4,
  [TicketCategory.ADMIN_RENEWAL]:       8,
  [TicketCategory.ADMIN_OTHER]:        24,
};

function hasTicketCapacity(engineer: EngineerProfile): boolean {
  return engineer.maxTickets > 0 && engineer.activeTickets < engineer.maxTickets;
}

/**
 * Score an engineer for fitness to handle a given ticket.
 * Higher score = better fit. Takes skill match, workload, and tier into account.
 */
function scoreEngineer(
  engineer: EngineerProfile,
  requiredSkills: SkillTag[],
  ticketTier: UrgencyTier,
): number {
  if (!hasTicketCapacity(engineer)) return -1;

  // Skill match (0–60 points)
  const matchingSkills = engineer.skillTags.filter(s => requiredSkills.includes(s)).length;
  const skillScore = requiredSkills.length > 0
    ? (matchingSkills / requiredSkills.length) * 60
    : 30; // neutral if no specific skills required

  // Workload penalty (0–30 points, lower workload = higher score)
  const workloadScore = Math.max(0, 30 - (engineer.currentWorkload * 0.3));

  // Tier appropriateness (0–10 bonus)
  let tierBonus = 0;
  if (ticketTier === UrgencyTier.P1_CRITICAL && engineer.tier === "tier3") tierBonus = 10;
  else if (ticketTier === UrgencyTier.P2_HIGH && (engineer.tier === "tier2" || engineer.tier === "tier3")) tierBonus = 5;
  else if (ticketTier === UrgencyTier.P4_LOW && engineer.tier === "tier1") tierBonus = 5;

  return Math.round(skillScore + workloadScore + tierBonus);
}

/**
 * Build escalation flags based on ticket context and SLA risk.
 */
function buildEscalationFlags(slaRisk: SlaRiskScore, ticket: TicketContext): string[] {
  const flags: string[] = [];
  if (slaRisk.breached) {
    flags.push("⚠️ SLA BREACHED — escalate immediately and notify account manager");
  }
  if (ticket.hasActiveOutage) {
    flags.push("🚨 ACTIVE OUTAGE — incident commander protocol in effect");
  }
  if (ticket.isSecurity) {
    flags.push("🔒 SECURITY INCIDENT — follow security incident response plan; legal notification may apply");
  }
  if (slaRisk.atRisk) {
    flags.push(`⏳ SLA AT RISK — only ${slaRisk.minutesUntilBreach?.toFixed(0)} min remaining`);
  }
  if (ticket.isRevenueAffecting) {
    flags.push("💰 REVENUE-AFFECTING — prioritize and notify CSM");
  }
  if (slaRisk.tier === "critical") {
    flags.push(`🚨 CRITICAL RISK (${slaRisk.score}/100) — highest priority`);
  }
  return flags;
}

/**
 * Get next-step actions based on ticket category and SLA risk.
 * Returns structured steps with rationale, agent hint, and time estimate.
 */
function getNextSteps(
  category: TicketCategory,
  slaRisk: SlaRiskScore,
  escalationTier: UrgencyTier,
): DispatchNextStep[] {
  const steps: DispatchNextStep[] = [];
  let n = 1;

  // Step 1: SLA-first actions
  if (slaRisk.breached) {
    steps.push({
      step: n++,
      action: "Escalate to Tier 3 immediately and notify account manager",
      rationale: `SLA already breached for this ${slaRisk.tier} ticket`,
      agentHint: "tier3",
      timeEstimateMinutes: 10,
    });
    steps.push({
      step: n++,
      action: "Prepare customer breach notification",
      rationale: "Human must approve any customer-facing SLA breach communication",
      agentHint: null,
      timeEstimateMinutes: 15,
    });
  } else if (slaRisk.atRisk) {
    steps.push({
      step: n++,
      action: "Assign to best-fit engineer within current sprint",
      rationale: `Only ${slaRisk.minutesUntilBreach?.toFixed(0)} min SLA window remaining`,
      agentHint: null,
      timeEstimateMinutes: 5,
    });
    steps.push({
      step: n++,
      action: "Prepare customer communication if breach is likely",
      rationale: "Keep customer informed to protect relationship",
      agentHint: null,
      timeEstimateMinutes: 10,
    });
  }

  // Step 2: Category-specific resolution
  const resolutionActions: Partial<Record<TicketCategory, { action: string; rationale: string; hint: string | null; mins: number | null }>> = {
    [TicketCategory.INCIDENT_OUTAGE]: {
      action: "Initiate incident response runbook; post status update if customer-facing",
      rationale: "Full outage requires immediate isolation and communication",
      hint: "tier3",
      mins: null,
    },
    [TicketCategory.SECURITY_INCIDENT]: {
      action: "Isolate affected systems — do NOT attempt remediation without Tier 3",
      rationale: "Security incidents require forensics before remediation",
      hint: "security",
      mins: null,
    },
    [TicketCategory.INCIDENT_PARTIAL]: {
      action: "Begin root cause identification; post interim update to affected users",
      rationale: "Partial degradation — scope and communicate while investigating",
      hint: "tier2",
      mins: null,
    },
    [TicketCategory.REQUEST_ACCESS]: {
      action: "Verify requester identity and authorization, then process provisioning",
      rationale: "Access requests require verification before any changes",
      hint: "tier1",
      mins: 15,
    },
    [TicketCategory.REQUEST_CHANGE]: {
      action: "Review change request for risk and obtain customer approval",
      rationale: "All changes require documented customer sign-off",
      hint: "tier2",
      mins: 30,
    },
    [TicketCategory.REQUEST_BUG]: {
      action: "Reproduce and confirm the bug; open internal bug ticket if confirmed",
      rationale: "Avoid assuming bug is real without reproduction",
      hint: "tier2",
      mins: 30,
    },
    [TicketCategory.ADMIN_RENEWAL]: {
      action: "Flag for account manager — initiate renewal conversation",
      rationale: "Renewals require human relationship management",
      hint: "account_manager",
      mins: null,
    },
    [TicketCategory.ADMIN_BILLING]: {
      action: "Review contract and billing history; provide explanation or correction",
      rationale: "Billing disputes require careful documentation",
      hint: "billing_admin",
      mins: 20,
    },
  };

  const resAction = resolutionActions[category];
  if (resAction) {
    steps.push({
      step: n++,
      action: resAction.action,
      rationale: resAction.rationale,
      agentHint: resAction.hint,
      timeEstimateMinutes: resAction.mins,
    });
  } else {
    steps.push({
      step: n++,
      action: "Assign to appropriate tier based on skill requirements",
      rationale: `No specific action template for ${category} — use standard triage`,
      agentHint: null,
      timeEstimateMinutes: null,
    });
  }

  // Step 3: Documentation / close
  steps.push({
    step: n++,
    action: "Document resolution steps in ticket and close or escalate",
    rationale: "Maintain knowledge base and SLA documentation",
    agentHint: null,
    timeEstimateMinutes: 10,
  });

  return steps;
}

function buildInternalNote(
  ticket: TicketContext,
  slaRisk: SlaRiskScore,
  suggestedEngineer: EngineerProfile | null,
): string {
  let note = `SLA Risk: ${slaRisk.tier.toUpperCase()} (score ${slaRisk.score}/100)`;
  if (slaRisk.breached) note += " — ALREADY BREACHED";
  else if (slaRisk.atRisk) note += ` — at risk (${slaRisk.minutesUntilBreach?.toFixed(0)} min remaining)`;
  note += `\nCategory: ${ticket.category}`;
  note += `\nSecurity: ${ticket.isSecurity ? "YES" : "No"} | Revenue-affecting: ${ticket.isRevenueAffecting ? "YES" : "No"}`;
  note += `\nUrgency keywords: ${ticket.keywords.length > 0 ? ticket.keywords.join(", ") : "none detected"}`;
  if (suggestedEngineer) {
    note += `\nSuggested assignee: ${suggestedEngineer.name} (${suggestedEngineer.tier}, ${suggestedEngineer.currentWorkload}% capacity, ${suggestedEngineer.activeTickets}/${suggestedEngineer.maxTickets} tickets)`;
  }
  return note;
}

/**
 * Main dispatch function — produces a DispatchRecommendation from a ticket context and SLA risk.
 */
export function generateDispatchRecommendation(ctx: DispatchContext): DispatchRecommendation {
  const { ticket, slaRisk, availableEngineers } = ctx;

  const requiredSkills = CategorySkillMap[ticket.category] ?? [];
  const escalationTier = TierEscalation[slaRisk.tier] ?? ticket.slaTier;

  // Score and rank engineers
  const ranked = availableEngineers
    .map(e => ({ engineer: e, score: scoreEngineer(e, requiredSkills, ticket.slaTier) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] ?? null;
  const alternatives = ranked.slice(1, 4).map(({ engineer: eng, score }) => ({
    agentId: eng.id,
    agentName: eng.name,
    reason: `${Math.round(score)}/100 skill+workload score — ${eng.skillTags.filter(s => requiredSkills.includes(s)).join(", ") || "general"}`,
    fitScore: Math.round(score) / 100,
  }));

  const escalationFlags = buildEscalationFlags(slaRisk, ticket);
  const nextSteps = getNextSteps(ticket.category, slaRisk, escalationTier);
  const nextStepStrings = nextSteps.map(s => `${s.step}. ${s.action}`);

  const confidence = best ? Math.min(best.score / 100, 1) : 0;

  const urgencyOverride: DispatchRecommendation["urgencyOverride"] =
    slaRisk.tier === "critical" && ticket.slaTier !== UrgencyTier.P1_CRITICAL
      ? "upgrade"
      : slaRisk.tier === "low" && ticket.slaTier === UrgencyTier.P1_CRITICAL
      ? "downgrade"
      : null;

  const estimatedHours = ESTIMATED_RESOLUTION_HOURS[ticket.category] ?? 8;

  const slaRecommendation = slaRisk.breached
    ? `SLA BREACHED — prioritize immediately. Escalate to manager if unresolved within 1 hour.`
    : slaRisk.atRisk
    ? `SLA at risk — only ${slaRisk.minutesUntilBreach?.toFixed(0)} min remaining. Assign now and communicate to customer.`
    : `SLA window healthy — respond within ${escalationTier} window.`;

  return {
    urgency: escalationTier,
    category: ticket.category,
    slaRisk,
    suggestedAssignee: best?.engineer.name ?? null,
    suggestedSkillTags: requiredSkills,
    nextSteps: nextStepStrings,
    escalationFlags,
    alternativeAssignees: alternatives,
    confidence,
    urgencyOverride,
    estimatedResolutionHours: estimatedHours,
    slaRecommendation,
    internalNote: buildInternalNote(ticket, slaRisk, best?.engineer ?? null),
    modelUsed: "rule-based-dispatch-v1",
    generatedAt: new Date().toISOString(),
  };
}

// ─── Markdown card renderer ─────────────────────────────────────────────────────

/**
 * Render a DispatchRecommendation as a human-readable markdown card.
 * Suitable for attaching to a ticket record or posting in a CoS thread.
 */
export function renderDispatchCard(rec: DispatchRecommendation): string {
  const flagBlock = rec.escalationFlags.length > 0
    ? rec.escalationFlags.map((f) => `- ${f}`).join("\n")
    : "_None_";

  const altBlock = rec.alternativeAssignees.length > 0
    ? rec.alternativeAssignees
        .map((a) => `  - **${a.agentName}** (${Math.round(a.fitScore * 100)}% fit): ${a.reason}`)
        .join("\n")
    : "_None_";

  return [
    `## MSP Dispatch Recommendation`,
    ``,
    `### Recommended Assignee`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Agent | **${rec.suggestedAssignee ?? "- UNASSIGNED -"}** |`,
    `| Confidence | ${Math.round(rec.confidence * 100)}% |`,
    `| Skill tags | ${rec.suggestedSkillTags.join(", ") || "_none_"} |`,
    rec.urgencyOverride ? `| Urgency adjustment | ${rec.urgencyOverride.toUpperCase()} |` : null,
    `| Est. resolution | ${rec.estimatedResolutionHours ?? "?"} hours |`,
    ``,
    `**Alternatives:**\n${altBlock}`,
    ``,
    `### SLA Recommendation`,
    ``,
    rec.slaRecommendation,
    ``,
    `### Escalation Flags`,
    ``,
    flagBlock,
    ``,
    `### Next Steps`,
    ``,
    ...rec.nextSteps.map((s) => `- ${s}`),
    ``,
    `### Internal Notes`,
    ``,
    rec.internalNote,
    ``,
    `---`,
    `*Generated: ${rec.generatedAt} · Model: ${rec.modelUsed}*`,
  ]
    .filter(Boolean)
    .join("\n");
}
