import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/**
 * AgentDash (scan 3, lane H): how an agent's identity reads on screen.
 *
 * The board used to print the stored values: "general - research_analyst" in
 * the agent header, "chief of staff" / "general" under each name on Home.
 * Neither is something a CEO would write. The title is the specific job
 * ("Proposal Drafter"), so it comes first; the role is the broad family it
 * belongs to ("Researcher"), shown after it and left out when it adds nothing
 * ("General", or the same words as the title).
 */

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Sentence-free slug to words: "research_analyst" -> "Research Analyst", "qa_lead" -> "QA Lead". */
const ACRONYMS = new Set(["qa", "ui", "ux", "seo", "ai", "hr", "it", "sdr", "pm", "ceo", "cto", "cmo", "cfo", "pr"]);
const MINOR_WORDS = new Set(["of", "and", "for", "the", "to", "in"]);

function humanizeSlug(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word, position) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (position > 0 && MINOR_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** The role as a person would say it: "chief_of_staff" -> "Chief of Staff", "devops" -> "DevOps". */
export function humanizeAgentRole(role: string | null | undefined): string {
  const value = (role ?? "").trim();
  if (!value) return "";
  return roleLabels[value] ?? humanizeSlug(value);
}

/** The title as written, unless it is a slug ("proposal_drafter" -> "Proposal Drafter"). */
export function humanizeAgentTitle(title: string | null | undefined): string {
  const value = (title ?? "").trim();
  if (!value) return "";
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value) ? humanizeSlug(value) : value;
}

/**
 * AgentDash (scan 4, lane O2): roles that are buckets rather than jobs. A plan
 * hire with no closer template lands in `general` (older hires in `pm`), so
 * "Month End Close Coordinator · PM" told the CEO nothing the title had not.
 */
const GENERIC_ROLES = new Set(["general", "pm"]);

const ROLE_FAMILY_BESIDE_TITLE: Record<string, string> = {
  cfo: "Finance",
  cmo: "Marketing",
  cto: "Technology",
};

export function isGenericAgentRole(role: string | null | undefined): boolean {
  return GENERIC_ROLES.has((role ?? "").trim().toLowerCase());
}

/**
 * The one line under an agent's name: title first, then the humanized role.
 * "Proposal Drafter", "Research Analyst · Researcher", "Chief of Staff".
 * A generic role ("General", "PM") or one the title already says is left out.
 */
export function agentIdentityLine(agent: { role?: string | null; title?: string | null }): string {
  const title = humanizeAgentTitle(agent.title);
  const role = humanizeAgentRole(agent.role);
  if (!title) return role;
  if (!role || isGenericAgentRole(agent.role)) return title;
  // Beside a title the executive roles read as their family: "Month End Close
  // Coordinator · Finance", not "· CFO" (which reads as a promotion).
  const family = ROLE_FAMILY_BESIDE_TITLE[(agent.role ?? "").trim()] ?? role;
  if (title.toLowerCase().includes(family.toLowerCase()) || title.toLowerCase().includes(role.toLowerCase())) return title;
  return `${title} · ${family}`;
}

/**
 * The short label under a name in a picker: the title, or the role when there
 * is none. A generic role on its own ("General") says nothing, so it is left blank.
 */
export function agentPickerSubtitle(agent: { role?: string | null; title?: string | null }): string {
  const title = humanizeAgentTitle(agent.title);
  if (title) return title;
  return isGenericAgentRole(agent.role) ? "" : humanizeAgentRole(agent.role);
}
