// AgentDash (scan 4, lane N): how the Chief of Staff names and titles the
// agents it proposes on a plan card (agent_plan_proposal_v1).
//
// - The CoS once named an agent "Dana", the founder's own name. The plan
//   prompts now list the company's people and ask for other names, and every
//   plan is checked here before it is posted: an agent whose name is a
//   member's (full or first name, any case) is renamed, everywhere the plan
//   mentions it.
// - The card showed "Client Onboarding Process Builder" when the CoS had
//   written "Client Onboarding & Process Builder": the card humanized the
//   role slug. The CoS now writes the title itself; it is kept as written,
//   only trimmed.
// - The plan was said three times in one turn (intro list, card, card
//   rationale). The intro is now one line; the card shows the agents.
import { and, eq } from "drizzle-orm";
import { authUsers, companyMemberships, type Db } from "@paperclipai/db";
import type { AgentPlanProposalV1Payload } from "@paperclipai/shared";

/** Names used when a proposed agent's name belongs to a person in the company. */
export const PLAN_FALLBACK_AGENT_NAMES = [
  "Avery", "Jordan", "Riley", "Quinn", "Morgan", "Casey", "Rowan", "Sage", "Emery", "Harper",
  "Reese", "Blair", "Parker", "Skyler", "Finley", "Hayden", "Kendall", "Peyton", "Tatum", "Remy",
] as const;

/** Display names of the company's active human members. */
export async function listCompanyMemberNames(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ name: authUsers.name })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );
  const names = new Set<string>();
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name) names.add(name);
  }
  return [...names];
}

/** Lower-cased full names and first names; a name matching any of these is taken. */
export function memberNameKeys(memberNames: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of memberNames) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    keys.add(name);
    const first = name.split(/\s+/)[0];
    if (first) keys.add(first);
  }
  return keys;
}

function nameKeys(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const first = lower.split(/\s+/)[0] ?? "";
  return first && first !== lower ? [lower, first] : [lower];
}

/** Prompt guidance for agent names and titles on a plan card. */
export function planNamingGuidance(memberNames: readonly string[]): string {
  const people = memberNames.filter((n) => n.trim().length > 0);
  const avoid = people.length > 0
    ? ` These people work in this company: ${people.map((n) => JSON.stringify(n)).join(", ")}. Never give an agent any of their names, first names included.`
    : "";
  return `Give each agent a short human first name.${avoid} In the JSON, "title" is the agent's role title exactly as you write it in the visible text (for example "Month-End Close Coordinator" or "Client Onboarding & Process Builder"); "role" stays a short lowercase id such as "close_coordinator".`;
}

/** Prompt guidance for the visible text above a plan card. */
export const PLAN_INTRO_GUIDANCE =
  'In the visible body (before the JSON), write ONE short sentence that sums up the plan. The card under your message shows every agent with its responsibilities and targets, so do not list the agents, their responsibilities or the goals again. Then ask "Want me to set them up, or revise?"';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceWholeWord(text: string, from: string, to: string): string {
  if (!text || !from) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, "gu");
  return text.replace(re, to);
}

export interface PlanRename {
  from: string;
  to: string;
}

/**
 * Rename every proposed agent whose name is a company member's, and keep the
 * CoS-written titles verbatim (trimmed). The plan's own text and the intro
 * body follow the rename. Pure; returns new objects.
 */
export function preparePlanForPosting(
  plan: AgentPlanProposalV1Payload,
  body: string,
  memberNames: readonly string[],
): { plan: AgentPlanProposalV1Payload; body: string; renamed: PlanRename[] } {
  const taken = memberNameKeys(memberNames);
  const used = new Set<string>();
  const renamed: PlanRename[] = [];
  // Names the plan keeps are reserved first, so a fallback never duplicates one.
  for (const agent of plan.agents) {
    const keys = nameKeys(agent.name);
    if (!keys.some((k) => taken.has(k))) keys.forEach((k) => used.add(k));
  }
  const agents = plan.agents.map((agent) => {
    const title = typeof agent.title === "string" ? agent.title.trim() : "";
    const next = { ...agent };
    if (title) next.title = title;
    else delete next.title;
    const keys = nameKeys(agent.name);
    if (!keys.some((k) => taken.has(k))) return next;
    const replacement = PLAN_FALLBACK_AGENT_NAMES.find((n) => {
      const k = n.toLowerCase();
      return !taken.has(k) && !used.has(k);
    });
    if (!replacement) return next;
    used.add(replacement.toLowerCase());
    renamed.push({ from: agent.name.trim(), to: replacement });
    return { ...next, name: replacement };
  });
  const rewrite = (text: string) => renamed.reduce((acc, r) => replaceWholeWord(acc, r.from, r.to), text);
  return {
    plan: {
      ...plan,
      agents: agents.map((agent) => ({
        ...agent,
        responsibilities: Array.isArray(agent.responsibilities) ? agent.responsibilities.map((r) => (typeof r === "string" ? rewrite(r) : r)) : agent.responsibilities,
        kpis: Array.isArray(agent.kpis) ? agent.kpis.map((k) => (typeof k === "string" ? rewrite(k) : k)) : agent.kpis,
      })),
      rationale: rewrite(plan.rationale),
      alignmentToShortTerm: rewrite(plan.alignmentToShortTerm),
      alignmentToLongTerm: rewrite(plan.alignmentToLongTerm),
    },
    body: rewrite(body),
    renamed,
  };
}
