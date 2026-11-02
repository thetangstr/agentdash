import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AgentOperatingProfileV1, AgentProfileProvenanceMap } from "@paperclipai/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyNote, Fact, FactList, Section } from "./shared";
import { StoredProvenanceLabel, describeAccessRequest } from "./profile-shared";

// AgentDash: Agent Performance Management gate 2 — a stored profile revision,
// read-only, in the overview LLD §6 order: work it owns, how it works, what
// it knows, style, runtime (advanced, collapsed). Every field carries its
// provenance label as text, matched to the field as shown (an empty field is
// missing, a filled one never is, and an approved revision's proposals read
// "Approved").

function blank(value: string | undefined | null): boolean {
  return !value || !value.trim();
}

function textOrMissing(value: string | undefined | null): ReactNode {
  return value && value.trim() ? value : <span className="text-text-secondary">Not recorded</span>;
}

function ProvenancedFact({
  label,
  pointer,
  provenance,
  empty,
  approved,
  children,
}: {
  label: string;
  pointer: string;
  provenance: AgentProfileProvenanceMap;
  /** The value shown is empty: the label says "Missing" whatever was stored. */
  empty: boolean;
  approved: boolean;
  children: ReactNode;
}) {
  return (
    <Fact label={label}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="min-w-0">{children}</span>
        <StoredProvenanceLabel map={provenance} pointer={pointer} empty={empty} approved={approved} />
      </div>
    </Fact>
  );
}

function principalText(ref: { userId?: string; agentId?: string } | undefined): string | null {
  if (!ref) return null;
  if (ref.agentId) return `Agent ${ref.agentId}`;
  if (ref.userId) return `Person ${ref.userId}`;
  return null;
}

function obligationText(obligation: AgentOperatingProfileV1["responsibilities"][number]["obligation"]): string {
  switch (obligation.kind) {
    case "routine":
      return `Bound to routine trigger ${obligation.routineTriggerId ?? "(not set)"}`;
    case "deliverable":
      return `Bound to deliverable ${obligation.deliverableId ?? "(not set)"}`;
    case "goal":
      return `Bound to goal ${obligation.goalId ?? "(not set)"}`;
    default:
      return "Arrives as assigned work";
  }
}

function criteriaText(performance: AgentOperatingProfileV1["responsibilities"][number]["performance"]): string {
  const count = performance.criteria.length;
  if (count === 0) return "No criteria yet";
  return count === 1 ? "1 criterion" : `${count} criteria`;
}

