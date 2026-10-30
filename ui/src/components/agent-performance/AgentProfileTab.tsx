import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  AgentAccountableParty,
  AgentProfileDerived,
  AgentProfileRevisionDto,
  AgentProfileView as AgentProfileViewDto,
  DerivedField,
} from "@paperclipai/shared";
import { agentPerformanceApi, agentPerformanceQueryKeys } from "@/api/agent-performance";
import { agentProfileQueryKeys, agentProfilesApi } from "@/api/agent-profiles";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Link } from "@/lib/router";
import { cn, formatDateTime } from "@/lib/utils";
import {
  Banner,
  EmptyNote,
  Fact,
  FactList,
  GapList,
  ProvenanceLabel,
  Section,
  ViewStatus,
} from "./shared";
import { REVISION_STATE_TEXT, refusalText } from "./profile-shared";
import { ProfileApplicationStatus } from "./ProfileApplicationStatus";
import { ProfileBodyView } from "./ProfileBodyView";
import { ProfileDraftEditor } from "./ProfileDraftEditor";
import { ProfileHistory } from "./ProfileHistory";

// AgentDash: Agent Performance Management — the Profile tab.
//
// Gate 1: a read-only operating profile the server derives from today's
// records (overview LLD §3.3) — revision 0, a starting point: nothing on it is
// confirmed or applied, and every field says where it came from or that it is
// missing.
//
// Gate 2: people define it. The tab shows the active revision (or revision 0),
// the open draft in an editor, the proposal waiting for a decision, the newest
// application with each step, and the revision history with diffs. Three
// separate records: saving a draft changes nothing; proposing files an
// approval; only an applied revision changes the agent. The UI never applies.
// Which controls show follows the view's `viewer` flags, which the server
// computes from the mutations' own guards; any refusal it still makes is
// shown as written.

export const PROFILE_BANNER_TEXT =
  "This is a starting point built from today's records. Nothing here has been confirmed or applied.";

/** Provenance for a value the contract carries without a `DerivedField` wrapper. */
function fixed<T>(value: T, source: string, present: boolean): DerivedField<T> {
  return { value, provenance: present ? "proposed" : "missing", source: present ? source : null };
}

function DerivedFact<T>({
  label,
  field,
  render,
}: {
  label: string;
  field: DerivedField<T>;
  render: (value: T) => ReactNode;
}) {
  return (
    <Fact label={label}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="min-w-0">{field.provenance === "missing" ? <span className="text-text-secondary">Not recorded</span> : render(field.value)}</span>
        <ProvenanceLabel provenance={field.provenance} source={field.source} />
      </div>
    </Fact>
  );
}

function text(value: string | null) {
  return value && value.trim() ? value : <span className="text-text-secondary">Not recorded</span>;
}

function stringList(values: string[]) {
  if (values.length === 0) return <span className="text-text-secondary">None recorded</span>;
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {values.map((value, index) => (
        <li key={`${value}-${index}`}>{value}</li>
      ))}
    </ul>
  );
}

function heartbeatText(heartbeat: AgentProfileDerived["rhythm"]["heartbeat"]): string {
  if (!heartbeat.enabled) return "Off";
  if (heartbeat.intervalSec == null) return "On, interval not recorded";
  const sec = heartbeat.intervalSec;
  if (sec % 3600 === 0) return `Every ${sec / 3600} hour${sec === 3600 ? "" : "s"}`;
  if (sec % 60 === 0) return `Every ${sec / 60} minute${sec === 60 ? "" : "s"}`;
  return `Every ${sec} seconds`;
}

function wakeOnDemandText(value: boolean | null): string {
  if (value === null) return "Unknown";
  return value ? "Yes" : "No";
}

