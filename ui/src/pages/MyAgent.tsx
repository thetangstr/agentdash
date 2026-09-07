import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { activityApi } from "../api/activity";
import { bridgeApi } from "../api/bridge";
import { agentGovernanceApi } from "../api/agent-governance";
import { issuesApi } from "../api/issues";
import { stewardshipsApi } from "../api/stewardships";
import { StewardRequestEditor } from "../components/agent/StewardRequestEditor";
import { AgentMandateEditor } from "../components/agent/AgentMandateEditor";
import { ConnectYourHarness } from "../components/agent/ConnectYourHarness";
import { ConnectYourMachine } from "../components/agent/ConnectYourMachine";
import { DecisionsNeedingYou } from "../components/agent/DecisionsNeedingYou";
import { QuestionsForYou } from "../components/agent/QuestionsForYou";
import { MyChannels } from "../components/agent/MyChannels";
import { HubspotConnectionPanel } from "../components/agent/HubspotConnectionPanel";
import { useCompany } from "../context/CompanyContext";
import { describeActivity } from "../lib/agent-activity-copy";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";

/**
 * A steward's page for the one agent that works for them.
 *
 * Ordered by what a person came to find out, which is not the order the data
 * arrives in. Before, this page stacked eleven panels of identical weight and
 * put four consecutive setup forms — authority, harness, machine, mandate —
 * above every piece of live information, leaving the only thing with a cost to
 * being late (a decision an agent is stopped on) eighth and below the fold.
 *
 * Now: what needs you, then what your agent is doing, then what it just did.
 * Setup collapses to one line once it is done, because it is a first-day task
 * competing with a page used every day. Governance is folded because changing
 * what an agent may do should be deliberate and found on purpose.
 */

/** One sentence answering "do I need to do anything?" before any panel loads. */
function statusSentence(name: string, workCount: number, needsCount: number): string {
  const doing =
    workCount === 0
      ? `${name} has nothing assigned`
      : `${name} is working on ${workCount} thing${workCount === 1 ? "" : "s"}`;
  if (needsCount === 0) return `${doing}. Nothing needs you.`;
  return `${doing} and needs you on ${needsCount}.`;
}

function Fold({
  summary,
  children,
  tone = "plain",
}: {
  summary: string;
  children: React.ReactNode;
  tone?: "plain" | "done";
}) {
  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-4 py-2.5 text-sm text-muted-foreground marker:text-muted-foreground">
        {tone === "done" ? <span className="text-foreground">✓ </span> : null}
        {summary}
      </summary>
      <div className="flex flex-col gap-4 border-t px-4 py-4">{children}</div>
    </details>
  );
}

