import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentRecommendationDecisionValue,
  AgentRecommendationDto,
  AgentRecommendationEvidence,
  PerformanceManagerView,
} from "@paperclipai/shared";
import { agentProfileQueryKeys, agentProfilesApi } from "@/api/agent-profiles";
import { performanceManagerApi, performanceManagerQueryKeys } from "@/api/performance-manager";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { EventDrawer } from "@/pages/evaluation/shared";
import {
  ManagerFiledBadge,
  PERFORMANCE_MANAGER_ADVISORY_TEXT,
  RECOMMENDATION_KIND_TEXT,
  isManagerFiledRevision,
} from "./manager-shared";
import { REVISION_STATE_TEXT, apiErrorCode, refusalText } from "./profile-shared";
import { Banner, EmptyNote, Section, StateBadge, ViewStatus } from "./shared";

// AgentDash: Agent Performance Management gate 4 (P4.2) — on the Performance
// tab: the performance manager's recommendations about this agent, with
// their reason, cited evidence and decision state, and the profile changes
// the manager proposed for it. A recommendation is advisory: it changes
// nothing, and an accepted "pause" pauses nothing — the owner uses the
// agent's own pause action. The decision action is offered only when the
// list's `viewer.canDecide` (the decision route's own guard: the accountable
// person or a company admin) says so; a refusal the server still returns is
// shown as written. The manager's proposals are read from each revision's
// `proposedByCapacity`, so no approval is fetched here.

export const RECOMMENDATIONS_EMPTY_TEXT = "No recommendations yet.";
export const DECIDER_HINT_TEXT =
  "The agent's accountable person or a company admin can record a decision. Recording it changes nothing else.";
/** For a reader who may not decide: who can, instead of an action that would be refused. */
export const NOT_DECIDER_TEXT = "Only the agent's accountable person or a company admin can record a decision.";
export const PAUSE_NOT_APPLIED_TEXT = "Accepting it does not pause the agent. To pause it, use the agent's pause action.";
export const MANAGER_PROPOSALS_EMPTY_TEXT = "The performance manager has proposed no profile changes for this agent.";

/** `<section>:<eventId>` case ids name their ledger event; occurrence ids don't. */
function caseEventId(ref: string): string | null {
  const colon = ref.indexOf(":");
  if (colon <= 0 || colon === ref.length - 1) return null;
  return ref.slice(colon + 1);
}

function cardVersionOf(ref: string): number | null {
  return /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null;
}

function EvidenceItem({
  evidence,
  onOpenEvent,
  onShowCardVersion,
}: {
  evidence: AgentRecommendationEvidence;
  onOpenEvent: (eventId: string) => void;
  onShowCardVersion?: (version: number) => void;
}) {
  const linkClass = "text-accent-500 underline-offset-4 hover:underline focus-visible:underline";
  if (evidence.kind === "card") {
    const version = cardVersionOf(evidence.ref);
    if (version !== null && onShowCardVersion) {
      return (
        <button type="button" className={linkClass} onClick={() => onShowCardVersion(version)}>
          Card version {version}
        </button>
      );
    }
    return <span>Card {version !== null ? `version ${version}` : <span className="font-mono text-xs">{evidence.ref}</span>}</span>;
  }
  const eventId = evidence.kind === "event" ? evidence.ref : caseEventId(evidence.ref);
  const label = evidence.kind === "event" ? "Evaluator record" : "Case";
  if (eventId) {
    return (
      <button type="button" className={linkClass} onClick={() => onOpenEvent(eventId)} title={evidence.ref}>
        {label} <span className="font-mono text-xs">{evidence.ref.length > 24 ? `${evidence.ref.slice(0, 24)}…` : evidence.ref}</span>
      </button>
    );
  }
  return (
    <span>
      {label} <span className="font-mono text-xs">{evidence.ref}</span>
      <span className="text-text-secondary"> — listed under the card's numbers</span>
    </span>
  );
}

function decisionValueText(recommendation: AgentRecommendationDto): string {
  if (!recommendation.decision) return "None recorded yet";
  return recommendation.decision.decision === "accepted" ? "Accepted" : "Declined";
}

