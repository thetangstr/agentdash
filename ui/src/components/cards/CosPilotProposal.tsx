import { useState } from "react";
import type { CosPilotProposalV1Payload } from "@paperclipai/shared";
import { ClipboardCheck, Clock3, FileText, ShieldCheck } from "lucide-react";

export function CosPilotProposal({
  payload,
  onLaunch,
  onRevise,
}: {
  payload: CosPilotProposalV1Payload;
  onLaunch: () => void;
  onRevise?: (revisionText: string) => void;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revisionText, setRevisionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const contract = payload.delegationContract;
  const plan = payload.pilotPlan;
  const approvalSummary = contract.operatingBoundaries.requiresApproval.join("; ");
  const trimmed = revisionText.trim();

  function submitRevision() {
    if (!onRevise || !trimmed || submitting) return;
    setSubmitting(true);
    onRevise(trimmed);
    setReviseOpen(false);
    setRevisionText("");
    setSubmitting(false);
  }

  return (
    <div className="cos-pilot-proposal min-w-0" data-testid="cos-pilot-proposal">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-50 text-accent-700">
          <ClipboardCheck className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Delegation contract</p>
          <p className="mt-1 text-sm text-text-secondary">{payload.rationale}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-border-soft bg-surface-base p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <ShieldCheck className="h-4 w-4 text-accent-600" aria-hidden />
            Boundaries
          </div>
          <ul className="mt-2 space-y-1 text-sm text-text-secondary">
            {contract.preferences.slice(0, 2).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-tertiary">Approval required: {approvalSummary}</p>
        </section>

        <section className="rounded-md border border-border-soft bg-surface-base p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Clock3 className="h-4 w-4 text-accent-600" aria-hidden />
            {plan.durationDays}-day plan
          </div>
          <p className="mt-2 text-sm text-text-secondary">{plan.projectName}</p>
          <p className="mt-2 text-xs text-text-tertiary">{plan.heartbeatCadence}</p>
        </section>
      </div>

      <section className="mt-3 rounded-md border border-border-soft bg-surface-base p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <FileText className="h-4 w-4 text-accent-600" aria-hidden />
          Pilot outputs
        </div>
        <div className="mt-2 grid gap-2 text-sm text-text-secondary md:grid-cols-2">
          {plan.successMetrics.map((metric) => (
            <div key={`${metric.label}-${metric.target}`}>
              <span className="font-medium text-text-primary">{metric.label}:</span> {metric.target}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-3 rounded-md border border-border-soft bg-surface-base p-3">
        <p className="text-sm font-medium text-text-primary">Approval gates</p>
        <ul className="mt-2 space-y-1 text-sm text-text-secondary">
          {plan.approvalGates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-text-tertiary">Access requested</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {contract.access.map((grant) => (
            <span
              key={`${grant.system}-${grant.mode}`}
              className="rounded-full border border-border-soft bg-surface-base px-2.5 py-1 text-xs text-text-secondary"
            >
              {grant.system} · {grant.mode.replace("_", " ")}
            </span>
          ))}
        </div>
      </div>

      {!reviseOpen ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
            onClick={onLaunch}
          >
            Launch pilot
          </button>
          {onRevise && (
            <button
              className="rounded-md border border-border-soft px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
              onClick={() => setReviseOpen(true)}
            >
              Revise contract
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2" data-testid="cos-pilot-revise-form">
          <textarea
            value={revisionText}
            onChange={(event) => setRevisionText(event.target.value)}
            placeholder="Tell me what to change — e.g. 'keep HubSpot read-only', 'make this CBO-first', or 'tighten the HR approval boundary'"
            className="min-h-[88px] w-full resize-y rounded-md border border-border-soft bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:border-accent-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitRevision();
              }
              if (event.key === "Escape") {
                setReviseOpen(false);
                setRevisionText("");
              }
            }}
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={submitRevision}
              disabled={!trimmed || submitting}
            >
              {submitting ? "Revising…" : "Send revision"}
            </button>
            <button
              className="rounded-md border border-border-soft px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-sunken"
              onClick={() => {
                setReviseOpen(false);
                setRevisionText("");
              }}
              disabled={submitting}
            >
              Cancel
            </button>
            <span className="ml-auto text-xs text-text-tertiary">⌘/Ctrl + Enter to send</span>
          </div>
        </div>
      )}
    </div>
  );
}
