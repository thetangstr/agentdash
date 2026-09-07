/**
 * Pure state machine for the interactive demo. No timers, no DOM: the UI
 * dispatches actions and reads derived views, and the tests drive it directly.
 */
import { STEWARD_TOOLS } from "../content/site";
import {
  ACTORS,
  findScenario,
  type Decision,
  type Deliverable,
  type DemoEvent,
  type GateSpec,
  type IssueStatus,
  type Scenario,
} from "./scenarios";

export type Phase = "idle" | "proposed" | "running" | "gated" | "done";
export type Harness = "claude" | "codex";

export interface DemoState {
  scenarioId: string | null;
  phase: Phase;
  /** Number of scenario events revealed so far (index into the applicable list). */
  cursor: number;
  decision: Decision | null;
  harness: Harness;
}

export type DemoAction =
  | { type: "pick"; scenarioId: string }
  | { type: "send" }
  | { type: "confirm" }
  | { type: "tick" }
  | { type: "decide"; decision: Decision }
  | { type: "harness"; harness: Harness }
  | { type: "reset" };

export const initialState: DemoState = {
  scenarioId: null,
  phase: "idle",
  cursor: 0,
  decision: null,
  harness: "claude",
};

function scenarioOf(state: DemoState): Scenario | null {
  return state.scenarioId ? findScenario(state.scenarioId) ?? null : null;
}

/**
 * Events that apply given the decision taken so far. Branch-specific events
 * (`when`) are dropped until a decision exists and then filtered to it.
 */
export function applicableEvents(scenario: Scenario, decision: Decision | null): DemoEvent[] {
  return scenario.events.filter((e) => !("when" in e) || !e.when || e.when === decision);
}

export function reduce(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "pick":
      if (!findScenario(action.scenarioId)) return state;
      return { ...initialState, harness: state.harness, scenarioId: action.scenarioId };
    case "harness":
      return { ...state, harness: action.harness };
    case "send":
      if (!state.scenarioId || state.phase !== "idle") return state;
      return { ...state, phase: "proposed" };
    case "confirm":
      if (state.phase !== "proposed") return state;
      return { ...state, phase: "running", cursor: 0 };
    case "tick": {
      const scenario = scenarioOf(state);
      if (!scenario || state.phase !== "running") return state;
      const events = applicableEvents(scenario, state.decision);
      if (state.cursor >= events.length) return { ...state, phase: "done" };
      const next = events[state.cursor];
      const cursor = state.cursor + 1;
      if (next.kind === "gate") return { ...state, cursor, phase: "gated" };
      return { ...state, cursor, phase: cursor >= events.length ? "done" : "running" };
    }
    case "decide":
      if (state.phase !== "gated") return state;
      return { ...state, decision: action.decision, phase: "running" };
    case "reset":
      return { ...initialState, harness: state.harness };
    default:
      return state;
  }
}

export function visibleEvents(state: DemoState): DemoEvent[] {
  const scenario = scenarioOf(state);
  if (!scenario || state.phase === "idle" || state.phase === "proposed") return [];
  return applicableEvents(scenario, state.decision).slice(0, state.cursor);
}

/** Milliseconds until the next event should reveal, or null when waiting on the user. */
export function nextDelay(state: DemoState): number | null {
  const scenario = scenarioOf(state);
  if (!scenario || state.phase !== "running") return null;
  const events = applicableEvents(scenario, state.decision);
  const next = events[state.cursor];
  return next ? next.delay : 0;
}

export interface IssueView {
  id: string;
  title: string;
  assignee: string;
  parent?: string;
  status: IssueStatus;
  comments: Array<{ actor: string; text: string; mentions?: string[]; viaRoutine?: boolean }>;
}

export interface ApprovalView extends GateSpec {
  decision: Decision | null;
}

export interface ActivityLine {
  actor: string;
  text: string;
}

export interface BoardView {
  issues: IssueView[];
  approval: ApprovalView | null;
  deliverable: Deliverable | null;
  activity: ActivityLine[];
  /** True while a comment or status is "arriving": the latest event is agent work. */
  working: boolean;
}

