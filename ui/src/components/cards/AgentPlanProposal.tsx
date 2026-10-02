import { WorkforceTemplatePreview } from "../WorkforceTemplatePreview";
// AgentDash: chat substrate card — CoS plan proposal (Phase C + #210 revision).
// See docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
import { useState } from "react";
import { AGENT_ROLE_LABELS, type AgentPlanProposalV1Payload } from "@paperclipai/shared";

const ROLE_LABELS = AGENT_ROLE_LABELS as Record<string, string>;

// AgentDash (scan 3, lane G): the plan card speaks to a non-technical CEO, so a
// role slug like "proposal_drafter" reads as "Proposal Drafter".
export function formatPlanRole(role: string | null | undefined): string {
  const raw = (role ?? "").trim();
  if (!raw) return "";
  if (ROLE_LABELS[raw]) return ROLE_LABELS[raw]!;
  if (!/[_-]/.test(raw) && raw !== raw.toLowerCase()) return raw;
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

export function AgentPlanProposal({
  payload,
  onConfirm,
  onRevise,
}: {
  payload: AgentPlanProposalV1Payload;
  onConfirm: () => void;
  // #210: accept a free-text delta so the server can produce a revised plan
  // instead of just acknowledging "reject". Callers that don't care about
  // text can still pass a no-op.
  onRevise: (revisionText: string) => void;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revisionText, setRevisionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmed = revisionText.trim();

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
  const shortTerm = isKnownPlanValue(payload?.alignmentToShortTerm) ? payload.alignmentToShortTerm : null;
  const longTerm = isKnownPlanValue(payload?.alignmentToLongTerm) ? payload.alignmentToLongTerm : null;
  return (
    <div
      className="agent-plan-proposal w-full min-w-0 border border-border-soft rounded-lg p-3 sm:p-6 bg-surface-raised shadow-sm"
      data-testid="plan-proposal"
    >
      {isKnownPlanValue(payload?.rationale) && (
        <div className="text-sm sm:text-base text-text-primary break-words">{payload.rationale}</div>
      )}

      <div className="mt-3 sm:mt-4 flex flex-col gap-3">
        {agents.map((agent, i) => {
          const role = formatPlanRole(agent.role);
          const kpis = (Array.isArray(agent.kpis) ? agent.kpis : []).filter(isKnownPlanValue);
          const responsibility = (Array.isArray(agent.responsibilities) ? agent.responsibilities : []).find(isKnownPlanValue);
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
              {responsibility && (
                <div className="mt-1 text-sm text-text-secondary break-words">{responsibility}</div>
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

      {!reviseOpen ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="min-h-11 sm:min-h-0 bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
            onClick={onConfirm}
          >
            Set it up
          </button>
          <button
            className="min-h-11 sm:min-h-0 border border-border-soft px-4 py-2 rounded-md text-sm font-medium text-text-primary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
            onClick={() => setReviseOpen(true)}
          >
            Let me revise
          </button>
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
