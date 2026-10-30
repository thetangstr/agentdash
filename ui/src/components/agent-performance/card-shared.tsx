import type { ReactNode } from "react";
import type {
  AgentCardContractSummary,
  AgentCardFatalFlag,
  AgentCardSectionView,
  AgentCaseRow,
  AgentExceptionKind,
  AgentFatalClass,
  AgentJudgeKind,
  AgentObligationEndState,
  AgentWorkRole,
  EvaluationCriterionRef,
  EvaluationTypedPredicate,
  EvaluationWorkItemRef,
} from "@paperclipai/shared";
import { evaluationCriterionRefKey } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { EmptyNote, Section } from "./shared";

// AgentDash: Agent Performance Management gate 3 (P3.5) — words and small
// pieces for the agent card on the Performance tab (overview LLD §1,
// evaluation LLD §6, §10–§12). Every state is text; unknown is "Unknown",
// never 0; there is no score, gauge or ranking.

export const NOT_VISIBLE_TEXT = "Not visible to you";
export const NO_STORED_CARD_TEXT = "No stored card yet";
export const COMPUTED_NOT_SAVED_TEXT = "Computed now — not saved";

export const END_STATE_TEXT: Record<AgentObligationEndState, string> = {
  delivered_on_time: "Delivered on time",
  delivered_late: "Delivered late",
  in_progress: "In progress",
  not_started: "Not started",
  missed: "Missed",
  blocked_on_person: "Blocked on a person",
  blocked_on_access: "Blocked on access",
  blocked_on_platform: "Blocked on the platform",
  skipped_by_policy: "Skipped by policy",
  cancelled: "Cancelled",
  cause_unknown: "Cause unknown",
};

/** End states shown on every responsibility, zero included; the rest only when they occur. */
export const PRIMARY_END_STATES: readonly AgentObligationEndState[] = [
  "delivered_on_time",
  "delivered_late",
  "in_progress",
  "not_started",
  "missed",
  "cause_unknown",
];

export const JUDGE_TEXT: Record<AgentJudgeKind, string> = {
  person: "A person",
  independent_agent: "An independent agent",
  harness: "The harness",
  evaluator: "Record checks",
  self: "The agent itself",
};

export const FATAL_CLASS_TEXT: Record<AgentFatalClass, string> = {
  fabrication: "Fabricated facts, claims or prices",
  leakage: "Leakage across companies or into restricted data",
  unauthorized_execution: "Ran something outside its access",
  false_execution_claim: "Claimed to have done something it did not do",
};

export const FATAL_STATUS_TEXT: Record<AgentCardFatalFlag["status"], string> = {
  potential: "Potential — not confirmed by a person",
  confirmed: "Confirmed by a person",
  dismissed: "Dismissed by a person",
};

export const EXCEPTION_KIND_TEXT: Record<AgentExceptionKind, string> = {
  unauthorized_execution: "Ran something outside its access",
  repeated_after_refusal: "Tried again after a refusal",
  disagreement: "Judgments disagree",
};

export const ROLE_TEXT: Record<AgentWorkRole, string> = {
  responsible: "Responsible",
  producer: "Produced it",
  contributor: "Contributed",
  reviewer: "Reviewed it",
  requester: "Requested it",
  feedback_recipient: "Received feedback",
};

/** Plain words for any case state. */
export function caseStateText(state: AgentCaseRow["state"]): string {
  if (state in END_STATE_TEXT) return END_STATE_TEXT[state as AgentObligationEndState];
  switch (state) {
    case "pass":
      return "Passed";
    case "fail":
      return "Failed";
    case "unknown":
      return "Unknown";
    case "refused":
      return "Refused";
    case "repeated_after_refusal":
      return "Tried again after a refusal";
    case "would_refuse":
      return "Would have been refused (shadow)";
    case "unauthorized_execution":
      return "Ran outside its access";
    case "potential":
    case "confirmed":
    case "dismissed":
      return FATAL_STATUS_TEXT[state];
    default:
      return String(state);
  }
}

