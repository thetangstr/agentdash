import type { ReactNode } from "react";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  type AgentAccessContactScope,
  type AgentAccessListScope,
  type AgentAccessPolicy,
  type AgentOperatingProfileV1,
  type AgentProfileApplicationStatus,
  type AgentProfileApplicationStep,
  type AgentProfileApplicationStepStatus,
  type AgentProfileDiffEntry,
  type AgentProfileFieldAuthority,
  type AgentProfileProvenanceEntry,
  type AgentProfileProvenanceMap,
  type AgentProfileRevisionState,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { accessPolicyRefusalOf, accessPolicyRefusalSentence } from "@/lib/access-policy-refusal";
import { formatCents, formatDateTime } from "@/lib/utils";
import { describeSource } from "./shared";

// AgentDash: Agent Performance Management gate 2 — pieces the Profile tab and
// the `agent_profile_change` approval renderer share: provenance labels for
// stored revisions, plain names for JSON pointers, the per-field diff list,
// revision / application wording, and a plain summary of an access request.
// Every state is text; nothing here is a control.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server's error code: top-level `code` (draft conflict) or `details.code` (HttpError). */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown; details?: { code?: unknown } } | null;
  if (typeof body?.code === "string") return body.code;
  if (typeof body?.details?.code === "string") return body.details.code;
  return null;
}

export function apiErrorMessage(error: unknown): string {
  // AgentDash (APM gate 3): an agent's access rules refused it — say so in plain words.
  const refusal = accessPolicyRefusalOf(error);
  if (refusal) return accessPolicyRefusalSentence(refusal);
  if (error instanceof Error && error.message) return error.message;
  return "The server did not say why.";
}

/** Field issues from a 422 `AGENT_PROFILE_INVALID`. */
export function apiErrorIssues(error: unknown): Array<{ path: string; message: string }> {
  if (!(error instanceof ApiError)) return [];
  const issues = (error.body as { details?: { issues?: unknown } } | null)?.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .filter((issue): issue is { path: string; message: string } =>
      Boolean(issue) && typeof issue.path === "string" && typeof issue.message === "string",
    )
    .slice(0, 20);
}

/** A refusal from the server, written as a sentence that names what was refused. */
export function refusalText(action: string, error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return `The server refused to ${action}: ${apiErrorMessage(error)}`;
  }
  return `Couldn't ${action}: ${apiErrorMessage(error)}`;
}

// ---------------------------------------------------------------------------
// Provenance (stored revisions)
// ---------------------------------------------------------------------------

const PROVENANCE_STATE_TEXT: Record<AgentProfileProvenanceEntry["state"] | "setup_verified", string> = {
  from_brief: "From the brief",
  proposed: "Proposed",
  owner_confirmed: "Confirmed by a person",
  setup_verified: "Verified in setup",
  missing: "Missing",
};

/** The entry for `pointer`, or for its nearest ancestor (a section-level label covers its fields). */
export function provenanceFor(map: AgentProfileProvenanceMap | null | undefined, pointer: string): AgentProfileProvenanceEntry | null {
  if (!map) return null;
  let current = pointer;
  for (;;) {
    const entry = map[current];
    if (entry) return entry;
    if (current === "") return null;
    const cut = current.lastIndexOf("/");
    current = cut <= 0 ? "" : current.slice(0, cut);
  }
}

export function storedProvenanceText(entry: AgentProfileProvenanceEntry | null): string {
  if (!entry) return "Source not recorded";
  const base = PROVENANCE_STATE_TEXT[entry.state];
  if (entry.state === "missing") return base;
  const from = entry.sourceRef ? ` — from ${describeSource(entry.sourceRef)}` : "";
  return `${base}${from}`;
}

