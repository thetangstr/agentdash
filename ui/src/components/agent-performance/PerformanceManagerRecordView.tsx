import { useQuery } from "@tanstack/react-query";
import {
  AGENT_RECOMMENDATION_KINDS,
  type AgentObligationEndState,
  type PerformanceManagerAppliedItem,
  type PerformanceManagerProposalItem,
  type PerformanceManagerRecommendationItem,
  type PerformanceManagerRecord,
  type PerformanceManagerSectionSnapshot,
} from "@paperclipai/shared";
import { performanceManagerApi, performanceManagerQueryKeys } from "@/api/performance-manager";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { END_STATE_TEXT, JUDGE_TEXT, NOT_VISIBLE_TEXT } from "./card-shared";
import {
  PERFORMANCE_MANAGER_ADVISORY_TEXT,
  PROPOSAL_OUTCOME_TEXT,
  RECOMMENDATION_KIND_SHORT_TEXT,
} from "./manager-shared";
import { Banner, CountValue, EmptyNote, Fact, FactList, Section, ViewStatus } from "./shared";

// AgentDash: Agent Performance Management gate 4 (P4.2) — the performance
// manager's own record (`GET evaluation/performance-manager/record?agentId=`),
// reached from the manager agent's page. What it proposed and what became of
// each proposal (filed, waiting, approved, rejected, withdrawn, edited by a
// person before the decision, applied), its recommendations (each one, newest
// first, and tallied by kind with their decisions), and — for each applied
// proposal — the affected
// responsibilities' card sections from the last stored card before it was
// applied and the first after. All descriptive: no causal claim, no score,
// no ranking, and unknown is "Unknown", never 0.

export const RECORD_DESCRIPTIVE_TEXT =
  "These are the records as stored. A difference between the card before and after a change does not show that the change caused it.";

const SECTION_PARTIAL_TEXT = "Partly visible to you";

function linkClass() {
  return "text-accent-500 underline-offset-4 hover:underline";
}

function n(value: number | null | undefined, of?: number | null, unit?: string) {
  return <CountValue count={{ value: value ?? null, of: of ?? null, note: value == null ? "Not recorded" : null }} unit={unit} />;
}

function ProposalItem({ item }: { item: PerformanceManagerProposalItem }) {
  return (
    <li className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="pm-record-proposal">
      <p className="text-text-primary">
        <Link className={linkClass()} to={`/agents/${item.agentId}/profile`}>
          {item.agentName ?? `Agent ${item.agentId.slice(0, 8)}`}
        </Link>
        <span> · Revision {item.revisionNumber || "Unknown"}</span>
        <span className="font-medium"> · {PROPOSAL_OUTCOME_TEXT[item.outcome] ?? item.outcome}</span>
      </p>
      <p className="text-xs text-text-secondary">
        Filed {formatDateTime(item.filedAt)}
        {item.decidedAt ? ` · decided ${formatDateTime(item.decidedAt)}` : " · no decision yet"}
      </p>
      {item.editedByOwnerBeforeDeciding ? (
        <p className="text-text-secondary" data-testid="pm-record-proposal-edited">
          A person edited the draft before it was decided, so the decision was on their version.
        </p>
      ) : null}
      {item.affectedResponsibilities.length > 0 ? (
        <p className="text-text-secondary">
          Responsibilities affected: <span className="font-mono text-xs">{item.affectedResponsibilities.join(", ")}</span>
        </p>
      ) : null}
      <p>
        <Link className={linkClass()} to={`/approvals/${item.approvalId}`}>
          Open the approval
        </Link>
      </p>
    </li>
  );
}