export function ProfileBodyView({
  body,
  provenance,
  approved = false,
  testId = "agent-profile-body",
}: {
  body: AgentOperatingProfileV1;
  provenance: AgentProfileProvenanceMap;
  /** A person approved this revision (`revisionWasApproved`): proposed values read "Approved". */
  approved?: boolean;
  testId?: string;
}) {
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const { identity, rhythm, runtime } = body;
  const reportsTo = principalText(rhythm.reportTo);
  return (
    <div className="space-y-8" data-testid={testId}>
      <Section id={`${testId}-work`} title="Work it owns">
        <FactList>
          <ProvenancedFact label="Name" pointer="/identity/name" provenance={provenance} empty={blank(identity.name)} approved={approved}>
            {identity.name}
          </ProvenancedFact>
          <ProvenancedFact label="Title" pointer="/identity/title" provenance={provenance} empty={blank(identity.title)} approved={approved}>
            {textOrMissing(identity.title)}
          </ProvenancedFact>
          <ProvenancedFact label="Summary" pointer="/identity/summary" provenance={provenance} empty={blank(identity.summary)} approved={approved}>
            {textOrMissing(identity.summary)}
          </ProvenancedFact>
          <ProvenancedFact label="Who it serves" pointer="/identity/audience" provenance={provenance} empty={blank(identity.audience)} approved={approved}>
            {textOrMissing(identity.audience)}
          </ProvenancedFact>
        </FactList>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text-primary">Responsibilities</h4>
          {body.responsibilities.length === 0 ? (
            <EmptyNote>No responsibilities are recorded in this revision.</EmptyNote>
          ) : (
            <ul className="space-y-3">
              {body.responsibilities.map((item, index) => {
                const base = `/responsibilities/${index}`;
                return (
                  <li key={item.key} className="space-y-2 rounded-md border border-border-soft px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="font-medium text-text-primary">
                        {item.title} <span className="font-mono text-xs font-normal text-text-secondary">{item.key}</span>
                      </p>
                      <StoredProvenanceLabel map={provenance} pointer={`${base}/title`} empty={blank(item.title)} approved={approved} />
                    </div>
                    <FactList>
                      <ProvenancedFact label="Outcome" pointer={`${base}/outcome`} provenance={provenance} empty={blank(item.outcome)} approved={approved}>
                        {textOrMissing(item.outcome)}
                      </ProvenancedFact>
                      <ProvenancedFact label="Obligation" pointer={`${base}/obligation`} provenance={provenance} empty={false} approved={approved}>
                        {obligationText(item.obligation)}
                      </ProvenancedFact>
                      <ProvenancedFact
                        label="Deliverable"
                        pointer={`${base}/deliverable`}
                        provenance={provenance}
                        empty={blank(item.deliverable.what) && blank(item.deliverable.destination)}
                        approved={approved}
                      >
                        {item.deliverable.what.trim() || item.deliverable.destination.trim()
                          ? `${item.deliverable.what || "—"} → ${item.deliverable.destination || "—"}`
                          : textOrMissing(null)}
                      </ProvenancedFact>
                      <ProvenancedFact label="Escalation" pointer={`${base}/escalation`} provenance={provenance} empty={blank(item.escalation.when)} approved={approved}>
                        {item.escalation.when.trim()
                          ? `${item.escalation.when}${
                              principalText({ userId: item.escalation.toUserId, agentId: item.escalation.toAgentId })
                                ? ` → ${principalText({ userId: item.escalation.toUserId, agentId: item.escalation.toAgentId })}`
                                : ""
                            }`
                          : textOrMissing(null)}
                      </ProvenancedFact>
                      <ProvenancedFact label="Not owned" pointer={`${base}/notOwned`} provenance={provenance} empty={!item.notOwned?.length} approved={approved}>
                        {item.notOwned && item.notOwned.length > 0 ? item.notOwned.join("; ") : textOrMissing(null)}
                      </ProvenancedFact>
                      <ProvenancedFact
                        label="How the work is judged"
                        pointer={`${base}/performance`}
                        provenance={provenance}
                        empty={item.performance.criteria.length === 0}
                        approved={approved}
                      >
                        {criteriaText(item.performance)}
                      </ProvenancedFact>
                    </FactList>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>

      <Section id={`${testId}-rhythm`} title="How it works">
        <FactList>
          <ProvenancedFact label="Time zone" pointer="/rhythm/timezone" provenance={provenance} empty={blank(rhythm.timezone)} approved={approved}>
            {rhythm.timezone}
          </ProvenancedFact>
          <ProvenancedFact label="Quiet hours" pointer="/rhythm/quietHours" provenance={provenance} empty={blank(rhythm.quietHours)} approved={approved}>
            {textOrMissing(rhythm.quietHours)}
          </ProvenancedFact>
          <ProvenancedFact label="Reports to" pointer="/rhythm/reportTo" provenance={provenance} empty={reportsTo === null} approved={approved}>
            {textOrMissing(reportsTo)}
          </ProvenancedFact>
          <ProvenancedFact label="Report cadence" pointer="/rhythm/reportCadence" provenance={provenance} empty={blank(rhythm.reportCadence)} approved={approved}>
            {textOrMissing(rhythm.reportCadence)}
          </ProvenancedFact>
        </FactList>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium text-text-primary">What it may do (requested access)</h4>
            <StoredProvenanceLabel map={provenance} pointer="/access" approved={approved} />
          </div>
          <FactList>
            {describeAccessRequest(body.access).map((line) => (
              <Fact key={line.label} label={line.label}>
                {line.value}
              </Fact>
            ))}
          </FactList>
        </div>
      </Section>

      <Section id={`${testId}-knows`} title="What it knows">
        <FactList>
          <ProvenancedFact label="Sources" pointer="/knowledge" provenance={provenance} empty={body.knowledge.length === 0} approved={approved}>
            {body.knowledge.length === 0 ? (
              textOrMissing(null)
            ) : (
              <ul className="list-disc space-y-0.5 pl-5">
                {body.knowledge.map((source, index) => (
                  <li key={`${source.source}-${index}`}>
                    {source.source} <span className="text-text-secondary">· {source.kind.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </ProvenancedFact>
          <ProvenancedFact label="Skills" pointer="/skills" provenance={provenance} empty={body.skills.length === 0} approved={approved}>
            {body.skills.length === 0 ? <span className="text-text-secondary">None recorded</span> : body.skills.join(", ")}
          </ProvenancedFact>
        </FactList>
      </Section>

      <Section id={`${testId}-style`} title="Style">
        <FactList>
          <ProvenancedFact label="Tone" pointer="/identity/style/tone" provenance={provenance} empty={blank(identity.style.tone)} approved={approved}>
            {textOrMissing(identity.style.tone)}
          </ProvenancedFact>
          <ProvenancedFact
            label="When it is unsure"
            pointer="/identity/style/uncertaintyRule"
            provenance={provenance}
            empty={blank(identity.style.uncertaintyRule)}
            approved={approved}
          >
            {textOrMissing(identity.style.uncertaintyRule)}
          </ProvenancedFact>
          <ProvenancedFact label="Example" pointer="/identity/style/example" provenance={provenance} empty={blank(identity.style.example)} approved={approved}>
            {textOrMissing(identity.style.example)}
          </ProvenancedFact>
        </FactList>
      </Section>

      <section aria-labelledby={`${testId}-runtime-heading`} className="space-y-3" data-testid={`${testId}-runtime`}>
        <Collapsible open={runtimeOpen} onOpenChange={setRuntimeOpen}>
          <h3 id={`${testId}-runtime-heading`} className="text-base font-semibold text-text-primary">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {runtimeOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
              Runtime (advanced)
            </CollapsibleTrigger>
          </h3>
          <CollapsibleContent className="mt-3">
            <FactList>
              <ProvenancedFact label="Adapter" pointer="/runtime/adapterType" provenance={provenance} empty={blank(runtime?.adapterType)} approved={approved}>
                {runtime?.adapterType ? <code className="font-mono text-xs">{runtime.adapterType}</code> : textOrMissing(null)}
              </ProvenancedFact>
              <ProvenancedFact label="Model" pointer="/runtime/model" provenance={provenance} empty={blank(runtime?.model)} approved={approved}>
                {runtime?.model ? <code className="font-mono text-xs">{runtime.model}</code> : textOrMissing(null)}
              </ProvenancedFact>
              <ProvenancedFact
                label="Execution environment"
                pointer="/runtime/environmentId"
                provenance={provenance}
                empty={blank(runtime?.environmentId)}
                approved={approved}
              >
                {runtime?.environmentId ? <code className="font-mono text-xs">{runtime.environmentId}</code> : textOrMissing(null)}
              </ProvenancedFact>
              <ProvenancedFact
                label="Heartbeat"
                pointer="/runtime/heartbeat"
                provenance={provenance}
                empty={runtime?.heartbeat?.intervalSec == null && runtime?.heartbeat?.wakeOnDemand == null}
                approved={approved}
              >
                {runtime?.heartbeat?.intervalSec != null
                  ? `Every ${runtime.heartbeat.intervalSec} seconds`
                  : textOrMissing(null)}
                {runtime?.heartbeat?.wakeOnDemand != null
                  ? ` · wakes on demand: ${runtime.heartbeat.wakeOnDemand ? "yes" : "no"}`
                  : ""}
              </ProvenancedFact>
            </FactList>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  );
}