export function boardView(state: DemoState): BoardView {
  const issues = new Map<string, IssueView>();
  let approval: ApprovalView | null = null;
  let deliverable: Deliverable | null = null;
  const activity: ActivityLine[] = [];
  const events = visibleEvents(state);

  for (const e of events) {
    switch (e.kind) {
      case "issue":
        issues.set(e.issue.id, { ...e.issue, status: "todo", comments: [] });
        activity.push({ actor: "quill", text: `created ${e.issue.id} · ${e.issue.title} → ${ACTORS[e.issue.assignee]?.name ?? e.issue.assignee}` });
        break;
      case "status": {
        const issue = issues.get(e.issueId);
        if (issue) {
          issue.status = e.status;
          activity.push({ actor: issue.assignee, text: `${e.issueId} → ${labelStatus(e.status)}` });
        }
        break;
      }
      case "comment": {
        const issue = issues.get(e.issueId);
        if (issue) {
          issue.comments.push({ actor: e.actor, text: e.text, mentions: e.mentions, viaRoutine: e.viaRoutine });
          activity.push({ actor: e.actor, text: `commented on ${e.issueId}${e.viaRoutine ? " (routine)" : ""}` });
        }
        break;
      }
      case "gate":
        approval = { ...e.gate, decision: state.decision };
        activity.push({ actor: e.gate.requester, text: `requested approval ${e.gate.approvalId} · ${e.gate.risk}` });
        if (state.decision) {
          activity.push({ actor: "you", text: `${state.decision === "approve" ? "approved" : "rejected"} ${e.gate.approvalId} via ${STEWARD_TOOLS.decide}` });
        }
        break;
      case "deliverable":
        deliverable = e.deliverable;
        activity.push({ actor: "quill", text: `delivered · ${e.deliverable.title}` });
        break;
    }
  }
  const last = events[events.length - 1];
  const working = state.phase === "running" && !!last && (last.kind === "comment" || last.kind === "status" || last.kind === "issue");
  return { issues: [...issues.values()], approval, deliverable, activity, working };
}

export function labelStatus(status: IssueStatus): string {
  switch (status) {
    case "todo": return "To do";
    case "in_progress": return "In progress";
    case "blocked": return "Blocked";
    case "done": return "Done";
  }
}

export type TerminalLine =
  | { kind: "prompt"; text: string }
  | { kind: "tool"; name: string; args?: string }
  | { kind: "out"; text: string; tone?: "dim" | "accent" | "ok" | "warn" }
  | { kind: "assistant"; text: string };

/** The steward's side: what Claude Code or Codex shows while the workflow runs. */
export function terminalView(state: DemoState): TerminalLine[] {
  const scenario = scenarioOf(state);
  const lines: TerminalLine[] = [];
  if (!scenario) return lines;
  const board = boardView(state);

  if (state.phase === "idle") return lines;

  lines.push({ kind: "prompt", text: scenario.request });
  lines.push({ kind: "tool", name: STEWARD_TOOLS.propose, args: JSON.stringify({ instruction: scenario.request }) });
  lines.push({ kind: "out", text: scenario.readback, tone: "dim" });
  lines.push({ kind: "assistant", text: "Here is what that would do. Nothing has changed yet. Say yes to confirm." });

  if (state.phase === "proposed") return lines;

  lines.push({ kind: "prompt", text: "yes" });
  lines.push({ kind: "tool", name: STEWARD_TOOLS.confirm, args: JSON.stringify({ token: "prop_7f3a" }) });
  lines.push({ kind: "out", text: "confirmed · assigned to Quill · handle spent", tone: "ok" });
  lines.push({ kind: "assistant", text: "Done. Quill has it. I'll check your inbox when something needs you." });

  if (state.phase === "running" && !board.approval) return lines;

  if (board.approval) {
    lines.push({ kind: "tool", name: STEWARD_TOOLS.sync });
    lines.push({ kind: "out", text: scenario.syncDigest, tone: "accent" });
    lines.push({
      kind: "assistant",
      text: `${ACTORS[board.approval.requester]?.name ?? "An agent"} is asking: ${board.approval.title} (${board.approval.risk}). Approve or reject?`,
    });
  }

  if (state.decision && board.approval) {
    lines.push({ kind: "prompt", text: state.decision === "approve" ? "approve" : "reject" });
    lines.push({
      kind: "tool",
      name: STEWARD_TOOLS.decide,
      args: JSON.stringify({ handle: "dec_21c9", decision: state.decision === "approve" ? "approved" : "rejected" }),
    });
    lines.push({ kind: "out", text: `${board.approval.approvalId} ${state.decision === "approve" ? "approved" : "rejected"} · one decision, one revision`, tone: state.decision === "approve" ? "ok" : "warn" });
  }

  if (state.phase === "done") {
    lines.push({ kind: "tool", name: STEWARD_TOOLS.sync });
    lines.push({ kind: "out", text: "0 need a decision · 0 in progress · 1 finished", tone: "ok" });
    lines.push({ kind: "assistant", text: scenario.closing[state.decision ?? "approve"] });
  }
  return lines;
}

/** Every step a visitor can take from here, for the UI's action row. */
export function availableActions(state: DemoState): Array<"send" | "confirm" | "decide" | "reset"> {
  switch (state.phase) {
    case "idle": return state.scenarioId ? ["send"] : [];
    case "proposed": return ["confirm", "reset"];
    case "running": return ["reset"];
    case "gated": return ["decide", "reset"];
    case "done": return ["reset"];
  }
}