function RecommendationItem({ item }: { item: PerformanceManagerRecommendationItem }) {
  const decision =
    item.decision === "accepted" ? "Accepted" : item.decision === "declined" ? "Declined" : "No decision yet";
  return (
    <li className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="pm-record-recommendation">
      <p className="text-text-primary">
        <Link className={linkClass()} to={`/agents/${item.agentId}/performance`}>
          {item.agentName ?? `Agent ${item.agentId.slice(0, 8)}`}
        </Link>
        <span> · {RECOMMENDATION_KIND_SHORT_TEXT[item.kind] ?? item.kind}</span>
        <span className="font-medium" data-testid="pm-record-recommendation-decision">
          {" "}
          · {decision}
        </span>
      </p>
      <p className="text-xs text-text-secondary">
        Filed {formatDateTime(item.at)}
        {item.decidedAt ? ` · decided ${formatDateTime(item.decidedAt)}` : ""}
      </p>
    </li>
  );
}

function endStateLine(byEndState: Record<string, number>): string {
  const entries = Object.entries(byEndState).filter(([, count]) => count > 0);
  if (entries.length === 0) return "No end states recorded";
  return entries
    .map(([state, count]) => `${END_STATE_TEXT[state as AgentObligationEndState] ?? state}: ${count}`)
    .join(" · ");
}

function judgeLine(byJudge: Record<string, { pass: number; fail: number; unknown: number }>): string {
  const entries = Object.entries(byJudge);
  if (entries.length === 0) return "No judgments recorded";
  return entries
    .map(([judge, t]) => `${JUDGE_TEXT[judge as keyof typeof JUDGE_TEXT] ?? judge}: ${t.pass} passed, ${t.fail} failed, ${t.unknown} unknown`)
    .join(" · ");
}

function visibilityNote(visibility: "visible" | "partial") {
  return visibility === "partial" ? <p className="text-xs text-text-secondary">{SECTION_PARTIAL_TEXT}.</p> : null;
}

