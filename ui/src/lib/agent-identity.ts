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
 * The one line under an agent's name: title first, then the humanized role.
 * "Proposal Drafter", "Research Analyst · Researcher", "Chief of Staff".
 */
export function agentIdentityLine(agent: { role?: string | null; title?: string | null }): string {
  const title = humanizeAgentTitle(agent.title);
  const role = humanizeAgentRole(agent.role);
  if (!title) return role;
  if (!role || agent.role === "general" || role.toLowerCase() === title.toLowerCase()) return title;
  return `${title} · ${role}`;
}

/** The short label under a name in a picker: the title, or the role when there is none. */
export function agentPickerSubtitle(agent: { role?: string | null; title?: string | null }): string {
  return humanizeAgentTitle(agent.title) || humanizeAgentRole(agent.role);
}