/** The state filter a drill-down offers, per section. */
export function caseStatesFor(section: AgentCaseRow["section"]): AgentCaseRow["state"][] {
  switch (section) {
    case "obligations":
      return Object.keys(END_STATE_TEXT) as AgentObligationEndState[];
    case "bounds":
      return ["refused", "repeated_after_refusal", "would_refuse", "unauthorized_execution"];
    case "fatal":
      return ["potential", "confirmed", "dismissed"];
    default:
      return ["pass", "fail", "unknown"];
  }
}

export function predicateText(predicate: EvaluationTypedPredicate): string {
  switch (predicate.kind) {
    case "none":
      return "No check: this criterion can't be measured yet";
    case "record":
      return `Checked from records (${predicate.predicate})`;
    case "status":
      return `Checked from the ${predicate.subject}'s status (${predicate.value.replace(/_/g, " ")})`;
    case "human_attest":
      return "Attested by a named person";
    case "goal_metric":
      return `Goal metric target ${predicate.target} ${predicate.unit}`;
    case "metric":
      return `Metric ${predicate.metricKey}: no measurement source`;
    case "unknown":
      return `Unknown check (${predicate.record}): undecidable`;
  }
}

/** The criterion's declared text and predicate from the contract in force, by tuple. */
export function criterionFromContract(
  contract: AgentCardContractSummary,
  ref: EvaluationCriterionRef,
): { text: string; predicate: EvaluationTypedPredicate; humanJudgeUserId: string | null } | null {
  const key = evaluationCriterionRefKey(ref);
  for (const responsibility of contract.responsibilities) {
    for (const criterion of responsibility.criteria) {
      if (evaluationCriterionRefKey(criterion.ref) === key) {
        return { text: criterion.text, predicate: criterion.predicate, humanJudgeUserId: responsibility.humanJudge?.userId ?? null };
      }
    }
  }
  return null;
}

/** A link to the work item: an issue by its identifier, a deliverable run by its key (no page of its own). */
export function WorkItemLink({ item, label }: { item: EvaluationWorkItemRef | null; label?: string | null }) {
  if (!item) return <span className="text-text-secondary">No work item</span>;
  if (item.kind === "issue") {
    return (
      <Link to={`/issues/${label ?? item.id}`} className="font-medium text-text-primary underline underline-offset-2">
        {label ?? `Issue ${item.id.slice(0, 8)}`}
      </Link>
    );
  }
  return <span className="font-medium text-text-primary">Deliverable run {label ?? item.id.slice(0, 8)}</span>;
}

/**
 * One card section as the viewer receives it: "Not visible to you" with no
 * counts, a partial note above the body, or the body.
 */
export function CardSection<T>({
  id,
  title,
  description,
  view,
  children,
  aside,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  view: AgentCardSectionView<T>;
  children: (body: T) => ReactNode;
  /** Rendered after the body (e.g. an open drill-down), only when the section is readable. */
  aside?: ReactNode;
}) {
  return (
    <Section id={id} title={title} description={description}>
      {view.visibility === "not_visible" ? (
        <p className="text-sm text-text-secondary" data-testid="agent-card-not-visible">
          <span className="font-medium text-text-primary">{NOT_VISIBLE_TEXT}.</span>{" "}
          {view.note && view.note !== NOT_VISIBLE_TEXT ? view.note : "The records behind this section are in places you can't read."}
        </p>
      ) : (
        <>
          {view.visibility === "partial" ? (
            <p className="rounded-md border border-border-soft bg-surface-sunken px-3 py-2 text-sm text-text-secondary" data-testid="agent-card-partial">
              <span className="font-medium text-text-primary">Partly visible.</span> {view.note}
            </p>
          ) : null}
          {children(view.body)}
          {aside}
        </>
      )}
    </Section>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-medium text-text-primary">{children}</h4>;
}

export function NoneYet({ children }: { children?: ReactNode }) {
  return <EmptyNote>{children ?? "No observed cases yet."}</EmptyNote>;
}
