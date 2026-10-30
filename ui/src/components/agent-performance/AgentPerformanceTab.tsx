import { useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentAccountableParty,
  AgentCardSnapshotResponse,
  AgentCardView,
  AgentPerformanceProjection,
  AgentProjectionAccountableResult,
  AgentProjectionCount,
  AgentProjectionRoutineObligation,
} from "@paperclipai/shared";
import {
  AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS,
  agentPerformanceApi,
  agentPerformanceQueryKeys,
} from "@/api/agent-performance";
import { accessApi } from "@/api/access";
import { performanceManagerApi, performanceManagerQueryKeys } from "@/api/performance-manager";
import { authApi } from "@/api/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatDateTime } from "@/lib/utils";
import { AgentCardDisplay } from "./AgentCardDisplay";
import type { AgentCardViewer } from "./AgentCaseDrilldown";
import { AgentRecommendationsSection, ManagerProposalsSection, ManagerRoleBanner } from "./AgentRecommendations";
import { COMPUTED_NOT_SAVED_TEXT, NO_STORED_CARD_TEXT } from "./card-shared";
import { refusalText } from "./profile-shared";
import {
  Banner,
  CountValue,
  EmptyNote,
  Fact,
  FactList,
  GapList,
  Section,
  ViewStatus,
  formatWindow,
  refusalCodeText,
  sortedRefusalCodes,
} from "./shared";

// AgentDash: Agent Performance Management gate 1 — the Performance tab. Six
// blocks, one per question the person responsible for the agent asks
// (overview LLD §1), each with its counts and what they are out of. There is
// no gauge, score or ranking. Unknown counts say "Unknown" and why, never 0.
// Gate 1 reads today's tables, so routine obligations use the current
// definitions and their history is unknown.

export const PERFORMANCE_QUESTIONS = {
  owed: "Is the work it owes getting done?",
  quality: "Is the work good?",
  acceptance: "Is it accepted, used, and moving the result?",
  cost: "What does it cost?",
  bounds: "Is it staying inside its boundaries?",
  decisions: "What needs my decision?",
} as const;

export const NO_OBSERVED_CASES_TEXT = "No observed cases yet";
export const CURRENT_DEFINITIONS_LABEL = "Current definitions; history unknown";
export const SPEND_NOT_VISIBLE_TEXT = "Not visible to you";

function count(value: number, of?: number | null): AgentProjectionCount {
  return { value, of: of ?? null };
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, n) => total + n, 0);
}

function CountFact({ label, value, unit }: { label: string; value: AgentProjectionCount; unit?: string }) {
  return (
    <Fact label={label}>
      <CountValue count={value} unit={unit} />
    </Fact>
  );
}

function owedCount(obligation: AgentProjectionRoutineObligation): AgentProjectionCount {
  // The server's note says why the count is unknown, or what a known count
  // assumes; the wording below is only a fallback for an older server.
  if (obligation.owedInWindow !== null) return { value: obligation.owedInWindow, note: obligation.note ?? null };
  if (obligation.note) return { value: null, note: obligation.note };
  let note = "Not computed";
  if (obligation.triggerId === null) note = "This routine has no trigger";
  else if (!obligation.enabled) note = "The trigger is disabled";
  else if (obligation.triggerKind && obligation.triggerKind !== "schedule") {
    note = `A ${obligation.triggerKind} trigger has no schedule to count from`;
  }
  return { value: null, note };
}

function RoutineObligation({ obligation }: { obligation: AgentProjectionRoutineObligation }) {
  const { runs, linkedIssues } = obligation;
  const linkedTotal = linkedIssues.done + linkedIssues.open + linkedIssues.cancelled;
  return (
    <li className="space-y-2 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-performance-routine">
      <div>
        <p className="font-medium text-text-primary">{obligation.title}</p>
        <p className="text-text-secondary">
          {obligation.triggerKind ?? "No trigger"}
          {obligation.cronExpression ? (
            <>
              {" "}
              <code className="font-mono text-xs">{obligation.cronExpression}</code>
            </>
          ) : null}
          {obligation.timezone ? ` (${obligation.timezone})` : ""}
          {obligation.triggerId ? ` · ${obligation.enabled ? "enabled" : "disabled"}` : ""}
        </p>
      </div>
      <FactList>
        <CountFact label="Owed in window" value={owedCount(obligation)} unit="runs" />
        <CountFact label="Runs started" value={count(runs.total)} />
        <CountFact label="Completed" value={count(runs.completed, runs.total)} />
        <CountFact label="Failed" value={count(runs.failed, runs.total)} />
        <CountFact label="Skipped" value={count(runs.skipped, runs.total)} />
        <CountFact label="Merged into another run" value={count(runs.coalesced, runs.total)} />
        <CountFact label="Created an issue" value={count(runs.issueCreated, runs.total)} />
        <CountFact label="Linked issues done" value={count(linkedIssues.done, linkedTotal)} />
        <CountFact label="Linked issues open" value={count(linkedIssues.open, linkedTotal)} />
        <CountFact label="Linked issues cancelled" value={count(linkedIssues.cancelled, linkedTotal)} />
      </FactList>
    </li>
  );
}