export default function MyAgent() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const isProfileCompany = selectedCompany?.productProfile === "agentdash_mk";

  const myAgent = useQuery({
    queryKey: queryKeys.myAgent.detail(selectedCompanyId ?? ""),
    queryFn: () => stewardshipsApi.getMyAgent(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const agentId = myAgent.data?.agent?.id ?? null;

  const inbox = useQuery({
    queryKey: queryKeys.myAgent.inbox(selectedCompanyId ?? ""),
    queryFn: () => stewardshipsApi.getMyInbox(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const governance = useQuery({
    queryKey: queryKeys.myAgent.governance(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => agentGovernanceApi.get(selectedCompanyId!, agentId!),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  const currentWork = useQuery({
    queryKey: queryKeys.myAgent.currentWork(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeAgentId: agentId! }),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  // Same query key as ConnectYourMachine, so React Query serves both from one
  // request rather than asking twice.
  const endpoints = useQuery({
    queryKey: ["bridge", "me", "endpoints", selectedCompanyId ?? ""],
    queryFn: () => bridgeApi.listMyEndpoints(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const activity = useQuery({
    queryKey: queryKeys.myAgent.activity(selectedCompanyId ?? "", agentId ?? ""),
    queryFn: () => activityApi.list(selectedCompanyId!, { agentId: agentId!, limit: 10 }),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
  });

  if (!isProfileCompany) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This workspace does not use the AgentDash-MK profile.
        </p>
      </div>
    );
  }

  if (myAgent.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading your agent…</div>;
  }

  if (myAgent.error) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-destructive">
          {myAgent.error instanceof Error ? myAgent.error.message : "Failed to load your agent"}
        </p>
      </div>
    );
  }

  const agent = myAgent.data?.agent ?? null;

  // Unassigned is an explicit state, not an empty page: ordinary users must not
  // be offered a way to self-claim an agent.
  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">My Agent</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No agent assigned. A company owner or administrator assigns your agent.
        </p>
      </div>
    );
  }

  const items = inbox.data?.items ?? [];
  const work = currentWork.data ?? [];
  const events = activity.data ?? [];
  // getMyAgent returns only the caller's own stewardship, so its userId is the
  // viewer — which is what lets the activity feed say "You" truthfully.
  const viewerUserId = myAgent.data?.stewardship?.userId ?? null;
  // `enrolledAt` is null until an enrolment is approved, so a pending request
  // is deliberately not "connected" — the fold would otherwise claim a machine
  // could reach you before it can.
  const machineConnected = (endpoints.data?.endpoints ?? []).some(
    (endpoint) => endpoint.enrolledAt !== null,
  );

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* The h1 names the page, not the status.
       *
       * The status sentence is the loudest thing here, but loudness is the
       * stylesheet's job — making it the h1 left "My Agent" as a styled <p>,
       * so the page had no heading naming it. That broke heading navigation
       * and made this state inconsistent with the four guard states above,
       * which all render <h1>My Agent</h1>. */}
      <header className="flex flex-col gap-1">
        <h1 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          My Agent
        </h1>
        <p className="text-xl font-semibold leading-snug text-foreground">
          {statusSentence(agent.name, work.length, items.length)}
        </p>
        <p className="text-xs text-muted-foreground">
          {agent.name} · {agent.role} · {agent.status}
        </p>
      </header>

      <DecisionsNeedingYou
        companyId={selectedCompanyId!}
        agentId={agentId}
        agentName={agent.name}
        items={items}
      />

      {/* Fact requests are the other half of "needs you": a question only the
          steward can answer, rather than a decision to permit an action. Kept
          as its own component because its no-dismiss, no-pre-filled-draft rules
          are deliberate, but placed here so both kinds of blocking sit together. */}
      <QuestionsForYou companyId={selectedCompanyId!} agentName={agent.name} />

      <section aria-labelledby="my-agent-work-heading" className="rounded-lg border">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <h2 id="my-agent-work-heading" className="text-sm font-semibold">
            What {agent.name} is doing
          </h2>
          {work.length ? <span className="text-xs text-muted-foreground">{work.length}</span> : null}
        </div>
        {currentWork.isLoading ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>
        ) : currentWork.error ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {currentWork.error instanceof Error
              ? currentWork.error.message
              : "Failed to load current work"}
          </p>
        ) : work.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Nothing is assigned to {agent.name} right now.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {work.slice(0, 10).map((issue) => (
              <li
                key={issue.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2.5"
              >
                <Link to={`/issues/${issue.id}`} className="text-sm underline">
                  {issue.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {issue.status.replace(/_/g, " ")}
                  {issue.updatedAt ? ` · ${timeAgo(issue.updatedAt)}` : ""}
                  {issue.identifier ? ` · ${issue.identifier}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="my-agent-activity-heading" className="rounded-lg border">
        <div className="border-b px-4 py-2.5">
          <h2 id="my-agent-activity-heading" className="text-sm font-semibold">
            What just happened
          </h2>
        </div>
        {activity.error ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {activity.error instanceof Error ? activity.error.message : "Failed to load activity"}
          </p>
        ) : events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2"
              >
                <span className="text-sm text-muted-foreground">
                  {describeActivity(event, agent.name, viewerUserId)}
                </span>
                {event.createdAt ? (
                  <span className="text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Fold
        summary={
          machineConnected
            ? `This machine is connected — ${agent.name} can reach you here`
            : `Connect ${agent.name} to you — this machine, your harness, and messages`
        }
        tone={machineConnected ? "done" : "plain"}
      >
        <ConnectYourHarness
          agentId={agent.id}
          agentName={agent.name}
          companyId={selectedCompanyId!}
        />
        <ConnectYourMachine companyId={selectedCompanyId!} agentName={agent.name} />
        {/* Channels hang off the agent, so they only make sense once one is
            assigned — and the unassigned state deliberately offers no controls. */}
        {agentId && selectedCompanyId && <MyChannels companyId={selectedCompanyId} />}
        {agentId && selectedCompanyId && <HubspotConnectionPanel companyId={selectedCompanyId} />}
      </Fold>

      <Fold summary={`How ${agent.name} works — what it may do without asking`}>
        {governance.data ? (
          // On this page the viewer is, by construction, the agent's own
          // steward (getMyAgent returns only the caller's stewarded agent), so
          // they may edit the request. The server independently re-checks via
          // resolveConfigurationAuthority on every write.
          <StewardRequestEditor
            companyId={selectedCompanyId!}
            agentId={agent.id}
            policy={governance.data.policy}
            canEdit={!!myAgent.data?.stewardship}
          />
        ) : governance.error ? (
          <p className="text-sm text-destructive" role="alert">
            {governance.error instanceof Error
              ? governance.error.message
              : "Failed to load authority"}
          </p>
        ) : null}
        <AgentMandateEditor agentId={agent.id} companyId={selectedCompanyId!} />
      </Fold>
    </div>
  );
}