export function StoredProvenanceLabel({
  map,
  pointer,
  id,
}: {
  map: AgentProfileProvenanceMap | null | undefined;
  pointer: string;
  id?: string;
}) {
  const entry = provenanceFor(map, pointer);
  return (
    <Badge
      id={id}
      variant="secondary"
      className="whitespace-normal text-left"
      data-testid="agent-pm-provenance"
      title={entry?.at ? `Recorded ${formatDateTime(entry.at)}` : undefined}
    >
      {storedProvenanceText(entry)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Pointer labels and values
// ---------------------------------------------------------------------------

const SEGMENT_TEXT: Record<string, string> = {
  identity: "Identity",
  name: "Name",
  title: "Title",
  summary: "Summary",
  audience: "Who it serves",
  style: "Style",
  tone: "Tone",
  uncertaintyRule: "When it is unsure",
  example: "Example",
  responsibilities: "Responsibilities",
  key: "Key",
  outcome: "Outcome",
  notOwned: "Not owned",
  stakeholders: "Stakeholders",
  need: "Need",
  obligation: "Obligation",
  kind: "Kind",
  routineTriggerId: "Routine trigger",
  deliverableId: "Deliverable record",
  goalId: "Goal",
  deliverable: "Deliverable",
  what: "What",
  destination: "Where it goes",
  escalation: "Escalation",
  toUserId: "To a person",
  toAgentId: "To an agent",
  when: "When",
  performance: "How the work is judged",
  criteria: "Criteria",
  coverage: "Coverage",
  deadline: "Deadline",
  outcomeLinks: "Outcome links",
  expectedHumanSteps: "Expected human steps",
  judges: "Judges",
  thresholds: "Thresholds",
  knowledge: "What it knows",
  source: "Source",
  ref: "Reference",
  freshness: "Freshness",
  skills: "Skills",
  access: "Access",
  see: "See",
  do: "Do",
  talk: "Talk",
  projects: "Projects",
  connections: "Connections",
  agents: "Agents",
  people: "People",
  external: "Outside contacts",
  inbound: "Who can reach it",
  via: "Channels",
  permissions: "Permissions",
  monthlyBudgetCents: "Monthly budget",
  destructiveActions: "Destructive actions",
  dataScopes: "Data scopes",
  providers: "Providers",
  minimumApproval: "Minimum approval",
  policyVersion: "Policy version",
  rhythm: "Rhythm",
  timezone: "Time zone",
  quietHours: "Quiet hours",
  reportTo: "Reports to",
  reportCadence: "Report cadence",
  userId: "Person",
  agentId: "Agent",
  runtime: "Runtime",
  adapterType: "Adapter",
  model: "Model",
  environmentId: "Execution environment",
  heartbeat: "Heartbeat",
  intervalSec: "Interval (seconds)",
  wakeOnDemand: "Wakes on demand",
  profileVersion: "Profile version",
};

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The responsibility a pointer's index names: the diff entry's own `title`
 * (the server's diff carries it on every entry for or inside a
 * responsibility), else the member with the entry's `key` in `body`, else
 * that key, else the member at `index` in `body`, else its position.
 */
function responsibilityName(
  index: number,
  body: AgentOperatingProfileV1 | null | undefined,
  member: Pick<AgentProfileDiffEntry, "key" | "title"> | undefined,
): string {
  if (member?.title) return member.title;
  if (member?.key) return body?.responsibilities.find((item) => item.key === member.key)?.title || member.key;
  const at = body?.responsibilities[index];
  return at?.title || at?.key || `#${index + 1}`;
}

/**
 * Plain name for a JSON pointer, e.g. `/responsibilities/0/outcome` →
 * `Responsibility “Weekly pipeline report” › Outcome`. `member` (a diff
 * entry's `key` and `title`) names the responsibility; `body` is the
 * fallback for entries that don't carry it (older approvals, local edits).
 */
export function pointerLabel(
  pointer: string,
  body?: AgentOperatingProfileV1 | null,
  member?: Pick<AgentProfileDiffEntry, "key" | "title">,
): string {
  if (pointer === "") return "The whole profile";
  const tokens = pointer.split("/").slice(1).map(unescapeToken);
  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = index > 0 ? tokens[index - 1] : null;
    if (/^\d+$/.test(token)) {
      if (previous === "responsibilities" && index === 1) {
        parts.pop();
        parts.push(`Responsibility “${responsibilityName(Number(token), body, member)}”`);
      } else {
        parts.push(`#${Number(token) + 1}`);
      }
      continue;
    }
    parts.push(SEGMENT_TEXT[token] ?? token);
  }
  return parts.join(" › ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, readable rendering of a diff value. Never a wall of JSON. */
export function diffValueText(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "none";
  if (typeof value === "string") return value.trim() === "" ? "(empty)" : `“${truncate(value, 160)}”`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return truncate(value.join(", "), 200);
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.title === "string") return `“${truncate(record.title, 120)}”`;
    return truncate(JSON.stringify(value), 200);
  }
  return String(value);
}

const DIFF_OP_TEXT: Record<AgentProfileDiffEntry["op"], string> = {
  add: "Added",
  remove: "Removed",
  replace: "Changed",
  reorder: "Reordered",
};

/**
 * The per-field diff, one row per changed pointer. `beforeLabel` /
 * `afterLabel` name the two sides (e.g. "Active" / "This draft").
 * `annotate` adds per-row detail (the approval renderer's authority line).
 */
export function ProfileDiffList({
  diff,
  body,
  beforeLabel = "Before",
  afterLabel = "After",
  emptyText = "No differences.",
  annotate,
  testId = "agent-profile-diff",
}: {
  diff: AgentProfileDiffEntry[];
  body?: AgentOperatingProfileV1 | null;
  beforeLabel?: string;
  afterLabel?: string;
  emptyText?: string;
  annotate?: (entry: AgentProfileDiffEntry) => ReactNode;
  testId?: string;
}) {
  if (diff.length === 0) {
    return (
      <p className="text-sm text-text-secondary" data-testid={testId}>
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid={testId}>
      {diff.map((entry, index) => (
        <li
          key={`${entry.op}-${entry.pointer}-${index}`}
          className="rounded-md border border-border-soft px-3 py-2 text-sm"
          data-testid="agent-profile-diff-entry"
        >
          <p className="text-text-primary">
            <span className="font-medium">{DIFF_OP_TEXT[entry.op]}:</span> {pointerLabel(entry.pointer, body, entry)}
          </p>
          {entry.op === "reorder" ? (
            <p className="mt-1 text-text-secondary">
              {beforeLabel}: {diffValueText(entry.before)} · {afterLabel}: {diffValueText(entry.after)}
            </p>
          ) : (
            <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-text-secondary sm:grid-cols-[auto_1fr]">
              {entry.op !== "add" ? (
                <>
                  <dt>{beforeLabel}</dt>
                  <dd className="min-w-0 break-words text-text-primary">{diffValueText(entry.before)}</dd>
                </>
              ) : null}
              {entry.op !== "remove" ? (
                <>
                  <dt>{afterLabel}</dt>
                  <dd className="min-w-0 break-words text-text-primary">{diffValueText(entry.after)}</dd>
                </>
              ) : null}
            </dl>
          )}
          {annotate ? annotate(entry) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Revision, application and authority wording
// ---------------------------------------------------------------------------

export const REVISION_STATE_TEXT: Record<AgentProfileRevisionState, string> = {
  draft: "Draft",
  proposed: "Waiting for a decision",
  approved: "Approved, not applied yet",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  applied: "Active",
  application_failed: "Approved; applying it failed",
  refused_stale: "Approved; out of date when applied",
  superseded: "Replaced by a later revision",
};

export const APPLICATION_STATUS_TEXT: Record<AgentProfileApplicationStatus, string> = {
  pending: "Waiting to start",
  in_progress: "Applying",
  applied: "Applied",
  failed: "Stopped before finishing",
  refused_stale: "Stopped: the agent changed after this was proposed",
};

export const APPLICATION_STEP_TEXT: Record<AgentProfileApplicationStep, string> = {
  governance_request: "Requested access",
  config: "Configuration",
  environment: "Execution environment",
  routine_bindings: "Routine bindings (checked, never changed)",
  skills: "Skills",
  contract: "Evaluation contract",
};

export const APPLICATION_STEP_STATUS_TEXT: Record<AgentProfileApplicationStepStatus, string> = {
  pending: "Not done yet",
  done: "Done",
  skipped: "Nothing to change",
  failed: "Failed",
};

export const FIELD_AUTHORITY_TEXT: Record<AgentProfileFieldAuthority, string> = {
  steward_or_accountable: "The steward, the accountable person or a company admin",
  admin: "A company admin",
  admin_ceiling: "A company admin, who raises the ceiling as a separate recorded step",
};

// ---------------------------------------------------------------------------
// Access request summary
// ---------------------------------------------------------------------------

function listScopeText(scope: AgentAccessListScope | undefined, noun: string): string {
  if (!scope) return "not limited by the profile";
  if (scope.mode === "all") return `every ${noun}`;
  if (scope.ids.length === 0) return `no ${noun}s`;
  const shown = scope.ids.slice(0, 5).join(", ");
  const more = scope.ids.length > 5 ? ` and ${scope.ids.length - 5} more` : "";
  return `${scope.ids.length} listed ${noun}${scope.ids.length === 1 ? "" : "s"} (${shown}${more})`;
}

function contactText(scope: AgentAccessContactScope | undefined): string {
  if (!scope) return "not limited by the profile";
  switch (scope.mode) {
    case "any":
      return "anyone in the company";
    case "listed": {
      const count = (scope.agentIds?.length ?? 0) + (scope.userIds?.length ?? 0);
      return `only those listed (${count})`;
    }
    case "reports_chain":
      return "its reporting chain";
    case "accountable_only":
      return "only its accountable person, steward and admins";
    default:
      return String(scope.mode);
  }
}

/** One line per dimension, in plain words. Omitted V2 dimensions say so instead of vanishing. */
export function describeAccessRequest(access: AgentAccessPolicy): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [];
  lines.push({ label: "See projects", value: listScopeText(access.see?.projects, "project") });
  if (access.see?.connections) {
    lines.push({
      label: "Read through connections",
      value: access.see.connections.length === 0 ? "none" : `${access.see.connections.length} connection(s)`,
    });
  }
  if (access.do?.connections) {
    lines.push({
      label: "Act through connections",
      value:
        access.do.connections.length === 0
          ? "none"
          : access.do.connections
              .map((entry) => `${entry.connectionId.slice(0, 8)}: drafts ${entry.draft}, sends ${entry.send}`)
              .join("; "),
    });
  }
  lines.push({ label: "Use skills", value: listScopeText(access.do?.skills, "skill") });
  const agents = access.talk?.agents;
  lines.push({
    label: "Reach other agents",
    value: agents ? `${contactText(agents)}${agents.via.length ? `, by ${agents.via.join(", ")}` : ", by no channel"}` : contactText(undefined),
  });
  lines.push({ label: "Ask people", value: contactText(access.talk?.people) });
  if (access.talk?.external) {
    lines.push({
      label: "Contact outside the company",
      value: access.talk.external.length === 0 ? "nobody" : `through ${access.talk.external.length} connection(s)`,
    });
  }
  lines.push({ label: "Who can reach it", value: contactText(access.talk?.inbound) });
  lines.push({
    label: "Monthly budget",
    value: access.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS ? "No limit" : formatCents(access.monthlyBudgetCents),
  });
  lines.push({ label: "Destructive actions", value: access.destructiveActions.replace(/_/g, " ") });
  lines.push({ label: "Minimum approval", value: access.minimumApproval.replace(/_/g, " ") });
  return lines;
}
