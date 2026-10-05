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
 * "Proposal Drafter", "Research Analyst", "Chief of Staff".
 * A generic role ("General", "PM"), one the title already says, or one that
 * shares the title's own stem ("Researcher" beside "Research Analyst") is left
 * out — the suffix only stays when it adds a word the title does not have.
 */
export function agentIdentityLine(agent: { role?: string | null; title?: string | null }): string {
  const title = humanizeAgentTitle(agent.title);
  const role = humanizeAgentRole(agent.role);
  if (!title) return role;
  if (!role || isGenericAgentRole(agent.role)) return title;
  // Beside a title the executive roles read as their family: "Month End Close
  // Coordinator · Finance", not "· CFO" (which reads as a promotion).
  const family = ROLE_FAMILY_BESIDE_TITLE[(agent.role ?? "").trim()] ?? role;
  const titleLower = title.toLowerCase();
  if (titleLower.includes(family.toLowerCase()) || titleLower.includes(role.toLowerCase())) return title;
  const titleWords = titleLower.split(/[^a-z0-9]+/).filter(Boolean);
  // Batch 2 canary: "Research Analyst · Researcher" — the role's stem is one
  // of the title's own words, so it repeats rather than adds. Two words of
  // 4+ letters sharing a prefix (so "it"/"hr"/"e" can never match — an
  // "E-commerce" title word must not swallow an "Engineer" role) counts as
  // already said.
  const sharesStem = (label: string) =>
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .some((word) => word.length >= 4 && titleWords.some((tw) => tw.length >= 4 && (word.startsWith(tw) || tw.startsWith(word))));
  if (sharesStem(family) || sharesStem(role)) return title;
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

/**
 * The identity line beneath an agent's own name, or "" when it would just
 * restate the name — "Chief of Staff" over "Chief of Staff" read as a bug on
 * every Team, Home and Org surface the canary scanned.
 */
export function agentIdentityLineUnderName(agent: {
  name?: string | null;
  role?: string | null;
  title?: string | null;
}): string {
  const line = agentIdentityLine(agent);
  const name = (agent.name ?? "").trim();
  return name && line.toLowerCase() === name.toLowerCase() ? "" : line;
}

/** Same rule in pickers: a subtitle that repeats the option's name adds nothing. */
export function agentPickerSubtitleUnderName(agent: {
  name?: string | null;
  role?: string | null;
  title?: string | null;
}): string {
  const line = agentPickerSubtitle(agent);
  const name = (agent.name ?? "").trim();
  return name && line.toLowerCase() === name.toLowerCase() ? "" : line;
}

/**
 * AgentDash (c4-hire-ux): who the "Created by" line credits.
 *
 * - the Chief of Staff stands up with the workspace — it is not hired;
 * - a CoS plan/interview hire (the `onboardingMaterialization` marker) credits
 *   the person who confirmed — `createdByUserId` — and reads "…, via Chief of
 *   Staff". Rows written before the stamp existed fall through to the
 *   unattributed wording rather than crediting the accountable person, who
 *   may not be the one who confirmed (review-1029 finding 3);
 * - a review-queue hire says so, with its reason;
 * - anything else keeps the honest "Hired by an agent".
 */
export type AgentHireOrigin =
  | { kind: "cos" }
  | { kind: "person"; userId: string; viaCos: boolean }
  | { kind: "cosUnattributed" }
  | { kind: "reviewQueue"; reason: string | null }
  | { kind: "agent" };

export function agentHireOrigin(agent: {
  role?: string | null;
  createdByUserId?: string | null;
  metadata?: unknown;
}): AgentHireOrigin {
  if (agent.role === "chief_of_staff") return { kind: "cos" };
  const metadata =
    agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : null;
  const viaCos = typeof metadata?.onboardingMaterialization === "string";
  const userId = agent.createdByUserId ?? null;
  if (userId) return { kind: "person", userId, viaCos };
  if (viaCos) return { kind: "cosUnattributed" };
  if (metadata?.autoHired === true) {
    const reason = metadata.autoHireReason;
    return { kind: "reviewQueue", reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null };
  }
  return { kind: "agent" };
}
