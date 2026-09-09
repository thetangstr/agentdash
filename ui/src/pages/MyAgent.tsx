import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { activityApi } from "../api/activity";
import { agentGovernanceApi } from "../api/agent-governance";
import { issuesApi } from "../api/issues";
import { stewardshipsApi } from "../api/stewardships";
import { StewardRequestEditor } from "../components/agent/StewardRequestEditor";
import { AgentMandateEditor } from "../components/agent/AgentMandateEditor";
import { ConnectYourTerminal } from "../components/agent/ConnectYourTerminal";
import { DecisionsNeedingYou } from "../components/agent/DecisionsNeedingYou";
import { QuestionsForYou } from "../components/agent/QuestionsForYou";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { describeActivity } from "../lib/agent-activity-copy";
import { summarizeAgentTrouble, type AgentTrouble } from "../lib/agent-trouble";
import { describeAuthority } from "../lib/agent-authority-copy";
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

/**
 * `chief_of_staff` is a database value, not a job title a person reads.
 *
 * Naive title-casing gets two things wrong and both look careless on a page
 * about somebody's own agent: it writes the commonest role in this product as
 * "Ceo", and it capitalises the joining words, giving "Chief Of Staff". So
 * acronyms stay whole and small words stay small unless they lead.
 */
const ROLE_ACRONYMS = new Set(["ceo", "cto", "coo", "cfo", "cio", "cmo", "cpo", "hr", "it", "qa", "pm", "vp"]);
const ROLE_MINOR_WORDS = new Set(["of", "the", "and", "for", "to", "a", "an"]);

