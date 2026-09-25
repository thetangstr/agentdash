import type { PaperclipApiClient } from "../client.js";
import type { AssistantCandidate } from "./envelope.js";

/**
 * AgentDash assistant MCP (M1, spec §4.1): names resolve on the server side,
 * never in the model. "Priya", "the checkout bug", "ACME-311", a UUID or a
 * deep link all mean the same `ref`, and a resolution that finds nobody or
 * finds several is an ANSWER (`not_found` / `needs_clarification` with at
 * most five candidates), never a guess — the `inbox_propose` rule.
 */

export interface IssueRow {
  id: string;
  companyId: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
  assigneeAgentId?: string | null;
  /** Set when the task is assigned to a person rather than an agent. */
  assigneeUserId?: string | null;
  projectId?: string | null;
  description?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
}

export interface ProjectRow {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  status?: string | null;
  leadAgentId?: string | null;
  targetDate?: string | null;
}

export type Resolution<T> =
  | { kind: "one"; value: T }
  | { kind: "none" }
  | { kind: "many"; candidates: AssistantCandidate[] };

const IDENTIFIER_PATTERN = /^[A-Za-z]+-\d+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pull the ref out of a pasted deep link (`…/issues/ACME-311`), else the ref itself. */
function refFromMaybeLink(ref: string, segment: string): string {
  const trimmed = ref.trim();
  const match = trimmed.match(new RegExp(`/${segment}/([^/?#\\s]+)`));
  return match ? match[1] : trimmed;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function toCandidates<T>(rows: T[], label: (row: T) => string, ref: (row: T) => string): AssistantCandidate[] {
  return rows.slice(0, 5).map((row) => ({ label: label(row), ref: ref(row) }));
}

function pick<T>(exact: T[], fuzzy: T[], label: (row: T) => string, ref: (row: T) => string): Resolution<T> {
  const pool = exact.length > 0 ? exact : fuzzy;
  if (pool.length === 1) return { kind: "one", value: pool[0] };
  if (pool.length === 0) return { kind: "none" };
  return { kind: "many", candidates: toCandidates(pool, label, ref) };
}

/**
 * Resolve a task reference. Identifier and UUID refs (and deep links carrying
 * one) hit `GET /issues/:id` directly — that route resolves both forms.
 * Anything else searches titles/identifiers and ranks exact matches first.
 */
export async function resolveIssueRef(
  client: PaperclipApiClient,
  companyId: string,
  rawRef: string,
): Promise<Resolution<IssueRow>> {
  const ref = refFromMaybeLink(rawRef, "issues");

  if (IDENTIFIER_PATTERN.test(ref) || UUID_PATTERN.test(ref)) {
    const direct = await client
      .requestJson<IssueRow>("GET", `/issues/${encodeURIComponent(ref)}`)
      .then((row) => row ?? null)
      .catch(() => null);
    // GET /issues/:id is company-agnostic — a pasted identifier or UUID can
    // resolve in another company. Anything outside this company is not_found,
    // not a leak and not a hint the row exists elsewhere.
    if (direct) return direct.companyId === companyId ? { kind: "one", value: direct } : { kind: "none" };
  }

  const rows = await client.requestJson<IssueRow[]>(
    "GET",
    `/companies/${companyId}/issues?q=${encodeURIComponent(ref)}&limit=50`,
  );
  const list = Array.isArray(rows) ? rows : [];
  const needle = norm(ref);
  const exact = list.filter(
    (issue) => norm(issue.identifier) === needle || norm(issue.title) === needle || issue.id === ref,
  );
  const fuzzy = list.filter(
    (issue) => norm(issue.identifier).includes(needle) || norm(issue.title).includes(needle),
  );
  return pick(
    exact,
    fuzzy,
    (issue) => `${issue.identifier ?? issue.id.slice(0, 8)} — ${issue.title}`,
    (issue) => issue.identifier ?? issue.id,
  );
}

/** Resolve an agent by name, title, role or id. */
export async function resolveAgentRef(
  client: PaperclipApiClient,
  companyId: string,
  rawRef: string,
): Promise<Resolution<AgentRow>> {
  const ref = refFromMaybeLink(rawRef, "agents");
  const rows = await client
    .requestJson<AgentRow[]>("GET", `/companies/${companyId}/agents`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as AgentRow[]);

  const needle = norm(ref);
  const exact = rows.filter(
    (agent) => norm(agent.name) === needle || norm(agent.title) === needle || agent.id === ref,
  );
  const fuzzy = rows.filter(
    (agent) =>
      norm(agent.name).includes(needle) ||
      norm(agent.title).includes(needle) ||
      norm(agent.role) === needle,
  );
  return pick(
    exact,
    fuzzy,
    (agent) => `${agent.name}${agent.title ? ` (${agent.title})` : agent.role ? ` (${agent.role})` : ""}`,
    (agent) => agent.id,
  );
}

/** Resolve a project by name or id. */
export async function resolveProjectRef(
  client: PaperclipApiClient,
  companyId: string,
  rawRef: string,
): Promise<Resolution<ProjectRow>> {
  const ref = refFromMaybeLink(rawRef, "projects");
  if (UUID_PATTERN.test(ref)) {
    const direct = await client
      .requestJson<ProjectRow>("GET", `/projects/${encodeURIComponent(ref)}`)
      .then((row) => row ?? null)
      .catch(() => null);
    // Same company-pinning rule as issues — the :id route does not scope.
    if (direct) return direct.companyId === companyId ? { kind: "one", value: direct } : { kind: "none" };
  }
  const rows = await client
    .requestJson<ProjectRow[]>("GET", `/companies/${companyId}/projects`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as ProjectRow[]);

  const needle = norm(ref);
  const exact = rows.filter((project) => norm(project.name) === needle || project.id === ref);
  const fuzzy = rows.filter((project) => norm(project.name).includes(needle));
  return pick(exact, fuzzy, (project) => project.name, (project) => project.id);
}