function obligationText(obligation: AgentProfileDerived["responsibilities"][number]["obligation"]): string {
  if (obligation.kind === "routine") {
    const count = obligation.routineTriggerIds?.length ?? 0;
    return count > 0 ? `Bound to a routine (${count} trigger${count === 1 ? "" : "s"})` : "Bound to a routine";
  }
  if (obligation.kind === "assigned") return "Arrives as assigned work";
  return "No obligation recorded";
}

/** Gate 1's derived revision 0, read-only. */
export function DerivedProfileView({
  profile,
  accountable,
}: {
  profile: AgentProfileDerived;
  /** The accountable party the agent page already resolved, used to name the person. */
  accountable?: AgentAccountableParty | null;
}) {
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const { identity, rhythm, runtime } = profile;
  const accountableId = rhythm.accountableUserId;
  const accountableLabel =
    accountableId && accountable?.userId === accountableId
      ? (accountable.name ?? accountable.email ?? accountableId)
      : accountableId;
  const reportsToLabel = rhythm.reportsTo.agentName ?? rhythm.reportsTo.agentId;

  return (
    <div className="space-y-8" data-testid="agent-profile-derived">
      <Banner>
        <p>{PROFILE_BANNER_TEXT}</p>
        <p className="mt-1 text-xs">Built {formatDateTime(profile.generatedAt)}.</p>
      </Banner>

      <Section id="agent-profile-work" title="Work it owns">
        <FactList>
          <DerivedFact label="Title" field={identity.title} render={text} />
          <DerivedFact label="Role" field={identity.role} render={(v) => v} />
          <DerivedFact label="Summary" field={identity.summary} render={text} />
          <DerivedFact label="Objective" field={profile.objective} render={text} />
          <DerivedFact label="Measures (KPIs)" field={profile.kpis} render={stringList} />
        </FactList>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text-primary">Responsibilities</h4>
          {profile.responsibilities.length === 0 ? (
            <EmptyNote>No responsibilities are recorded for this agent.</EmptyNote>
          ) : (
            <ul className="space-y-2">
              {profile.responsibilities.map((item) => (
                <li key={item.key} className="rounded-md border border-border-soft px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium text-text-primary">{item.title}</p>
                    <ProvenanceLabel provenance="proposed" source={item.source} />
                  </div>
                  <p className="mt-1 text-text-secondary">{obligationText(item.obligation)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section id="agent-profile-rhythm" title="How it works">
        <FactList>
          <DerivedFact
            label="Heartbeat"
            field={fixed(rhythm.heartbeat, "agent.runtimeConfig.heartbeat", true)}
            render={(hb) => (
              <span>
                {heartbeatText(hb)} · wakes on demand: {wakeOnDemandText(hb.wakeOnDemand)}
              </span>
            )}
          />
          <DerivedFact
            label="Reports to"
            field={fixed(reportsToLabel, "agent.reportsTo", Boolean(reportsToLabel))}
            render={(v) => v}
          />
          <DerivedFact
            label="Accountable person"
            field={fixed(accountableLabel, "agent.accountableUserId", Boolean(accountableLabel))}
            render={(v) => v}
          />
        </FactList>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-text-primary">Routines</h4>
          {rhythm.routines.length === 0 ? (
            <EmptyNote>No routines are assigned to this agent.</EmptyNote>
          ) : (
            <ul className="space-y-2">
              {rhythm.routines.map((routine) => (
                <li key={routine.routineId} className="rounded-md border border-border-soft px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium text-text-primary">
                      {routine.title} <span className="font-normal text-text-secondary">· status: {routine.status}</span>
                    </p>
                    <ProvenanceLabel provenance="proposed" source={`routine:${routine.routineId}`} />
                  </div>
                  {routine.triggers.length === 0 ? (
                    <p className="mt-1 text-text-secondary">No triggers.</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-text-secondary">
                      {routine.triggers.map((trigger) => (
                        <li key={trigger.id}>
                          {trigger.kind}
                          {trigger.cronExpression ? (
                            <>
                              {" "}
                              <code className="font-mono text-xs">{trigger.cronExpression}</code>
                            </>
                          ) : null}
                          {trigger.timezone ? ` (${trigger.timezone})` : ""} · {trigger.enabled ? "enabled" : "disabled"}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section id="agent-profile-knows" title="What it knows">
        <FactList>
          <DerivedFact label="Skills" field={profile.skills} render={stringList} />
        </FactList>
      </Section>

      <Section id="agent-profile-style" title="Style">
        <FactList>
          <DerivedFact
            label="Communication style"
            field={fixed<string | null>(null, "", false)}
            render={text}
          />
        </FactList>
      </Section>

      <section aria-labelledby="agent-profile-runtime-heading" className="space-y-3" data-testid="agent-profile-runtime">
        <Collapsible open={runtimeOpen} onOpenChange={setRuntimeOpen}>
          <h3 id="agent-profile-runtime-heading" className="text-base font-semibold text-text-primary">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {runtimeOpen ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
              Runtime (advanced)
            </CollapsibleTrigger>
          </h3>
          <CollapsibleContent className="mt-3">
            <FactList>
              <DerivedFact
                label="Adapter"
                field={fixed(runtime.adapterType, "agent.adapterType", Boolean(runtime.adapterType))}
                render={(v) => <code className="font-mono text-xs">{v}</code>}
              />
              <DerivedFact
                label="Model"
                field={fixed(runtime.model, "agent.adapterConfig.model", Boolean(runtime.model))}
                render={(v) => <code className="font-mono text-xs">{v}</code>}
              />
              <DerivedFact
                label="Execution environment"
                field={fixed(runtime.environmentId, "agent.defaultEnvironmentId", Boolean(runtime.environmentId))}
                render={(v) => <code className="font-mono text-xs">{v}</code>}
              />
            </FactList>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <GapList id="agent-profile-gaps" gaps={profile.gaps} />
    </div>
  );
}


export const APPLICATION_IN_PROGRESS_TEXT =
  "An approved profile change is being applied. New runs for this agent wait until it finishes.";

export const READ_ONLY_PROFILE_TEXT =
  "You can read this profile. Drafting changes is for the agent's steward, its accountable person or a company admin.";

function decisionText(canDecide: boolean | null): string | null {
  if (canDecide === true) return "You can decide it.";
  if (canDecide === false) return "You can't decide this change; it needs someone with the authority it lists.";
  return null;
}

function revisionLine(revision: Pick<AgentProfileRevisionDto, "revisionNumber" | "state" | "updatedAt">): string {
  return `Revision ${revision.revisionNumber} · ${REVISION_STATE_TEXT[revision.state]} · ${formatDateTime(revision.updatedAt)}`;
}

function ProfileTabContent({
  companyId,
  agentId,
  view,
  accountable,
}: {
  companyId: string;
  agentId: string;
  view: AgentProfileViewDto;
  accountable?: AgentAccountableParty | null;
}) {
  const queryClient = useQueryClient();
  const viewKey = agentPerformanceQueryKeys.profile(companyId, agentId);
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: viewKey });
    void queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.revisions(companyId, agentId) });
  }

  function announce(text: string) {
    setProblem(null);
    setAnnouncement(text);
  }

  const createDraft = useMutation({
    mutationFn: () => agentProfilesApi.createDraft(companyId, agentId),
    onSuccess: (created) => {
      queryClient.setQueryData<AgentProfileViewDto>(viewKey, (current) =>
        current ? { ...current, profileId: created.profileId, latestDraft: created } : current,
      );
      // Re-read the view so its `viewer` flags (e.g. may propose) answer for the new draft.
      refresh();
      announce(
        view.active
          ? `Draft revision ${created.revisionNumber} started from the active profile. Nothing changes until it is approved and applied.`
          : `Draft revision ${created.revisionNumber} started from revision 0. Nothing changes until it is approved and applied.`,
      );
    },
    onError: (error) => {
      setAnnouncement("");
      setProblem(refusalText("start a draft", error));
      refresh();
    },
  });

  const withdraw = useMutation({
    mutationFn: (revisionId: string) => agentProfilesApi.withdraw(companyId, agentId, revisionId),
    onSuccess: (revision) => {
      announce(`Revision ${revision.revisionNumber} withdrawn. Nothing changed for the agent.`);
      refresh();
    },
    onError: (error) => {
      setAnnouncement("");
      setProblem(refusalText("withdraw the request", error));
    },
  });

  const { active, latestDraft, pendingProposal, latestApplication, derived, viewer } = view;
  const decision = decisionText(viewer.canDecideActiveProposal);

  return (
    <div className="max-w-4xl space-y-8" data-testid="agent-profile-tab">
      {view.applicationInProgress ? (
        <Banner>
          <p data-testid="agent-profile-applying">{APPLICATION_IN_PROGRESS_TEXT}</p>
        </Banner>
      ) : null}

      <section aria-labelledby="agent-profile-status-heading" className="space-y-3" data-testid="agent-profile-status">
        <h3
          id="agent-profile-status-heading"
          ref={statusHeadingRef}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary focus-visible:outline-none"
        >
          Profile status
        </h3>
        <FactList>
          <Fact label="Active profile">
            {active ? revisionLine(active) : "None applied yet. Below is revision 0, a starting point built from today's records."}
          </Fact>
          <Fact label="Open draft">{latestDraft ? revisionLine(latestDraft) : "None"}</Fact>
          <Fact label="Waiting for a decision">
            {pendingProposal ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{revisionLine(pendingProposal)}</span>
                {pendingProposal.approvalId ? (
                  <Link className="text-accent-500 underline-offset-4 hover:underline" to={`/approvals/${pendingProposal.approvalId}`}>
                    Open the approval
                  </Link>
                ) : null}
                {decision ? (
                  <span className="text-text-secondary" data-testid="agent-profile-can-decide">
                    {decision}
                  </span>
                ) : null}
              </span>
            ) : (
              "Nothing"
            )}
          </Fact>
        </FactList>
        {!latestDraft && !viewer.canEditDraft ? (
          <p className="text-sm text-text-secondary" data-testid="agent-profile-read-only">
            {READ_ONLY_PROFILE_TEXT}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {!latestDraft && viewer.canEditDraft ? (
            <Button
              type="button"
              aria-disabled={createDraft.isPending}
              onClick={() => !createDraft.isPending && createDraft.mutate()}
              data-testid="agent-profile-draft-changes"
            >
              {createDraft.isPending ? "Starting a draft…" : "Draft changes"}
            </Button>
          ) : null}
          {pendingProposal && viewer.canWithdraw ? (
            <Button
              type="button"
              variant="outline"
              aria-disabled={withdraw.isPending}
              onClick={() => !withdraw.isPending && withdraw.mutate(pendingProposal.id)}
              data-testid="agent-profile-withdraw"
            >
              {withdraw.isPending ? "Withdrawing…" : `Withdraw revision ${pendingProposal.revisionNumber}`}
            </Button>
          ) : null}
          {active ? (
            <Button variant="ghost" asChild>
              <a href={agentProfilesApi.exportMarkdownUrl(companyId, agentId, active.id)} download={`profile-revision-${active.revisionNumber}.md`}>
                Export Markdown (active)
              </a>
            </Button>
          ) : null}
        </div>
        <p
          role="status"
          aria-live="polite"
          className={cn("text-sm", announcement ? "text-text-primary" : "sr-only")}
          data-testid="agent-profile-tab-status"
        >
          {announcement}
        </p>
        {problem ? (
          <p role="alert" className="rounded-md border border-danger-500/30 px-3 py-2 text-sm text-text-primary" data-testid="agent-profile-tab-error">
            {problem}
          </p>
        ) : null}
      </section>

      {latestApplication ? (
        <ProfileApplicationStatus
          companyId={companyId}
          agentId={agentId}
          application={latestApplication}
          applicationInProgress={view.applicationInProgress}
          canResume={viewer.canResumeApplication}
          onResumed={(result) => {
            announce(
              result.activated
                ? "The approved revision is now active."
                : "Resumed. The application hasn't finished; its steps are shown below.",
            );
            refresh();
          }}
        />
      ) : null}

      {latestDraft && !viewer.canEditDraft ? (
        <section aria-labelledby="agent-profile-draft-readonly-heading" className="space-y-3" data-testid="agent-profile-draft-readonly">
          <h3 id="agent-profile-draft-readonly-heading" className="text-base font-semibold text-text-primary">
            Draft revision {latestDraft.revisionNumber}
          </h3>
          <p className="text-sm text-text-secondary">
            Saved {formatDateTime(latestDraft.updatedAt)}. Only the agent's steward, its accountable person, a company admin or
            the draft's author can change it. Nothing changes for the agent until it is approved and applied.
          </p>
          <Button variant="ghost" asChild>
            <a href={agentProfilesApi.exportMarkdownUrl(companyId, agentId, latestDraft.id)} download={`profile-revision-${latestDraft.revisionNumber}.md`}>
              Export Markdown (saved draft)
            </a>
          </Button>
          <ProfileBodyView body={latestDraft.body} provenance={latestDraft.provenance} testId="agent-profile-draft-readonly-body" />
        </section>
      ) : null}

      {latestDraft && viewer.canEditDraft ? (
        <ProfileDraftEditor
          key={latestDraft.id}
          companyId={companyId}
          agentId={agentId}
          draft={latestDraft}
          mayPropose={viewer.canPropose}
          onSaved={(saved) => {
            queryClient.setQueryData<AgentProfileViewDto>(viewKey, (current) =>
              current ? { ...current, latestDraft: saved } : current,
            );
            void queryClient.invalidateQueries({ queryKey: agentProfileQueryKeys.revisions(companyId, agentId) });
          }}
          onProposed={(result) => {
            announce(
              `Revision ${result.revision.revisionNumber} sent for approval. Nothing changes for the agent until it is approved and applied.`,
            );
            refresh();
            statusHeadingRef.current?.focus();
          }}
          onStale={refresh}
        />
      ) : null}

      {active ? (
        <div className="space-y-4" data-testid="agent-profile-active">
          <Banner>
            <p>
              The active profile: revision {active.revisionNumber}, applied {formatDateTime(active.updatedAt)}. This is what the
              agent works from.
            </p>
          </Banner>
          <ProfileBodyView body={active.body} provenance={active.provenance} testId="agent-profile-active-body" />
        </div>
      ) : derived ? (
        <DerivedProfileView profile={derived} accountable={accountable} />
      ) : (
        <EmptyNote>No profile is available for this agent.</EmptyNote>
      )}

      {view.profileId ? <ProfileHistory companyId={companyId} agentId={agentId} activeRevisionId={active?.id ?? null} /> : null}
    </div>
  );
}

export function AgentProfileTab({
  companyId,
  agentId,
  accountable,
}: {
  companyId: string;
  agentId: string;
  accountable?: AgentAccountableParty | null;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: agentPerformanceQueryKeys.profile(companyId, agentId),
    queryFn: () => agentPerformanceApi.profile(companyId, agentId),
    retry: false,
  });
  // The profile is readable by any member who can see the agent, so a 403 is
  // an unexpected refusal: show the server's own message, not the
  // accountable/steward/admin text the restricted views use.
  if (!data) return <ViewStatus what="profile" isLoading={isLoading} error={error} />;
  return <ProfileTabContent companyId={companyId} agentId={agentId} view={data} accountable={accountable} />;
}
