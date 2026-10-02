// AgentDash: map a free-text role proposed on an agent_plan_proposal_v1 card
// (e.g. "research_analyst", "content_lead", "deployment_lead") onto the
// AGENT_ROLES enum. Before this, /onboarding/confirm-plan saved every hire as
// "general", so the org chart and role filters lost what the plan proposed.
// The proposed role text is kept separately as the agent title.
import { AGENT_ROLES, type AgentRole } from "./constants.js";

// Ordered: the first rule whose keyword appears in the role wins, so more
// specific words come before broad ones ("security engineer" -> security).
const ROLE_KEYWORD_RULES: ReadonlyArray<{ role: AgentRole; keywords: readonly string[] }> = [
  { role: "cto", keywords: ["cto", "technical_director", "tech_lead", "architect"] },
  { role: "cmo", keywords: ["cmo", "marketing", "content", "growth", "brand", "seo", "social", "copywrit", "communications", "pr_lead"] },
  { role: "cfo", keywords: ["cfo", "finance", "financial", "accounting", "accountant", "bookkeep", "controller", "treasury"] },
  { role: "security", keywords: ["security", "secops", "compliance", "privacy"] },
  { role: "qa", keywords: ["qa", "quality", "tester", "testing", "test"] },
  { role: "devops", keywords: ["devops", "deploy", "deployment", "infrastructure", "infra", "sre", "reliability", "platform", "release", "cloud"] },
  { role: "designer", keywords: ["design", "ux", "ui", "creative", "illustrat"] },
  { role: "researcher", keywords: ["research", "analyst", "analysis", "analytics", "insight", "data_scien", "intelligence"] },
  { role: "pm", keywords: ["pm", "product", "project", "program", "planner", "scrum", "coordinator", "delivery"] },
  { role: "engineer", keywords: ["engineer", "engineering", "developer", "dev", "programmer", "coder", "software", "frontend", "backend", "fullstack", "full_stack", "mobile"] },
];

// Roles a plan card may not hand out: there is exactly one Chief of Staff per
// company (looked up by role), so a proposed "chief_of_staff" hire must not
// create a second one.
const RESERVED_ROLES: ReadonlySet<AgentRole> = new Set(["chief_of_staff"]);

function normalizeRoleText(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hasKeyword(normalized: string, keyword: string): boolean {
  // Short keywords ("ui", "qa", "pm", "dev") must be a whole word, so "guide"
  // is not design and "development" is not "dev"; longer ones match anywhere.
  if (keyword.length <= 3) return normalized.split("_").includes(keyword);
  return normalized.includes(keyword);
}

/** Map a proposed role string to the nearest AGENT_ROLES value ("general" when nothing fits). */
export function mapProposedAgentRole(proposedRole: string): AgentRole {
  const normalized = normalizeRoleText(proposedRole);
  if (!normalized) return "general";
  const exact = (AGENT_ROLES as readonly string[]).find((role) => role === normalized) as AgentRole | undefined;
  if (exact) return RESERVED_ROLES.has(exact) ? "general" : exact;
  for (const rule of ROLE_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => hasKeyword(normalized, keyword))) return rule.role;
  }
  return "general";
}

/** Human title for a proposed role: "research_analyst" -> "Research Analyst". Free text is kept as written. */
export function proposedRoleTitle(proposedRole: string): string {
  const trimmed = proposedRole.trim();
  if (!/^[a-z0-9_-]+$/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 3 && /^(qa|ux|ui|pm|seo|sre|cto|cmo|cfo|ceo|ai)$/.test(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}