function OwedBlock({ owed }: { owed: AgentPerformanceProjection["owed"] }) {
  const assignedTotal = sum(owed.assigned);
  const empty = owed.routines.length === 0 && assignedTotal === 0;
  return (
    <Section
      id="agent-performance-owed"
      title={PERFORMANCE_QUESTIONS.owed}
      description="Routines it runs and issues assigned to it. Routine counts use today's schedules."
    >
      {empty ? (
        <EmptyNote>{NO_OBSERVED_CASES_TEXT}.</EmptyNote>
      ) : (
        <>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-text-primary">Routines</h4>
            {owed.routines.length === 0 ? (
              <EmptyNote>No routines are assigned to this agent.</EmptyNote>
            ) : (
              <ul className="space-y-2">
                {owed.routines.map((obligation) => (
                  <RoutineObligation key={`${obligation.routineId}-${obligation.triggerId ?? "none"}`} obligation={obligation} />
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-text-primary">Issues assigned to it now</h4>
            <FactList>
              <CountFact label="Open" value={count(owed.assigned.open, assignedTotal)} />
              <CountFact label="In progress" value={count(owed.assigned.inProgress, assignedTotal)} />
              <CountFact label="In review" value={count(owed.assigned.inReview, assignedTotal)} />
              <CountFact label="Blocked" value={count(owed.assigned.blocked, assignedTotal)} />
              <CountFact label="Done" value={count(owed.assigned.done, assignedTotal)} />
              <CountFact label="Cancelled" value={count(owed.assigned.cancelled, assignedTotal)} />
            </FactList>
          </div>
        </>
      )}
    </Section>
  );
}

function QualityBlock({ quality }: { quality: AgentPerformanceProjection["quality"] }) {
  const total = sum(quality.verdicts);
  const judged = sum(quality.byJudge);
  return (
    <Section
      id="agent-performance-quality"
      title={PERFORMANCE_QUESTIONS.quality}
      description="Verdicts in the window on issues assigned to this agent now, and who gave them."
    >
      {total === 0 && judged === 0 ? (
        <EmptyNote>{NO_OBSERVED_CASES_TEXT}.</EmptyNote>
      ) : (
        <>
          <FactList>
            <CountFact label="Passed" value={count(quality.verdicts.passed, total)} />
            <CountFact label="Failed" value={count(quality.verdicts.failed, total)} />
            <CountFact label="Changes requested" value={count(quality.verdicts.changesRequested, total)} />
            <CountFact label="Escalated" value={count(quality.verdicts.escalated, total)} />
            <CountFact label="Other" value={count(quality.verdicts.other, total)} />
          </FactList>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-text-primary">Who judged</h4>
            <FactList>
              <CountFact label="A person" value={count(quality.byJudge.person, judged)} />
              <CountFact label="An independent agent" value={count(quality.byJudge.independentAgent, judged)} />
              <CountFact label="Not independent (the agent itself)" value={count(quality.byJudge.nonIndependent, judged)} />
            </FactList>
          </div>
        </>
      )}
    </Section>
  );
}

function AccountableResult({ result }: { result: AgentProjectionAccountableResult }) {
  return (
    <li className="space-y-2 rounded-md border border-border-soft px-3 py-2 text-sm">
      <p className="font-medium text-text-primary">
        {result.kind === "project" ? "Project" : "Goal"}: {result.title}
        <span className="font-normal text-text-secondary"> · status: {result.status ?? "Unknown"}</span>
      </p>
      {result.outcome ? (
        <FactList>
          <CountFact label="Acceptance" value={result.outcome.acceptance} />
          <CountFact label="On time" value={result.outcome.onTime} />
          <CountFact label="Rework" value={result.outcome.rework} />
          <CountFact label="Evidence" value={result.outcome.evidence} />
        </FactList>
      ) : (
        <p className="text-text-secondary">
          <span className="font-medium text-text-primary">Outcome: Unknown</span>
          {result.note ? ` — ${result.note}` : null}
        </p>
      )}
      {result.outcome && result.note ? <p className="text-text-secondary">{result.note}</p> : null}
    </li>
  );
}

function AcceptanceBlock({ acceptance }: { acceptance: AgentPerformanceProjection["acceptance"] }) {
  return (
    <Section
      id="agent-performance-acceptance"
      title={PERFORMANCE_QUESTIONS.acceptance}
      description="Four separate facts. One does not stand in for another."
    >
      <FactList>
        <CountFact label="Passed by an independent agent" value={acceptance.automated} />
        <CountFact label="Accepted by a person" value={acceptance.human} />
        <CountFact label="Used" value={acceptance.use} />
        <CountFact label="Moved the result" value={acceptance.outcome} />
      </FactList>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-text-primary">Projects it leads and goals it owns</h4>
        {acceptance.accountable.length === 0 ? (
          <EmptyNote>It leads no projects and owns no goals.</EmptyNote>
        ) : (
          <ul className="space-y-2">
            {acceptance.accountable.map((result) => (
              <AccountableResult key={`${result.kind}-${result.id}`} result={result} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function CostBlock({ cost }: { cost: AgentPerformanceProjection["cost"] }) {
  const { runs, peopleProxies } = cost;
  const correctionsUnknown = peopleProxies.humanCorrections.value === null;
  // Null spend = this viewer may not see spend (a `withheld` entry says so). Never shown as $0.
  const spendHidden = cost.spendCents === null;
  const spendFact = (
    <Fact label="Spend">
      {cost.spendCents === null ? (
        <span className="text-text-secondary">{SPEND_NOT_VISIBLE_TEXT}</span>
      ) : (
        <span className="font-medium tabular-nums">{formatCents(cost.spendCents)}</span>
      )}
    </Fact>
  );
  const empty =
    (spendHidden || cost.spendCents === 0) &&
    runs.total === 0 &&
    peopleProxies.questionsAsked === 0 &&
    (correctionsUnknown || peopleProxies.humanCorrections.value === 0);
  return (
    <Section
      id="agent-performance-cost"
      title={PERFORMANCE_QUESTIONS.cost}
      description="Agent spend in the window, and proxies for people's time. Proxies are labelled; they are not hours."
    >
      {empty ? (
        <>
          <EmptyNote>{NO_OBSERVED_CASES_TEXT}.</EmptyNote>
          {spendHidden || correctionsUnknown ? (
            <FactList>
              {spendHidden ? spendFact : null}
              {correctionsUnknown ? (
                <CountFact label="Corrections by people" value={peopleProxies.humanCorrections} />
              ) : null}
            </FactList>
          ) : null}
        </>
      ) : (
        <>
          <FactList>
            {spendFact}
            <CountFact label="Runs" value={count(runs.total)} />
            <CountFact label="Runs succeeded" value={count(runs.succeeded, runs.total)} />
            <CountFact label="Runs failed" value={count(runs.failed, runs.total)} />
            <CountFact label="Runs with no issue" value={count(runs.withoutIssue, runs.total)} />
          </FactList>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-text-primary">People's time (proxies)</h4>
            <FactList>
              <CountFact label="Questions it asked people" value={count(peopleProxies.questionsAsked)} />
              <CountFact
                label="Questions answered"
                value={count(peopleProxies.questionsAnswered, peopleProxies.questionsAsked)}
              />
              <CountFact
                label="Median wait for an answer"
                value={
                  peopleProxies.medianAnswerWaitMinutes === null
                    ? { value: null, note: "No answered questions in this window" }
                    : { value: peopleProxies.medianAnswerWaitMinutes }
                }
                unit={peopleProxies.medianAnswerWaitMinutes === null ? undefined : "minutes"}
              />
              <CountFact label="Corrections by people" value={peopleProxies.humanCorrections} />
            </FactList>
          </div>
        </>
      )}
    </Section>
  );
}

function BoundsBlock({ bounds }: { bounds: AgentPerformanceProjection["bounds"] }) {
  const codes = sortedRefusalCodes(bounds.byCode);
  return (
    <Section
      id="agent-performance-bounds"
      title={PERFORMANCE_QUESTIONS.bounds}
      description="Refused attempts in the window. A refused attempt is an attempt, not misconduct."
    >
      {bounds.refusedAttempts === 0 && codes.length === 0 ? (
        <EmptyNote>{NO_OBSERVED_CASES_TEXT}: no refused attempts recorded in this window.</EmptyNote>
      ) : (
        <FactList>
          <CountFact label="Refused attempts" value={count(bounds.refusedAttempts)} />
          {codes.map(([code, n]) => (
            <Fact key={code} label={refusalCodeText(code)}>
              <CountValue count={count(n, bounds.refusedAttempts)} />
            </Fact>
          ))}
        </FactList>
      )}
    </Section>
  );
}

function DecisionsBlock({ decisions }: { decisions: AgentPerformanceProjection["decisions"] }) {
  return (
    <Section
      id="agent-performance-decisions"
      title={PERFORMANCE_QUESTIONS.decisions}
      description="Waiting on a person right now."
    >
      {decisions.pendingApprovals === 0 && decisions.openQuestionsToPeople === 0 ? (
        <EmptyNote>Nothing from this agent is waiting for a decision.</EmptyNote>
      ) : (
        <FactList>
          <CountFact label="Approvals it requested, pending" value={count(decisions.pendingApprovals)} />
          <CountFact label="Questions to people, unanswered" value={count(decisions.openQuestionsToPeople)} />
        </FactList>
      )}
    </Section>
  );
}

export function AgentPerformanceView({ projection }: { projection: AgentPerformanceProjection }) {
  const historyUnknown = projection.owed.source === "current_definitions" && !projection.owed.historyKnown;
  return (
    <div className="max-w-4xl space-y-8" data-testid="agent-performance-tab">
      <div className="space-y-2 text-sm text-text-secondary" data-testid="agent-performance-window">
        <p>
          <span className="text-text-primary">Window:</span> {formatWindow(projection.window)}
        </p>
        <p>
          <span className="text-text-primary">As of:</span> {formatDateTime(projection.asOf)}
          {" · "}
          {projection.throughSeq === null
            ? "The evaluator ledger has no events for this company."
            : `Evaluator ledger read through event ${projection.throughSeq}.`}
        </p>
        {historyUnknown ? <Badge variant="secondary">{CURRENT_DEFINITIONS_LABEL}</Badge> : null}
      </div>

      <OwedBlock owed={projection.owed} />
      <QualityBlock quality={projection.quality} />
      <AcceptanceBlock acceptance={projection.acceptance} />
      <CostBlock cost={projection.cost} />
      <BoundsBlock bounds={projection.bounds} />
      <DecisionsBlock decisions={projection.decisions} />

      <Section id="agent-performance-withheld" title="Not shown here">
        {projection.withheld.length === 0 ? (
          <EmptyNote>Every section is shown.</EmptyNote>
        ) : (
          <ul className="space-y-1 text-sm">
            {projection.withheld.map((item) => (
              <li key={item.section}>
                <span className="text-text-primary">{item.section}</span>
                <span className="text-text-secondary"> — {item.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <GapList id="agent-performance-gaps" gaps={projection.gaps} />
    </div>
  );
}


// ---------------------------------------------------------------------------
// Gate 3 (P3.5): the stored agent card, "Compute now" and snapshots
// ---------------------------------------------------------------------------

export const COMPUTE_NOW_LABEL = "Compute now";
export const SNAPSHOT_LABEL = "Take snapshot";

/**
 * Who is looking (their user id, for "You") and names for people the card
 * mentions. What they may do is not inferred here: it comes from the card's
 * `viewer` flags, which the server computes from the guards its routes apply.
 */
export function useAgentCardViewer(
  companyId: string,
  accountable: AgentAccountableParty | null | undefined,
): AgentCardViewer & { personName: (userId: string) => string } {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const members = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    retry: false,
    enabled: !!companyId,
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const names = new Map<string, string>();
  for (const member of members.data?.members ?? []) {
    const name = member.user?.name ?? member.user?.email ?? null;
    if (name) names.set(member.principalId, name);
  }
  if (accountable?.userId) names.set(accountable.userId, accountable.name ?? accountable.email ?? accountable.userId);
  return {
    userId,
    personName: (id: string) => (id === userId ? "You" : (names.get(id) ?? `Person ${id.slice(0, 8)}`)),
  };
}

function snapshotMessage(result: Pick<AgentCardSnapshotResponse, "snapshot" | "verify">): string {
  const stored = result.snapshot.reused
    ? `No new records since version ${result.snapshot.version}, so that version was kept.`
    : `Stored as version ${result.snapshot.version}.`;
  const verify = result.verify;
  if (!verify) return stored;
  if (verify.ok) return `${stored} Replaying it gave the same card.`;
  return `${stored} Replaying it did not give the same card (${"reason" in verify ? verify.reason : verify.status}).`;
}

/** The gate 1 view, read when no card is stored yet. Its own readers rule (admins, accountable person, steward). */
function ProjectionFallback({ companyId, agentId, windowDays }: { companyId: string; agentId: string; windowDays: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: agentPerformanceQueryKeys.projection(companyId, agentId, windowDays),
    queryFn: () => agentPerformanceApi.projection(companyId, agentId, windowDays),
    retry: false,
  });
  if (!data) return <ViewStatus what="performance" isLoading={isLoading} error={error} restricted />;
  return <AgentPerformanceView projection={data} />;
}

export function AgentPerformanceTab({
  companyId,
  agentId,
  accountable = null,
  windowDays = AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS,
}: {
  companyId: string;
  agentId: string;
  /** The accountable party the agent page already resolved. */
  accountable?: AgentAccountableParty | null;
  windowDays?: number;
}) {
  const queryClient = useQueryClient();
  const versionSelectId = useId();
  /** Null = the latest stored version. */
  const [version, setVersion] = useState<number | null>(null);
  /** 0 = showing the stored card; otherwise the "Compute now" request in view. */
  const [computeNonce, setComputeNonce] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // AgentDash (APM gate 4): who the company's performance manager is, for its recommendations and its own page.
  const managerView = useQuery({
    queryKey: performanceManagerQueryKeys.designation(companyId),
    queryFn: () => performanceManagerApi.get(companyId),
    retry: false,
  });

  const latest = useQuery({
    queryKey: agentPerformanceQueryKeys.card(companyId, agentId, null),
    queryFn: () => agentPerformanceApi.card(companyId, agentId, null),
    retry: false,
  });
  const selected = useQuery({
    queryKey: agentPerformanceQueryKeys.card(companyId, agentId, version),
    queryFn: () => agentPerformanceApi.card(companyId, agentId, version),
    retry: false,
    enabled: version !== null,
  });
  const computed = useQuery({
    queryKey: agentPerformanceQueryKeys.compute(companyId, agentId, windowDays, computeNonce),
    queryFn: () => agentPerformanceApi.compute(companyId, agentId, windowDays),
    retry: false,
    enabled: computeNonce > 0,
  });

  const latestCard: AgentCardView | null = latest.data?.card ?? null;
  const shownStored: AgentCardView | null = version === null ? latestCard : (selected.data?.card ?? null);
  const viewer = useAgentCardViewer(companyId, accountable);
  // the server's flags (present even when no card is stored yet), never a guess from roles
  const maySnapshot = latest.data?.viewer?.canSnapshot ?? false;
  const latestVersion = latestCard?.stored?.version ?? null;
  const showingCompute = computeNonce > 0;
  // the stored versions, from the server (only read once there is more than one to pick from)
  const versions = useQuery({
    queryKey: agentPerformanceQueryKeys.versions(companyId, agentId),
    queryFn: () => agentPerformanceApi.versions(companyId, agentId),
    retry: false,
    enabled: latestVersion !== null && latestVersion > 1,
  });
  const versionList = versions.data?.versions ?? [];

  const snapshot = useMutation({
    mutationFn: () => agentPerformanceApi.snapshot(companyId, agentId, windowDays),
    onSuccess: (result) => {
      setProblem(null);
      setAnnouncement(snapshotMessage(result));
      setVersion(null);
      setComputeNonce(0);
      void queryClient.invalidateQueries({ queryKey: agentPerformanceQueryKeys.cardAll(companyId, agentId) });
      void queryClient.invalidateQueries({ queryKey: agentPerformanceQueryKeys.cards(companyId) });
    },
    onError: (error) => {
      setAnnouncement("");
      setProblem(refusalText("take a snapshot", error));
    },
  });

  /** A recommendation cites a stored card version: show that version here. */
  function showCardVersion(cited: number) {
    setComputeNonce(0);
    setVersion(cited === latestVersion ? null : cited);
    setProblem(null);
    setAnnouncement(`Showing card version ${cited}, cited by a recommendation.`);
    statusRef.current?.focus();
  }

  const status = showingCompute
    ? COMPUTED_NOT_SAVED_TEXT
    : shownStored?.stored
      ? `Stored card, version ${shownStored.stored.version}${shownStored.stored.version === latestVersion ? " (latest)" : ""}, saved ${formatDateTime(shownStored.stored.storedAt)}`
      : latest.isLoading
        ? "Loading the stored card…"
        : latestCard === null && !latest.error
          ? NO_STORED_CARD_TEXT
          : "";

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3" data-testid="agent-card-toolbar">
      <p ref={statusRef} tabIndex={-1} className="text-sm font-medium text-text-primary focus-visible:outline-none" data-testid="agent-card-status">
        {status}
      </p>
      {!showingCompute && versionList.length > 1 ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={versionSelectId} className="text-text-secondary">
            Version
          </label>
          <select
            id={versionSelectId}
            value={version ?? latestVersion ?? versionList[0]!.version}
            onChange={(event) => {
              const next = Number(event.target.value);
              setVersion(next === latestVersion ? null : next);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            data-testid="agent-card-version"
          >
            {versionList.map((v) => (
              <option key={v.version} value={v.version}>
                {`${v.version}${v.version === latestVersion ? " (latest)" : ""} · as of ${formatDateTime(v.asOf)}`}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {showingCompute ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setComputeNonce(0)}>
          {latestCard ? "Back to the stored card" : "Hide the computed card"}
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="outline" disabled={computed.isFetching} onClick={() => setComputeNonce((n) => n + 1)}>
        {computed.isFetching ? "Computing…" : showingCompute ? "Compute again" : COMPUTE_NOW_LABEL}
      </Button>
      {maySnapshot ? (
        <Button type="button" size="sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
          {snapshot.isPending ? "Storing…" : SNAPSHOT_LABEL}
        </Button>
      ) : null}
    </div>
  );

  let body: ReactNode = null;
  if (showingCompute) {
    body = computed.data ? (
      <>
        <Banner>
          <p data-testid="agent-card-compute-note">
            {COMPUTED_NOT_SAVED_TEXT}. This card reflects the records as they are now. Nothing was stored, no findings were added and no review
            items were created.
          </p>
        </Banner>
        <AgentCardDisplay view={computed.data.card} companyId={companyId} agentId={agentId} viewer={viewer} drillable={false} personName={viewer.personName} />
      </>
    ) : (
      <ViewStatus what="computed card" isLoading={computed.isLoading || computed.isFetching} error={computed.error} />
    );
  } else if (latest.error) {
    body = <ViewStatus what="performance card" isLoading={false} error={latest.error} />;
  } else if (latest.isLoading) {
    body = <ViewStatus what="performance" isLoading error={null} />;
  } else if (latestCard === null) {
    body = (
      <>
        <Banner>
          <p data-testid="agent-card-none">
            {NO_STORED_CARD_TEXT}. {maySnapshot ? `${SNAPSHOT_LABEL} stores one. ` : "The agent's accountable person or a company admin can store one. "}
            {COMPUTE_NOW_LABEL} shows the card for the records as they are now without saving it. Below is what today's records show.
          </p>
        </Banner>
        <ProjectionFallback companyId={companyId} agentId={agentId} windowDays={windowDays} />
      </>
    );
  } else if (version !== null && !shownStored) {
    body = <ViewStatus what={`card version ${version}`} isLoading={selected.isLoading} error={selected.error ?? (selected.isFetched ? new Error("No stored card with that version.") : null)} />;
  } else if (shownStored) {
    body = <AgentCardDisplay view={shownStored} companyId={companyId} agentId={agentId} viewer={viewer} drillable personName={viewer.personName} />;
  }

  return (
    <div className="max-w-4xl space-y-6" data-testid="agent-performance-card-tab">
      <ManagerRoleBanner agentId={agentId} managerView={managerView.data ?? null} />
      {toolbar}
      <p role="status" aria-live="polite" className={announcement ? "text-sm text-text-primary" : "sr-only"} data-testid="agent-card-announcement">
        {announcement}
      </p>
      {problem ? (
        <p role="alert" className="text-sm text-destructive" data-testid="agent-card-problem">
          {problem}
        </p>
      ) : null}
      {body}
      {/* AgentDash (APM gate 4): advisory recommendations and the manager's proposals, for every company (one UX). */}
      <AgentRecommendationsSection
        companyId={companyId}
        agentId={agentId}
        managerView={managerView.data ?? null}
        personName={viewer.personName}
        onShowCardVersion={showCardVersion}
      />
      <ManagerProposalsSection companyId={companyId} agentId={agentId} />
    </div>
  );
}