/** One responsibility's sections at one stored card version. */
function SectionSnapshot({ snapshot, emptyText }: { snapshot: PerformanceManagerSectionSnapshot | null; emptyText: string }) {
  if (!snapshot) return <EmptyNote>{emptyText}</EmptyNote>;
  const { obligations, quality, delivered } = snapshot;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-text-secondary">
        Card version {snapshot.cardVersion}, stored {formatDateTime(snapshot.storedAt)}
      </p>
      <div className="space-y-1">
        <p className="font-medium text-text-primary">Work owed</p>
        {obligations.visibility === "not_visible" ? (
          <p className="text-text-secondary">
            {NOT_VISIBLE_TEXT}
            {obligations.note ? ` — ${obligations.note}` : ""}
          </p>
        ) : (
          <>
            {visibilityNote(obligations.visibility)}
            {obligations.rows.length === 0 ? (
              <p className="text-text-secondary">No obligations recorded.</p>
            ) : (
              <ul className="space-y-1">
                {obligations.rows.map((row, index) => (
                  <li key={`${row.profileRevisionId ?? "none"}-${index}`} className="text-text-secondary">
                    <span className="text-text-primary">Owed:</span> {n(row.owed)} · <span className="text-text-primary">Items delivered:</span>{" "}
                    {n(row.deliveredItemCount)}
                    <span className="block">{endStateLine(row.byEndState)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="space-y-1">
        <p className="font-medium text-text-primary">Quality checks</p>
        {quality.visibility === "not_visible" ? (
          <p className="text-text-secondary">
            {NOT_VISIBLE_TEXT}
            {quality.note ? ` — ${quality.note}` : ""}
          </p>
        ) : (
          <>
            {visibilityNote(quality.visibility)}
            {quality.criteria.length === 0 ? (
              <p className="text-text-secondary">No criteria recorded.</p>
            ) : (
              <ul className="space-y-1">
                {quality.criteria.map((criterion) => (
                  <li key={criterion.criterionId} className="text-text-secondary">
                    <span className="text-text-primary">{criterion.text || criterion.criterionId}</span> — {criterion.items} item
                    {criterion.items === 1 ? "" : "s"}
                    <span className="block">{judgeLine(criterion.byJudge)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="space-y-1">
        <p className="font-medium text-text-primary">Delivered</p>
        {delivered.visibility === "not_visible" ? (
          <p className="text-text-secondary">
            {NOT_VISIBLE_TEXT}
            {delivered.note ? ` — ${delivered.note}` : ""}
          </p>
        ) : (
          <>
            {visibilityNote(delivered.visibility)}
            <p className="text-text-secondary">
              {n(delivered.items)} item{delivered.items === 1 ? "" : "s"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function AppliedItem({ item, revisionNumber }: { item: PerformanceManagerAppliedItem; revisionNumber: number | null }) {
  const headingId = `pm-record-applied-${item.approvalId}`;
  return (
    <li className="space-y-3 rounded-md border border-border-soft px-3 py-3" data-testid="pm-record-applied">
      <div className="space-y-0.5">
        <h4 id={headingId} className="text-sm font-medium text-text-primary">
          {item.agentName ?? `Agent ${item.agentId.slice(0, 8)}`}
          {revisionNumber ? `, revision ${revisionNumber}` : ""} — applied {formatDateTime(item.appliedAt)}
        </h4>
        <p className="text-xs text-text-secondary">
          Before: {item.before ? `card version ${item.before.version}, stored ${formatDateTime(item.before.storedAt)}` : "no card was stored before it was applied"}
          {" · "}
          After: {item.after ? `card version ${item.after.version}, stored ${formatDateTime(item.after.storedAt)}` : "no card has been stored since it was applied"}
        </p>
      </div>
      {item.sections.length === 0 ? (
        <EmptyNote>This change named no responsibilities, so there are no card sections to set side by side.</EmptyNote>
      ) : (
        <ul className="space-y-3" aria-labelledby={headingId}>
          {item.sections.map((section) => (
            <li key={section.responsibilityKey} className="space-y-2" data-testid="pm-record-applied-section">
              <p className="text-sm text-text-primary">
                Responsibility <span className="font-mono text-xs">{section.responsibilityKey}</span>
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1 rounded-md border border-border-soft px-3 py-2" data-testid="pm-record-before">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Before</p>
                  <SectionSnapshot snapshot={section.before} emptyText="No stored card before it was applied." />
                </div>
                <div className="space-y-1 rounded-md border border-border-soft px-3 py-2" data-testid="pm-record-after">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">After</p>
                  <SectionSnapshot snapshot={section.after} emptyText="No card stored since it was applied." />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PerformanceManagerRecordContent({ record }: { record: PerformanceManagerRecord }) {
  const { proposals, recommendations } = record;
  const revisionByApproval = new Map(proposals.items.map((item) => [item.approvalId, item.revisionNumber || null]));
  // Older servers sent the tallies only.
  const recommendationItems = recommendations.items ?? [];
  return (
    <div className="max-w-4xl space-y-8" data-testid="pm-record">
      <section aria-labelledby="pm-record-heading" className="space-y-3">
        <h3 id="pm-record-heading" className="text-base font-semibold text-text-primary">
          Record as performance manager{record.managerName ? `: ${record.managerName}` : ""}
        </h3>
        <FactList>
          <Fact label="Performance manager now">{record.isEffectiveManager ? "Yes" : "No"}</Fact>
          <Fact label="As of">{formatDateTime(record.generatedAt)}</Fact>
        </FactList>
        <Banner>
          <p>{PERFORMANCE_MANAGER_ADVISORY_TEXT}</p>
          <p className="mt-1" data-testid="pm-record-note">
            {record.note || RECORD_DESCRIPTIVE_TEXT}
          </p>
        </Banner>
        {record.restricted ? (
          <p className="text-xs text-text-secondary" data-testid="pm-record-restricted">
            Some proposals, recommendations or card sections may be left out because they concern agents or work you can't see.
          </p>
        ) : null}
      </section>

      <Section
        id="pm-record-proposals"
        title="Profile changes it proposed"
        description="Every proposal waits for a person's decision. Approved counts every approved proposal, applied or not."
      >
        <FactList>
          <Fact label="Filed">{n(proposals.filed)}</Fact>
          <Fact label="Waiting for a decision">{n(proposals.pending, proposals.filed)}</Fact>
          <Fact label="Approved">{n(proposals.approved, proposals.filed)}</Fact>
          <Fact label="Rejected">{n(proposals.rejected, proposals.filed)}</Fact>
          <Fact label="Withdrawn">{n(proposals.withdrawn, proposals.filed)}</Fact>
          <Fact label="Edited by a person before the decision">{n(proposals.editedByOwnerBeforeDeciding, proposals.filed)}</Fact>
          <Fact label="Applied">{n(proposals.applied, proposals.filed)}</Fact>
        </FactList>
        {proposals.items.length === 0 ? (
          <EmptyNote>It has proposed no profile changes.</EmptyNote>
        ) : (
          <ol className="space-y-2">
            {[...proposals.items].reverse().map((item) => (
              <ProposalItem key={item.approvalId} item={item} />
            ))}
          </ol>
        )}
      </Section>

      <Section
        id="pm-record-recommendations"
        title="Recommendations it filed"
        description="What the people responsible for each agent decided. A recommendation changes nothing by itself; a pause recommendation never paused anything."
      >
        {recommendations.total === 0 ? (
          <EmptyNote>It has filed no recommendations.</EmptyNote>
        ) : (
          <>
            <FactList>
              <Fact label="All kinds">{n(recommendations.total)}</Fact>
              {AGENT_RECOMMENDATION_KINDS.map((kind) => {
                const tally = recommendations.byKind[kind];
                if (!tally) {
                  return (
                    <Fact key={kind} label={RECOMMENDATION_KIND_SHORT_TEXT[kind]}>
                      {n(null)}
                    </Fact>
                  );
                }
                return (
                  <Fact key={kind} label={RECOMMENDATION_KIND_SHORT_TEXT[kind]}>
                    <span data-testid={`pm-record-kind-${kind}`}>
                      {tally.total} filed
                      {tally.total > 0 ? (
                        <span className="text-text-secondary">
                          {" "}
                          — {tally.accepted} accepted, {tally.declined} declined, {tally.undecided} with no decision yet
                        </span>
                      ) : null}
                    </span>
                  </Fact>
                );
              })}
            </FactList>
            {recommendationItems.length > 0 ? (
              <ol className="space-y-2" aria-label="Each recommendation, newest first">
                {[...recommendationItems].reverse().map((item) => (
                  <RecommendationItem key={item.id} item={item} />
                ))}
              </ol>
            ) : null}
          </>
        )}
      </Section>

      <Section
        id="pm-record-applied"
        title="Applied changes: card sections before and after"
        description="For each applied proposal, the affected responsibilities' card sections from the last stored card before it was applied and the first stored after, as you may read them."
      >
        <p className="text-sm text-text-secondary">{RECORD_DESCRIPTIVE_TEXT}</p>
        {record.applied.length === 0 ? (
          <EmptyNote>None of its proposals has been applied.</EmptyNote>
        ) : (
          <ul className="space-y-3">
            {record.applied.map((item) => (
              <AppliedItem key={item.approvalId} item={item} revisionNumber={revisionByApproval.get(item.approvalId) ?? null} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** `/agents/:agentId/manager-record`: the agent's record as performance manager. */
export function PerformanceManagerRecordView({ companyId, managerAgentId }: { companyId: string; managerAgentId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: performanceManagerQueryKeys.record(companyId, managerAgentId),
    queryFn: () => performanceManagerApi.record(companyId, managerAgentId),
    retry: false,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link className={linkClass()} to={`/agents/${managerAgentId}/performance`}>
          Back to this agent's performance
        </Link>
      </p>
      {data ? <PerformanceManagerRecordContent record={data} /> : <ViewStatus what="record as performance manager" isLoading={isLoading} error={error} />}
    </div>
  );
}
