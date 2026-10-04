import { WorkforceTemplatePreview } from "../WorkforceTemplatePreview";
// AgentDash: chat substrate card — CoS plan proposal (Phase C + #210 revision).
// See docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
import { useState } from "react";
import {
  AGENT_ROLE_LABELS,
  HERMES_LOCAL_ADAPTER_TYPE,
  describeHermesModel,
  type AgentPlanProposalV1Payload,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";

// AgentDash (scan 4, lane N): shown once the plan's team is hired.
export const PLAN_HIRED_LABEL = "Team hired ✓";
// AgentDash (cos-followups review): when the company gates hires on board
// approval, "Team hired" would claim a team that cannot work yet — the
// response's pendingApproval switches the label to the honest state.
export const PLAN_SENT_FOR_APPROVAL_LABEL = "Sent for approval";
// AgentDash (cos-followups-2 item 4): the approval service stamps
// approvalRejected on the card when a board rejects a hire — "Team hired"
// must not return once "Sent for approval" resolved to a no.
export const PLAN_NOT_APPROVED_LABEL = "Not approved";
export const PLAN_SUPERSEDED_NOTE = "A newer plan below replaced this one.";

function conflictDetails(err: ApiError): Record<string, unknown> | null {
  const details = (err.body as { details?: unknown } | null)?.details;
  return details && typeof details === "object" ? (details as Record<string, unknown>) : null;
}

function conflictCode(err: ApiError): string | null {
  const code = conflictDetails(err)?.code;
  return typeof code === "string" ? code : null;
}

const ROLE_LABELS = AGENT_ROLE_LABELS as Record<string, string>;

// AgentDash (scan 3, lane G): the plan card speaks to a non-technical CEO, so a
// role slug like "proposal_drafter" reads as "Proposal Drafter". Scan 4, lane
// N: only a slug is reworded; written text ("Month-End Close Coordinator",
// "Client Onboarding & Process Builder") is kept exactly as written.
export function formatPlanRole(role: string | null | undefined): string {
  const raw = (role ?? "").trim();
  if (!raw) return "";
  if (ROLE_LABELS[raw]) return ROLE_LABELS[raw]!;
  if (!/^[a-z0-9_-]+$/.test(raw)) return raw;
  return raw
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// A value the model left as "Unknown" (or empty) is not shown at all.
export function isKnownPlanValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !/^(unknown|n\/a|none|tbd)\.?$/i.test(trimmed);
}

/** The title the CoS wrote for an agent, else its humanized role. */
export function planAgentTitle(agent: { title?: unknown; role?: string | null }): string {
  const title = typeof agent.title === "string" ? agent.title.trim() : "";
  return title || formatPlanRole(agent.role);
}

export function AgentPlanProposal({
  payload,
  onConfirm,
  onRevise,
  superseded = false,
}: {
  payload: AgentPlanProposalV1Payload;
  /** A newer plan card replaced this one: no actions, a short note instead. */
  superseded?: boolean;
  /**
   * May reject: a 409 means the team was already hired. A resolved
   * `pendingApproval` means the hires are waiting on board approval, so the
   * card says "Sent for approval" rather than "Team hired".
   */
  onConfirm: () => Promise<{ pendingApproval?: boolean } | void> | { pendingApproval?: boolean } | void;
  // #210: accept a free-text delta so the server can produce a revised plan
  // instead of just acknowledging "reject". Callers that don't care about
  // text can still pass a no-op.
  onRevise: (revisionText: string) => void;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revisionText, setRevisionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [hiredHere, setHiredHere] = useState(false);
  const [sentForApproval, setSentForApproval] = useState(false);
  const [supersededHere, setSupersededHere] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const trimmed = revisionText.trim();
  // Hired: the server marked the card (confirmedAt), or this click (or a 409
  // answering it) says the team already exists.
  const hired = hiredHere || (typeof payload?.confirmedAt === "string" && payload.confirmedAt.length > 0);
  // Awaiting the board: this click returned pendingApproval, or the card was
  // persisted that way — the label survives a reload and other tabs. When
  // the server has since written a decided value onto the card (the
  // realtime update clears pendingApproval once every hire is decided), it
  // wins over the click-time flag so the tab shows the outcome.
  const awaitingApproval = typeof payload?.pendingApproval === "boolean"
    ? payload.pendingApproval
    : sentForApproval;
  // A rejection landed on a decided card; while approvals still wait the
  // "Sent for approval" label is the honest one.
  const notApproved = payload?.approvalRejected === true;

  async function confirm() {
    if (hired || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const outcome = await onConfirm();
      setSentForApproval(outcome?.pendingApproval === true);
      setHiredHere(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && conflictCode(err) === "superseded_plan") {
        setSupersededHere(true);
      } else if (err instanceof ApiError && err.status === 409) {
        // A 409 carrying details.repair is the repair contract, not "the team
        // exists" — show what the server said instead of claiming "Team
        // hired".
        if (typeof conflictDetails(err)?.repair === "string") {
          setConfirmError(err.message || "Couldn't set up the team. Try again.");
        } else {
          setHiredHere(true);
        }
      } else {
        setConfirmError(err instanceof Error && err.message ? err.message : "Couldn't set up the team. Try again.");
      }
    } finally {
      setConfirming(false);
    }
  }

  function submit() {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    onRevise(trimmed);
    // Optimistic: parent emits a new plan card via WS, so this card stays
    // visible but the new one will appear. Reset our local state so a
    // second revise attempt on the SAME card (rare) starts fresh.
    setReviseOpen(false);
    setRevisionText("");
    setSubmitting(false);
  }
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  // AgentDash: the rationale is generated for the hire prompt
  // (agent-creator-from-proposal renders it when the plan materializes), but
  // the card no longer shows it — it restated the same plan prose the reply
  // already carried, which read three times in a row. The alignment lines
  // stay: forward-looking context nothing else renders.
  const shortTerm = isKnownPlanValue(payload?.alignmentToShortTerm) ? payload.alignmentToShortTerm : null;
  const longTerm = isKnownPlanValue(payload?.alignmentToLongTerm) ? payload.alignmentToLongTerm : null;
  return (
    <div
      className="agent-plan-proposal w-full min-w-0 border border-border-soft rounded-lg p-3 sm:p-6 bg-surface-raised shadow-sm"
      data-testid="plan-proposal"
    >
      <div className="flex flex-col gap-3">
        {agents.map((agent, i) => {
          const role = planAgentTitle(agent);
          const kpis = (Array.isArray(agent.kpis) ? agent.kpis : []).filter(isKnownPlanValue);
          const responsibilities = (Array.isArray(agent.responsibilities) ? agent.responsibilities : []).filter(isKnownPlanValue);
          return (
            <div
              key={`${agent.role}-${i}`}
              className="min-w-0 border border-border-soft rounded-md p-3 bg-surface-base"
              data-testid="plan-proposal-agent"
            >
              <div className="text-sm font-semibold text-text-primary break-words">
                {agent.name}
                {role ? <span className="text-text-secondary font-normal"> — {role}</span> : null}
              </div>
              <WorkforceTemplatePreview templateId={agent.workforceTemplateId}/>
              {agent.adapterType === HERMES_LOCAL_ADAPTER_TYPE && agent.modelTier && agent.model && (
                // AgentDash (review-1028): render the tier+model the SERVER
                // stamped on the plan — never recompute here, so env
                // overrides and the opt-in/BYOK gate are honored. Absent on
                // older payloads and whenever tiers are off or BYOK-protected.
                <p className="mt-1 text-xs text-text-tertiary" data-testid="plan-agent-model">
                  Model: {describeHermesModel({ model: agent.model, modelTier: agent.modelTier })?.text}
                </p>
              )}
              {responsibilities.length > 0 && (
                // AgentDash (c3-a11y): an agent can carry several
                // responsibilities — show them all; a tight bullet list stays
                // readable on a phone where one wrapped paragraph would not.
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-text-secondary break-words">
                  {responsibilities.map((responsibility, j) => (
                    <li key={j}>{responsibility}</li>
                  ))}
                </ul>
              )}
              {kpis.length > 0 && (
                <p className="mt-2 text-sm text-text-secondary break-words">
                  <span className="font-medium text-text-primary">Targets:</span> {kpis.join("; ")}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {(shortTerm || longTerm) && (
        <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-text-secondary break-words">
          {shortTerm && (
            <div>
              <span className="font-medium text-text-primary">Short-term:</span> {shortTerm}
            </div>
          )}
          {longTerm && (
            <div>
              <span className="font-medium text-text-primary">Long-term:</span> {longTerm}
            </div>
          )}
        </div>
      )}

      {!hired && (superseded || supersededHere) ? (
        <p className="mt-5 text-sm text-text-tertiary" data-testid="plan-superseded">
          {PLAN_SUPERSEDED_NOTE}
        </p>
      ) : hired ? (
        <div className="mt-5 flex flex-wrap gap-2" data-testid="plan-hired">
          <button
            type="button"
            className="min-h-11 sm:min-h-0 border border-border-soft bg-surface-sunken px-4 py-2 rounded-md text-sm font-medium text-text-primary disabled:cursor-default"
            disabled
            aria-disabled="true"
          >
            {awaitingApproval
              ? PLAN_SENT_FOR_APPROVAL_LABEL
              : notApproved
                ? PLAN_NOT_APPROVED_LABEL
                : PLAN_HIRED_LABEL}
          </button>
          <button
            type="button"
            className="min-h-11 sm:min-h-0 border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-tertiary disabled:cursor-not-allowed"
            disabled
            aria-disabled="true"
          >
            Let me revise
          </button>
        </div>
      ) : !reviseOpen ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="min-h-11 sm:min-h-0 bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-60 disabled:cursor-wait"
            onClick={() => void confirm()}
            disabled={confirming}
          >
            {confirming ? "Setting up…" : "Set it up"}
          </button>
          <button
            type="button"
            className="min-h-11 sm:min-h-0 border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-50"
            onClick={() => setReviseOpen(true)}
            disabled={confirming}
          >
            Let me revise
          </button>
          {confirmError ? (
            <p className="w-full text-sm text-text-secondary" role="alert">
              {confirmError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-2" data-testid="plan-revise-form">
          <textarea
            value={revisionText}
            onChange={(e) => setRevisionText(e.target.value)}
            placeholder="Tell me what to change — e.g. 'drop the second researcher, swap finance for marketing'"
            className="w-full min-h-[88px] border border-border-soft rounded-md px-3 py-2 text-sm bg-surface-base text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 resize-y"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                setReviseOpen(false);
                setRevisionText("");
              }
            }}
            autoFocus
          />
          <div className="flex flex-wrap gap-2 items-center">
            <button
              className="min-h-11 sm:min-h-0 bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={submit}
              disabled={!trimmed || submitting}
            >
              {submitting ? "Revising…" : "Send revision"}
            </button>
            <button
              className="min-h-11 sm:min-h-0 border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-surface-sunken transition-colors"
              onClick={() => {
                setReviseOpen(false);
                setRevisionText("");
              }}
              disabled={submitting}
            >
              Cancel
            </button>
            <span className="hidden sm:inline text-xs text-text-tertiary ml-auto">
              ⌘/Ctrl + Enter to send
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