function DecisionForm({
  recommendation,
  pending,
  onSubmit,
  onCancel,
  formId,
}: {
  recommendation: AgentRecommendationDto;
  pending: boolean;
  onSubmit: (decision: AgentRecommendationDecisionValue, note: string) => void;
  onCancel: () => void;
  formId: string;
}) {
  const [decision, setDecision] = useState<AgentRecommendationDecisionValue>("accepted");
  const [note, setNote] = useState("");
  const groupName = useId();
  const noteId = useId();
  return (
    <form
      id={formId}
      className="space-y-2 rounded-md border border-border-soft px-3 py-2"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSubmit(decision, note.trim());
      }}
      data-testid="agent-recommendation-decision-form"
    >
      <fieldset className="space-y-1">
        <legend className="text-sm text-text-primary">Your decision on this recommendation</legend>
        {(["accepted", "declined"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
              className="accent-foreground"
              data-testid={`agent-recommendation-${value}`}
            />
            {value === "accepted" ? "Accept" : "Decline"}
          </label>
        ))}
      </fieldset>
      {recommendation.kind === "pause" ? <p className="text-sm text-text-secondary">{PAUSE_NOT_APPLIED_TEXT}</p> : null}
      <label htmlFor={noteId} className="block text-sm text-text-primary">
        Note (optional)
      </label>
      <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={2} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="agent-recommendation-submit">
          {pending ? "Recording…" : "Record decision"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecommendationItem({
  recommendation,
  managerView,
  personName,
  onOpenEvent,
  onShowCardVersion,
  canDecide,
  deciding,
  onDecide,
  problem,
}: {
  recommendation: AgentRecommendationDto;
  managerView: PerformanceManagerView | null;
  personName: (userId: string) => string;
  onOpenEvent: (eventId: string) => void;
  onShowCardVersion?: (version: number) => void;
  /** The list's `viewer.canDecide`. */
  canDecide: boolean;
  deciding: boolean;
  onDecide: (decision: AgentRecommendationDecisionValue, note: string) => void;
  problem: string | null;
}) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  const decision = recommendation.decision;
  const effective = managerView?.effective ?? null;
  const from =
    effective && effective.agentId === recommendation.recommendedByAgentId
      ? `${effective.name}, the performance manager`
      : `Agent ${recommendation.recommendedByAgentId.slice(0, 8)}, not the performance manager now`;
  return (
    <li className="space-y-2 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-recommendation">
      <div className="space-y-0.5">
        <p className="font-medium text-text-primary" data-testid="agent-recommendation-kind">
          {RECOMMENDATION_KIND_TEXT[recommendation.kind] ?? recommendation.kind}
        </p>
        <p className="text-xs text-text-secondary">
          From {from} · {formatDateTime(recommendation.recommendedAt)}
        </p>
      </div>
      <p className="whitespace-pre-wrap text-text-primary" data-testid="agent-recommendation-reason">
        <span className="text-text-secondary">Reason: </span>
        {recommendation.reason}
      </p>
      <div className="space-y-1">
        <p className="text-text-secondary">Cited evidence</p>
        {recommendation.evidence.length === 0 ? (
          <p className="text-text-secondary">None cited.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5" data-testid="agent-recommendation-evidence">
            {recommendation.evidence.map((evidence, index) => (
              <li key={`${evidence.kind}-${evidence.ref}-${index}`}>
                <EvidenceItem evidence={evidence} onOpenEvent={onOpenEvent} onShowCardVersion={onShowCardVersion} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {recommendation.proposalApprovalId ? (
        <p>
          <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/approvals/${recommendation.proposalApprovalId}`}>
            Open the profile change it goes with
          </Link>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" data-testid="agent-recommendation-decision">
        <StateBadge label="Decision" value={decisionValueText(recommendation)} />
        {decision ? (
          <span className="text-text-secondary">
            by {personName(decision.decidedByUserId)} · {formatDateTime(decision.decidedAt)}
          </span>
        ) : null}
      </div>
      {decision?.note ? (
        <p className="whitespace-pre-wrap text-text-secondary">
          <span className="text-text-primary">Note: </span>
          {decision.note}
        </p>
      ) : null}
      {decision && recommendation.kind === "pause" && decision.decision === "accepted" ? (
        <p className="text-text-secondary" data-testid="agent-recommendation-pause-note">
          Nothing was paused by accepting it. To pause the agent, use the agent's pause action.
        </p>
      ) : null}
      {!decision && !canDecide ? (
        <p className="text-xs text-text-secondary" data-testid="agent-recommendation-not-decider">
          {NOT_DECIDER_TEXT}
        </p>
      ) : null}
      {!decision && canDecide ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={open}
              aria-controls={formId}
              onClick={() => setOpen(!open)}
              data-testid="agent-recommendation-decide"
            >
              {open ? "Hide the decision form" : "Record a decision"}
            </Button>
            <span className="text-xs text-text-secondary">{DECIDER_HINT_TEXT}</span>
          </div>
          {open ? (
            <DecisionForm
              recommendation={recommendation}
              pending={deciding}
              formId={formId}
              onSubmit={(value, note) => onDecide(value, note)}
              onCancel={() => setOpen(false)}
            />
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-destructive" data-testid="agent-recommendation-problem">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The recommendations about one agent (`GET .../evaluation/agents/:agentId/recommendations`). */
export function AgentRecommendationsSection({
  companyId,
  agentId,
  managerView,
  personName,
  onShowCardVersion,
}: {
  companyId: string;
  agentId: string;
  managerView: PerformanceManagerView | null;
  personName: (userId: string) => string;
  /** Switches the tab's card to a cited stored version. */
  onShowCardVersion?: (version: number) => void;
}) {
  const queryClient = useQueryClient();
  const listKey = performanceManagerQueryKeys.recommendations(companyId, agentId);
  const [announcement, setAnnouncement] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => performanceManagerApi.recommendations(companyId, agentId),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: AgentRecommendationDecisionValue; note: string }) =>
      performanceManagerApi.decide(companyId, agentId, input.id, {
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
      }),
    onSuccess: (result, input) => {
      setProblems((current) => {
        const next = { ...current };
        delete next[input.id];
        return next;
      });
      setAnnouncement(result.next || "Recorded. A recommendation changes nothing by itself.");
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (error, input) => {
      setAnnouncement("");
      setProblems((current) => ({ ...current, [input.id]: refusalText("record the decision", error) }));
      // Someone else decided it first: show their decision.
      if (apiErrorCode(error) === "AGENT_RECOMMENDATION_ALREADY_DECIDED") {
        void queryClient.invalidateQueries({ queryKey: listKey });
      }
    },
  });

  const recommendations = list.data?.recommendations ?? [];
  // Fail closed: no flag (an older server) offers no decision action.
  const canDecide = list.data?.viewer?.canDecide === true;
  return (
    <Section
      id="agent-performance-recommendations"
      title="Recommendations"
      description="From the company's performance manager. A recommendation changes nothing by itself; the people responsible for the agent decide what to do."
    >
      {!list.data ? (
        <ViewStatus what="recommendations" isLoading={list.isLoading} error={list.error} />
      ) : (
        <>
          {recommendations.length === 0 ? (
            <EmptyNote>{RECOMMENDATIONS_EMPTY_TEXT}</EmptyNote>
          ) : (
            <ul className="space-y-2" data-testid="agent-recommendations">
              {recommendations.map((recommendation) => (
                <RecommendationItem
                  key={recommendation.id}
                  recommendation={recommendation}
                  managerView={managerView}
                  personName={personName}
                  onOpenEvent={setOpenEventId}
                  onShowCardVersion={onShowCardVersion}
                  canDecide={canDecide}
                  deciding={decide.isPending && decide.variables?.id === recommendation.id}
                  onDecide={(decision, note) => decide.mutate({ id: recommendation.id, decision, note })}
                  problem={problems[recommendation.id] ?? null}
                />
              ))}
            </ul>
          )}
          {list.data.restricted ? (
            <p className="text-xs text-text-secondary" data-testid="agent-recommendations-restricted">
              Some recommendations may be hidden from you because the evidence they cite is in work you can't see.
            </p>
          ) : null}
        </>
      )}
      <p role="status" aria-live="polite" className={announcement ? "text-sm text-text-primary" : "sr-only"} data-testid="agent-recommendations-status">
        {announcement}
      </p>
      <EventDrawer companyId={companyId} eventId={openEventId} onClose={() => setOpenEventId(null)} />
    </Section>
  );
}

/** Profile changes the performance manager proposed for this agent, read from each revision's `proposedByCapacity`. */
export function ManagerProposalsSection({ companyId, agentId }: { companyId: string; agentId: string }) {
  const revisions = useQuery({
    queryKey: agentProfileQueryKeys.revisions(companyId, agentId),
    queryFn: () => agentProfilesApi.revisions(companyId, agentId),
    retry: false,
  });
  const filed = (revisions.data ?? [])
    .filter((revision) => !!revision.approvalId && isManagerFiledRevision(revision))
    .sort((a, b) => b.revisionNumber - a.revisionNumber);
  return (
    <Section
      id="agent-performance-manager-proposals"
      title="Profile changes the performance manager proposed"
      description="Each one waits for a person's decision. Pending or rejected proposals leave the active profile unchanged."
    >
      {!revisions.data ? (
        <ViewStatus what="proposals" isLoading={revisions.isLoading} error={revisions.error} />
      ) : filed.length === 0 ? (
        <EmptyNote>{MANAGER_PROPOSALS_EMPTY_TEXT}</EmptyNote>
      ) : (
        <ul className="space-y-2" data-testid="agent-manager-proposals">
          {filed.map((revision) => (
            <li key={revision.id} className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-manager-proposal">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">Revision {revision.revisionNumber}</span>
                <span className="text-text-secondary">· {REVISION_STATE_TEXT[revision.state]}</span>
                <ManagerFiledBadge />
              </div>
              <p className="text-xs text-text-secondary">
                Drafted {formatDateTime(revision.createdAt)} · last changed {formatDateTime(revision.updatedAt)}
              </p>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/approvals/${revision.approvalId}`}>
                  Open the approval
                </Link>
                <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/agents/${agentId}/profile`}>
                  Open the profile and revision history
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** On the manager's own Performance tab: what the role is, and the way to its record. */
export function ManagerRoleBanner({ agentId, managerView }: { agentId: string; managerView: PerformanceManagerView | null }) {
  if (!managerView?.effective || managerView.effective.agentId !== agentId) return null;
  return (
    <Banner>
      <p data-testid="agent-performance-manager-banner">
        This agent is the company's performance manager. {PERFORMANCE_MANAGER_ADVISORY_TEXT}{" "}
        <Link
          className="text-accent-500 underline-offset-4 hover:underline"
          to={`/agents/${agentId}/manager-record`}
          data-testid="agent-performance-manager-record-link"
        >
          Open its record as performance manager
        </Link>
      </p>
    </Banner>
  );
}