function humanRole(role: string | null | undefined): string {
  if (!role) return "no role set";
  return role
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ROLE_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (index > 0 && ROLE_MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * One sentence answering "do I need to do anything?" before any panel loads.
 *
 * `known` is not decoration. Every one of these counts came from
 * `query.data?.x ?? []`, which reads a failed request as an empty one — so with
 * the inbox and fact requests both returning 500 this sentence said "Nothing
 * needs you" while knowing nothing at all. An all-clear a steward cannot trust
 * is worse than no sentence, because they will stop reading the page.
 */
function statusSentence(
  name: string,
  work: { count: number; known: boolean },
  needs: { count: number; known: boolean },
): string {
  const doing = !work.known
    ? `${name} is here, but its work could not be loaded`
    : work.count === 0
      ? `${name} has nothing assigned`
      : `${name} is working on ${work.count} thing${work.count === 1 ? "" : "s"}`;
  if (!needs.known) return `${doing}. Whether anything needs you could not be checked.`;
  if (needs.count === 0) return `${doing}. Nothing needs you.`;
  return `${doing} and needs you on ${needs.count}.`;
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

/**
 * Why the agent stopped, said once, at the top.
 *
 * The complaint this answers, from a steward diagnosing his own agent: "HAL's
 * dashboard shows only the recovery-budget wrapper, and you have to click into
 * the run to find the cause. I nearly reported the wrong root cause off HAL's
 * dashboard alone."
 *
 * Two readers, one panel. The headline is a sentence anyone can act on; the
 * adapter's own words sit directly beneath it in monospace for whoever is going
 * to fix it. Neither is behind a click, because the click is what caused the
 * near-miss.
 */
function AgentTroublePanel({ trouble }: { trouble: AgentTrouble }) {
  const infra = trouble.kind === "infrastructure";
  return (
    <section
      aria-labelledby="my-agent-trouble-heading"
      role="alert"
      className={
        // A lost process is our fault, not the agent's, so it does not get the
        // colour reserved for "your agent is broken".
        infra
          ? "rounded-lg border border-border border-l-[3px] border-l-muted-foreground bg-muted/40 px-4 py-3.5"
          : "rounded-lg border border-destructive/40 border-l-[3px] border-l-destructive bg-destructive/5 px-4 py-3.5"
      }
    >
      <h2 id="my-agent-trouble-heading" className="text-sm font-semibold">
        {trouble.headline}
      </h2>

      {trouble.cause ? (
        <div
          className={
            infra
              ? "mt-2.5 overflow-x-auto rounded-md border border-border bg-background p-2.5"
              : "mt-2.5 overflow-x-auto rounded-md border border-destructive/30 bg-background p-2.5"
          }
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {/* Naming the source honestly. The adapter did not report a lost
                process — the platform inferred it. */}
            {infra ? "What the platform recorded" : "What the adapter reported"}
          </p>
          <p
            className={
              infra
                ? "mt-1 whitespace-nowrap font-mono text-sm font-medium text-foreground"
                : "mt-1 whitespace-nowrap font-mono text-sm font-medium text-destructive"
            }
          >
            {trouble.cause}
          </p>
          <p className="mt-1 whitespace-nowrap font-mono text-xs text-muted-foreground">
            {[trouble.code, trouble.at ? timeAgo(trouble.at) : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      ) : null}

      {infra ? (
        <p className="mt-2.5 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          Nothing is wrong with {"this agent's"} configuration and there is nothing here for you to
          fix. The server lost sight of the run when it restarted, which it records as a failure —
          but that is an inference rather than something it observed, and the work may even have
          finished. It will run again on its next trigger.
        </p>
      ) : null}

      {/* Naming the marker is the point. Left unexplained, the newest run reads
          as the diagnosis, and it is not one. */}
      {trouble.lookedPastRecoveryMarker ? (
        <p className="mt-2.5 border-l-2 border-destructive/30 pl-3 text-xs text-muted-foreground">
          Automatic recovery tried, gave up, and wrote its own entry on top of this one. That entry
          is newer, but it only records that a budget ran out —{" "}
          {trouble.cause
            ? "the error above is the reason. We read past it so you do not have to."
            : "and there is no earlier failure recorded to explain it."}
        </p>
      ) : null}
    </section>
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

  // Same key as QuestionsForYou, so this shares that request rather than
  // issuing a second one. Counted unfiltered, exactly as that panel renders
  // them — a count that disagreed with the list beneath it would be worse than
  // either number alone. The route returns open rows only.
  const factRequests = useQuery({
    queryKey: ["me", "fact-requests", selectedCompanyId ?? ""],
    queryFn: () => stewardshipsApi.myFactRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  /**
   * Recent runs, purely so this page can say WHY an agent stopped.
   *
   * `GET /me/agent` returns `status: "error"` and nothing else, which is how a
   * steward diagnosing his own stopped agent ended up reading the recovery
   * wrapper as the cause: "HAL's dashboard shows only the recovery-budget
   * wrapper, and you have to click into the run to find the cause. I nearly
   * reported the wrong root cause off HAL's dashboard alone." Five is enough to
   * see past a recovery marker to the failure underneath it.
   */
  const recentRuns = useQuery({
    queryKey: ["me", "agent-runs", selectedCompanyId ?? "", agentId ?? ""],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, agentId!, 5),
    enabled: !!selectedCompanyId && !!agentId && isProfileCompany,
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
  // Both kinds of blocking count: an approval is a decision to permit an
  // action, a fact request is a question only this person can answer. To a
  // steward reading one sentence, both are simply something that needs them.
  const questionCount = (factRequests.data?.factRequests ?? []).length;
  const needsCount = items.length + questionCount;
  // Either failure makes the total unknowable, so neither may be reported as
  // zero. `myAgent` has its own error branch above; these did not.
  const needsKnown = !inbox.error && !factRequests.error;
  const workKnown = !currentWork.error;
  // getMyAgent returns only the caller's own stewardship, so its userId is the
  // viewer — which is what lets the activity feed say "You" truthfully.
  const viewerUserId = myAgent.data?.stewardship?.userId ?? null;
  // `enrolledAt` is null until an enrolment is approved, so a pending request
  // is deliberately not "connected" — the fold would otherwise claim a machine
  // could reach you before it can.
  const authorityLines = describeAuthority(governance.data?.policy?.effectivePolicy);
  // Null unless the newest run failed, so a working agent shows nothing.
  const trouble = summarizeAgentTrouble((recentRuns.data ?? []) as never, agent.name);

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
          {/* A stopped agent is not "working on 3 things". The old sentence
              counted assigned issues and never looked at whether the agent was
              running, so HAL's page read "HAL is working on 3 things" while HAL
              had been dead for two hours. */}
          {trouble
            ? trouble.headline
            : statusSentence(
                agent.name,
                { count: work.length, known: workKnown },
                { count: needsCount, known: needsKnown },
              )}
        </p>
        <p className="text-xs text-muted-foreground">
          {agent.name} · {humanRole(agent.role)} · {agent.status}
        </p>
        {needsKnown ? null : (
          <p className="text-xs text-destructive" role="alert">
            {(inbox.error instanceof Error ? inbox.error.message : null) ??
              (factRequests.error instanceof Error ? factRequests.error.message : null) ??
              "Could not load what is waiting on you."}{" "}
            Reload to try again.
          </p>
        )}
      </header>

      {trouble ? <AgentTroublePanel trouble={trouble} /> : null}

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

      {/* Connecting is the point of this page for a first-time steward, so it
          is a visible section rather than a disclosure — and it lives here
          rather than on a page of its own. */}
      <ConnectYourTerminal
        agentId={agent.id}
        agentName={agent.name}
        companyId={selectedCompanyId!}
      />

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

      {/* What the agent may do, in sentences. The mandate file and the request
          editor are the instruments for changing it; this is the answer to
          "what is it allowed to do", which is what a steward actually asks. */}
      <section aria-labelledby="my-agent-authority-heading" className="rounded-lg border">
        <div className="border-b px-4 py-2.5">
          <h2 id="my-agent-authority-heading" className="text-sm font-semibold">
            What {agent.name} may do
          </h2>
        </div>
        {governance.error ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {governance.error instanceof Error
              ? governance.error.message
              : "Could not load what this agent is allowed to do."}{" "}
            This is not the same as it having no limits.
          </p>
        ) : authorityLines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {governance.isLoading ? "Loading…" : "No limits have been recorded yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 px-4 py-3 text-sm text-muted-foreground">
            {authorityLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <Fold summary={`Change what ${agent.name} may do, or edit its mandate`}>
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
        ) : null}
        <AgentMandateEditor agentId={agent.id} companyId={selectedCompanyId!} />
      </Fold>

    </div>
  );
}
