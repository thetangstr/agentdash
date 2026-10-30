import {
  AGENT_BRIEF_ALREADY_SUBMITTED,
  AGENT_BRIEF_NO_PERFORMANCE_MANAGER,
  type AgentScenarioRecommendation,
} from "@paperclipai/shared";
import { apiErrorCode } from "./profile-shared";

// AgentDash: Agent Performance Management gate 5 (P5.2) — start from a brief.
// Wording the new-brief page, the brief page and the scenario manifest share.
// Saving a brief and sending it to the planner are separate steps; neither
// hires an agent or starts work.

/** The agent-work brief template (discovery draft §2). A starting point, never company facts. */
export const AGENT_BRIEF_TEMPLATE = `# Company agent-work brief

Company / tenant identifier:
Business owner and report recipient:
Business objective:
Existing autonomous AgentDash agents (IDs, roles, accountable owners):
Approved company sources and their owners:
Restrictions / actions that remain human-owned:

## Scenario S01 — [a real responsibility]
Stakeholders and decision this supports:
Current process and who does it today:
Work to remove from people, or new work to enable:
Trigger / frequency / deadline / timezone:
Inputs and authoritative sources (include freshness rules):
Expected flow and counterpart agents / people:
Deliverable and delivery destination:
What acceptable work means; examples / counterexamples if available:
What acceptance does NOT prove (for example, actual use):
Required systems and read / draft / write authority:
What the agent may decide; what needs approval:
Escalation owner and when to escalate:
Baseline, measurement source and unresolved target decisions:
Known setup / review / correction burden:
Failure consequences and unacceptable failures:

## Scenario S02 … S10
Repeat the scenario fields; leave missing facts explicitly unknown.
`;

export const BRIEF_TEMPLATE_NOTE =
  "This is a template, not your company's facts. Replace each prompt with what is true, and write “unknown” where you don't know yet. One real scenario is enough to start.";

export const BRIEF_SAVE_NO_WAKE_TEXT =
  "Saving keeps the brief as a planning issue. It doesn't assign or wake anyone, and nothing is hired.";

export const BRIEF_SUBMIT_TEXT =
  "Sending assigns the brief to the performance manager, which plans it: a scenario-by-scenario plan and draft profiles for any new roles. Nothing is hired until a person approves a hire.";

export const BRIEF_SAVED_TEXT = "Brief saved. Nobody has been asked to work on it yet.";

export const MANIFEST_EMPTY_TEXT = "The planner hasn't written a plan yet";

export const HIRE_NEEDS_APPROVAL_TEXT = "A hire request needs approval; nothing starts until it's approved.";

/** Plain words for what the planner recommends a scenario becomes. */
export const RECOMMENDATION_TEXT: Record<AgentScenarioRecommendation, string> = {
  reuse: "Give it to an existing agent as it is",
  bounded_change: "Give it to an existing agent, with a bounded change to its profile",
  new_role: "A new role, written as a draft profile",
  deterministic_workflow: "A fixed workflow, not an agent",
  human_owned: "Keep it with a person",
};

export function recommendationText(value: string): string {
  return (RECOMMENDATION_TEXT as Record<string, string>)[value] ?? value;
}

export function isNoPerformanceManagerError(error: unknown): boolean {
  return apiErrorCode(error) === AGENT_BRIEF_NO_PERFORMANCE_MANAGER;
}

export function isAlreadySubmittedError(error: unknown): boolean {
  return apiErrorCode(error) === AGENT_BRIEF_ALREADY_SUBMITTED;
}

/** The brief is still with its owner: not assigned and still in the backlog. */
export function briefIsUnsent(issue: { status: string; assigneeAgentId: string | null; assigneeUserId: string | null }): boolean {
  return issue.status === "backlog" && !issue.assigneeAgentId && !issue.assigneeUserId;
}

/** A suggested title: the first Markdown heading that isn't the template's own. */
export function suggestBriefTitle(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const match = /^#{1,3}\s+(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const heading = match[1]!;
    if (/^company agent-work brief$/i.test(heading) || /\[a real responsibility\]/i.test(heading) || /S02/.test(heading)) continue;
    return heading.slice(0, 200);
  }
  return "";
}

/** The top-level fields of an operating profile: a hire issue whose path starts with one names a draft field. */
const PROFILE_ROOTS = new Set(["identity", "responsibilities", "knowledge", "skills", "access", "rhythm", "runtime"]);

/**
 * A hire refusal's issues. Every check (the draft's own and the hire
 * validator's) answers `{ path, message }` with a dot-joined `path`. `pointer`
 * is set when the path names a draft field (`responsibilities.0.obligation` →
 * `/responsibilities/0/obligation`), so it can be labelled in the draft's words.
 */
export function hireIssues(error: unknown): Array<{ path: string; pointer: string | null; message: string }> {
  const body = (error as { body?: { details?: { issues?: unknown } } } | null)?.body;
  const issues = body?.details?.issues;
  if (!Array.isArray(issues)) return [];
  const out: Array<{ path: string; pointer: string | null; message: string }> = [];
  for (const issue of issues.slice(0, 20)) {
    if (!issue || typeof issue !== "object") continue;
    const record = issue as { path?: unknown; message?: unknown };
    if (typeof record.message !== "string") continue;
    const path = typeof record.path === "string" ? record.path : "";
    const segments = path === "" ? [] : path.split(".");
    const pointer = segments.length > 0 && PROFILE_ROOTS.has(segments[0]!) ? `/${segments.join("/")}` : null;
    out.push({ path, pointer, message: record.message });
  }
  return out;
}
