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
  { role: "cmo", keywords: ["cmo", "marketing", "content", "growth", "brand", "seo", "social", "copywrit", "communications", "pr_lead", "outreach", "campaign", "newsletter"] },
  { role: "security", keywords: ["security", "secops", "compliance", "privacy"] },
  // AgentDash (scan 4, lane O2): an accounting firm's plan proposed "Month End
  // Close Coordinator" and "Close Checklist Manager". Domain words come before
  // the generic job words in the pm rule ("coordinator"), so these land in
  // finance instead of pm / general.
  {
    role: "cfo",
    keywords: [
      "cfo", "finance", "financial", "accounting", "accountant", "bookkeep", "controller", "treasury",
      "month_end", "year_end", "close", "books", "reconcil", "ledger", "payable", "receivable", "invoic",
      "billing", "payroll", "tax", "audit", "expense", "budget",
    ],
  },
  { role: "qa", keywords: ["qa", "quality", "tester", "testing", "test"] },
  { role: "devops", keywords: ["devops", "deploy", "deployment", "infrastructure", "infra", "sre", "reliability", "platform", "release", "cloud"] },
  { role: "designer", keywords: ["design", "ux", "ui", "creative", "illustrat"] },
  { role: "researcher", keywords: ["research", "analyst", "analysis", "analytics", "insight", "data_scien", "intelligence"] },
  { role: "pm", keywords: ["pm", "product", "project", "program", "planner", "scrum", "coordinator", "delivery"] },
  { role: "engineer", keywords: ["engineer", "engineering", "developer", "dev", "programmer", "coder", "software", "frontend", "backend", "fullstack", "full_stack", "mobile"] },
];

// Roles a plan card may never hand out. The plan card is model-written, so a
// role that carries authority must not be reachable from it:
// - "ceo": defaultPermissionsForRole grants canCreateAgents, and the routes
//   give a CEO agent company-wide authority (agents.ts, issues.ts,
//   companies.ts, access.ts, workspace-runtime-service-authz.ts).
// - "chief_of_staff": exactly one per company, looked up by role, and the
//   onboarding and billing flows act through it.
// Such a proposal is hired as "general"; its wording survives as the title.
export const PRIVILEGED_PLAN_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["ceo", "chief_of_staff"]);

// Free-text spellings of the privileged roles ("Chief Executive Officer",
// "Chief of Staff", "CEO & founder").
function namesPrivilegedRole(normalized: string): boolean {
  const tokens = normalized.split("_");
  return (
    tokens.includes("ceo") ||
    normalized.includes("chief_executive") ||
    normalized.includes("chief_of_staff") ||
    normalized.includes("chiefofstaff")
  );
}

function normalizeRoleText(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Longer keywords that are still only meaningful as a whole word: "close" is
// the month-end close, not "closer" or "disclosure"; "books" is not "ebooks".
const WHOLE_WORD_KEYWORDS: ReadonlySet<string> = new Set(["close", "books"]);

function hasKeyword(normalized: string, keyword: string): boolean {
  // Short keywords ("ui", "qa", "pm", "dev") must be a whole word, so "guide"
  // is not design and "development" is not "dev"; longer ones match anywhere.
  if (keyword.length <= 3 || WHOLE_WORD_KEYWORDS.has(keyword)) return normalized.split("_").includes(keyword);
  return normalized.includes(keyword);
}

/** Map a proposed role string to the nearest AGENT_ROLES value ("general" when nothing fits). */
export function mapProposedAgentRole(proposedRole: string): AgentRole {
  const normalized = normalizeRoleText(proposedRole);
  if (!normalized || namesPrivilegedRole(normalized)) return "general";
  return withoutPrivilege(matchRole(normalized));
}

function matchRole(normalized: string): AgentRole {
  const exact = (AGENT_ROLES as readonly string[]).find((role) => role === normalized) as AgentRole | undefined;
  if (exact) return exact;
  for (const rule of ROLE_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => hasKeyword(normalized, keyword))) return rule.role;
  }
  return "general";
}

function withoutPrivilege(role: AgentRole): AgentRole {
  return PRIVILEGED_PLAN_ROLES.has(role) ? "general" : role;
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
