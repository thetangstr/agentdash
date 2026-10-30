import { useId } from "react";
import {
  parseAgentScenarioManifestDocument,
  type AgentScenario,
  type DocumentRevision,
  type IssueDocument,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/router";
import { agentUrl, formatDateTime } from "@/lib/utils";
import { EmptyNote } from "./shared";
import { MANIFEST_EMPTY_TEXT, recommendationText } from "./brief-shared";

// AgentDash: Agent Performance Management gate 5 (P5.2) — the planner's
// scenario manifest on the brief page. Each scenario says, in plain words,
// what the planner recommends the work becomes (an existing agent, a bounded
// change, a new role, a fixed workflow, or kept with a person), why, and what
// is still unknown, with a link to the agent that would take it or to the
// draft profile for a new role. The manifest is written by an agent: it is
// shown as text, never as instructions or markup. A recommendation creates
// nothing by itself.

export interface ManifestAgentRef {
  id: string;
  name: string;
  urlKey?: string | null;
}

const DETAIL_FIELDS: Array<{ key: keyof AgentScenario; label: string }> = [
  { key: "stakeholders", label: "Stakeholders" },
  { key: "currentProcess", label: "How it's done today" },
  { key: "removedOrNewWork", label: "Work removed from people, or new work" },
  { key: "triggerCadence", label: "Trigger and cadence" },
  { key: "inputsSources", label: "Inputs and sources" },
  { key: "deliverable", label: "Deliverable" },
  { key: "acceptanceNotes", label: "What acceptable work means" },
  { key: "authorityNeeds", label: "Authority it needs" },
  { key: "escalation", label: "Escalation" },
  { key: "baselineMeasure", label: "Baseline and measure" },
];

function Who({
  scenario,
  agents,
  briefIssueId,
}: {
  scenario: AgentScenario;
  agents: ManifestAgentRef[];
  briefIssueId: string;
}) {
  if (scenario.targetAgentId) {
    const agent = agents.find((candidate) => candidate.id === scenario.targetAgentId);
    return (
      <Link to={agent ? agentUrl(agent) : `/agents/${scenario.targetAgentId}`} className="underline" data-testid="manifest-target-agent">
        {agent ? agent.name : "The named agent"}
      </Link>
    );
  }
  if (scenario.unboundProfileId) {
    return (
      <Link
        to={`/agents/drafts/${scenario.unboundProfileId}?brief=${encodeURIComponent(briefIssueId)}`}
        className="underline"
        data-testid="manifest-unbound-draft"
      >
        Open the draft profile
      </Link>
    );
  }
  if (scenario.recommendation === "new_role") return <span className="text-text-secondary">The planner hasn't written the draft profile yet.</span>;
  if (scenario.recommendation === "human_owned") return <span className="text-text-secondary">A person; no agent takes it.</span>;
  return <span className="text-text-secondary">No agent: it would be a fixed workflow.</span>;
}

function ScenarioItem({ scenario, agents, briefIssueId }: { scenario: AgentScenario; agents: ManifestAgentRef[]; briefIssueId: string }) {
  const headingId = useId();
  const details = DETAIL_FIELDS.filter((field) => typeof scenario[field.key] === "string" && (scenario[field.key] as string).trim());
  return (
    <li>
      <article aria-labelledby={headingId} className="space-y-3 rounded-md border border-border-soft px-4 py-3" data-testid="manifest-scenario">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-sm font-semibold text-text-primary">
            {scenario.title}
          </h3>
          <span className="font-mono text-xs text-text-secondary">{scenario.key}</span>
        </div>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
          <dt className="text-text-secondary">Recommendation</dt>
          <dd className="text-text-primary" data-testid="manifest-recommendation">
            <Badge variant="outline" className="whitespace-normal text-left">
              {recommendationText(scenario.recommendation)}
            </Badge>
          </dd>
          <dt className="text-text-secondary">Why</dt>
          <dd className="whitespace-pre-wrap break-words text-text-primary">{scenario.reason}</dd>
          <dt className="text-text-secondary">Still unknown</dt>
          <dd className="text-text-primary" data-testid="manifest-unknowns">
            {scenario.unknowns.length === 0 ? (
              <span className="text-text-secondary">The planner listed nothing unknown.</span>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5">
                {scenario.unknowns.map((unknown, index) => (
                  <li key={`${index}-${unknown}`} className="break-words">
                    {unknown}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="text-text-secondary">Who takes it</dt>
          <dd>
            <Who scenario={scenario} agents={agents} briefIssueId={briefIssueId} />
          </dd>
        </dl>
        <details className="text-sm">
          <summary className="flex min-h-11 cursor-pointer select-none items-center font-medium text-text-primary">
            What the planner read from the brief
          </summary>
          {details.length === 0 ? (
            <p className="text-text-secondary">Nothing else was recorded for this scenario.</p>
          ) : (
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_1fr]">
              {details.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-text-secondary">{field.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-text-primary">{scenario[field.key] as string}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      </article>
    </li>
  );
}

export function ScenarioManifestView({
  document,
  isLoading,
  error,
  agents,
  briefIssueId,
  briefRevisions,
  currentBriefRevisionId,
}: {
  /** Null when the planner hasn't written one (the document is 404). */
  document: IssueDocument | null;
  isLoading: boolean;
  /** A load failure other than "not written yet". */
  error: unknown;
  agents: ManifestAgentRef[];
  briefIssueId: string;
  briefRevisions: DocumentRevision[];
  currentBriefRevisionId: string | null;
}) {
  if (isLoading) {
    return (
      <p role="status" className="text-sm text-text-secondary" data-testid="manifest-loading">
        Loading the plan…
      </p>
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="manifest-error">
        <p className="font-medium text-text-primary">Couldn't load the plan.</p>
        <p className="mt-1 text-text-secondary">{error instanceof Error ? error.message : "The server did not say why."}</p>
      </div>
    );
  }
  if (!document) {
    return (
      <div className="space-y-1" data-testid="manifest-empty">
        <EmptyNote>{MANIFEST_EMPTY_TEXT}.</EmptyNote>
        <p className="text-sm text-text-secondary">
          Once the brief is sent, the performance manager writes its plan here: each scenario with a recommendation, the
          reason and what is still unknown.
        </p>
      </div>
    );
  }
  const parsed = parseAgentScenarioManifestDocument(document.body);
  if (!parsed.ok) {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="manifest-invalid">
        <p className="font-medium text-text-primary">The plan (revision {document.latestRevisionNumber}) can't be read as a scenario plan.</p>
        <ul className="list-disc space-y-0.5 pl-5 text-text-secondary">
          {parsed.issues.slice(0, 10).map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path || "(top level)"}: {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const { manifest } = parsed;
  const readFrom = manifest.briefRevisionId ? briefRevisions.find((revision) => revision.id === manifest.briefRevisionId) ?? null : null;
  const briefChanged = Boolean(manifest.briefRevisionId && currentBriefRevisionId && manifest.briefRevisionId !== currentBriefRevisionId);
  return (
    <div className="space-y-3" data-testid="manifest">
      <p className="text-xs text-text-secondary">
        Plan revision {document.latestRevisionNumber}, updated {formatDateTime(document.updatedAt)}.
        {readFrom ? ` Written from brief revision ${readFrom.revisionNumber}.` : ""} These are recommendations: none of them hires,
        changes or starts an agent.
      </p>
      {briefChanged ? (
        <p role="note" className="rounded-md border border-warn-500/40 px-3 py-2 text-sm text-text-primary" data-testid="manifest-stale">
          The brief changed after this plan was written
          {readFrom ? ` (the plan read revision ${readFrom.revisionNumber})` : ""}. The plan may not reflect the latest brief.
        </p>
      ) : null}
      {manifest.scenarios.length === 0 ? (
        <EmptyNote>The plan lists no scenarios yet.</EmptyNote>
      ) : (
        <ol className="space-y-3">
          {manifest.scenarios.map((scenario) => (
            <ScenarioItem key={scenario.key} scenario={scenario} agents={agents} briefIssueId={briefIssueId} />
          ))}
        </ol>
      )}
    </div>
  );
}
