import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_CASE_FILTER_NONE,
  AGENT_JUDGE_KINDS,
  EVALUATION_METRIC_NAMES,
  type AgentAcceptanceFact,
  type AgentCardAcceptanceSection,
  type AgentCardBoundsSection,
  type AgentCardCostSection,
  type AgentCardDecisionsSection,
  type AgentCardDisagreement,
  type AgentCardFactCount,
  type AgentCardFatalFlag,
  type AgentCardGap,
  type AgentCardObligationsSection,
  type AgentCardQualitySection,
  type AgentCardReviewerSection,
  type AgentCardView,
  type AgentCaseRow,
  type AgentObligationEndState,
  type EvaluationOutcomeMetric,
} from "@paperclipai/shared";
import { evaluationCriterionRefKey } from "@paperclipai/shared";
import { agentPerformanceApi, agentPerformanceQueryKeys } from "@/api/agent-performance";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatCents, formatDateTime } from "@/lib/utils";
import { EventDrawer, EvidenceRefs, fmtValue, useEventDrawer } from "@/pages/evaluation/shared";
import { AgentCaseDrilldown, type AgentCardViewer, type CaseDrillTarget } from "./AgentCaseDrilldown";
import {
  CardSection,
  END_STATE_TEXT,
  EXCEPTION_KIND_TEXT,
  FATAL_CLASS_TEXT,
  FATAL_STATUS_TEXT,
  JUDGE_TEXT,
  NoneYet,
  PRIMARY_END_STATES,
  SubHeading,
  WorkItemLink,
  criterionFromContract,
  predicateText,
} from "./card-shared";
import { apiErrorMessage } from "./profile-shared";
import { EmptyNote, Fact, FactList, Section, StateBadge, formatWindow } from "./shared";

// AgentDash: Agent Performance Management gate 3 (P3.5) — one agent card as
// the viewer receives it (`AgentCardView`). Potentially fatal flags come
// first, then the six questions about its work as a worker in the overview
// LLD §1 order, then its work as a reviewer (kept separate), then gaps. A
// section the viewer can't read says "Not visible to you" with no counts.
// On a stored card every number with cases behind it opens them; a "Compute
// now" card is not stored, so its numbers have no case list.

export const CARD_QUESTIONS = {
  obligations: "Is the work it owes getting done?",
  quality: "Is the work good?",
  acceptance: "Is it accepted, used, and moving the result?",
  cost: "What does it cost?",
  bounds: "Is it staying inside its boundaries?",
  decisions: "What needs my decision?",
} as const;

export const FATAL_TITLE = "Potentially fatal flags";
export const REVIEWER_TITLE = "Its reviews of other agents' work";

/** How drill-downs behave on this card: on for a stored version, off for "Compute now". */
interface DrillUi {
  enabled: boolean;
  openKey: string | null;
  regionId: (home: string) => string;
  toggle: (target: CaseDrillTarget) => void;
}

function UnknownValue({ note }: { note?: string | null }) {
  return (
    <span data-testid="agent-pm-unknown">
      <span className="font-medium text-text-primary">Unknown</span>
      {note ? <span className="text-text-secondary"> — {note}</span> : null}
    </span>
  );
}

/**
 * A number, "of" its denominator. On a stored card a non-zero number opens
 * its cases (a button with the expanded state); zero and unknown don't.
 */
function CaseCount({
  value,
  of,
  unit,
  target,
  ui,
  unknownNote,
}: {
  value: number | null;
  of?: number | null;
  unit?: string;
  target?: CaseDrillTarget | null;
  ui: DrillUi;
  unknownNote?: string;
}) {
  if (value === null) return <UnknownValue note={unknownNote} />;
  const tail = (
    <>
      {of != null ? <span className="text-text-secondary"> of {of}</span> : null}
      {unit ? <span className="text-text-secondary"> {unit}</span> : null}
    </>
  );
  if (!ui.enabled || !target || value === 0) {
    return (
      <span>
        <span className="font-medium tabular-nums text-text-primary">{value}</span>
        {tail}
      </span>
    );
  }
  const open = ui.openKey === target.key;
  return (
    <span>
      <button
        type="button"
        className="font-medium tabular-nums text-text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-2"
        aria-expanded={open}
        aria-controls={ui.regionId(target.home)}
        onClick={() => ui.toggle(target)}
        data-testid="agent-card-case-count"
      >
        {value}
        <span className="sr-only">{open ? " — hide its cases" : ` — show the cases: ${target.label}`}</span>
      </button>
      {tail}
    </span>
  );
}

function times(n: number): string {
  return `${n} ${n === 1 ? "time" : "times"}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function FatalBody({ flags, ui }: { flags: AgentCardFatalFlag[]; ui: DrillUi }) {
  if (flags.length === 0) return <EmptyNote>No potentially fatal flags in this window.</EmptyNote>;
  return (
    <>
      <FactList>
        <Fact label="Flags">
          <CaseCount value={flags.length} ui={ui} target={{ key: "fatal", home: "fatal", label: "potentially fatal flags", section: "fatal" }} />
        </Fact>
      </FactList>
      <ul className="space-y-2">
        {flags.map((flag) => (
          <li key={flag.key} className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-card-fatal-flag">
            <p className="font-medium text-text-primary">{FATAL_CLASS_TEXT[flag.fatalClass]}</p>
            <div className="flex flex-wrap gap-1.5">
              <StateBadge label="Status" value={FATAL_STATUS_TEXT[flag.status]} tone={flag.status === "confirmed" ? "problem" : "neutral"} />
            </div>
            <p className="text-text-secondary">
              <WorkItemLink item={flag.item} /> · raised {formatDateTime(flag.raisedAt)}
            </p>
            <p className="text-text-secondary">{flag.note}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function ObligationsBody({ body, ui }: { body: AgentCardObligationsSection; ui: DrillUi }) {
  if (body.responsibilities.length === 0 && body.unmapped.items === 0) return <NoneYet />;
  return (
    <>
      {body.responsibilities.length === 0 ? (
        <EmptyNote>No responsibility owed work in this window.</EmptyNote>
      ) : (
        <ul className="space-y-3">
          {body.responsibilities.map((row) => {
            const name = row.title ?? row.responsibilityKey;
            const states = (Object.keys(row.byEndState) as AgentObligationEndState[]).filter(
              (state) => PRIMARY_END_STATES.includes(state) || row.byEndState[state] > 0,
            );
            const ordered = [
              ...PRIMARY_END_STATES.filter((state) => states.includes(state)),
              ...states.filter((state) => !PRIMARY_END_STATES.includes(state)),
            ];
            return (
              <li key={`${row.responsibilityKey}-${row.profileRevisionId ?? "none"}`} className="space-y-2" data-testid="agent-card-responsibility">
                <SubHeading>{name}</SubHeading>
                {row.profileRevisionId ? (
                  <p className="text-xs text-text-secondary">Profile revision {row.profileRevisionId.slice(0, 8)}</p>
                ) : null}
                <FactList>
                  <Fact label="Owed">
                    <CaseCount
                      value={row.owed}
                      ui={ui}
                      unknownNote="the cadence is free text, so owed periods can't be counted"
                      target={{ key: `obl:${row.responsibilityKey}`, home: "obligations", label: `owed by ${name}`, section: "obligations", responsibility: row.responsibilityKey }}
                    />
                  </Fact>
                  {ordered.map((state) => (
                    <Fact key={state} label={END_STATE_TEXT[state]}>
                      <CaseCount
                        value={row.byEndState[state]}
                        of={row.owed}
                        ui={ui}
                        target={{
                          key: `obl:${row.responsibilityKey}:${state}`,
                          home: "obligations",
                          label: `${END_STATE_TEXT[state].toLowerCase()}, ${name}`,
                          section: "obligations",
                          responsibility: row.responsibilityKey,
                          state,
                        }}
                      />
                    </Fact>
                  ))}
                  <Fact label="Delivered by another agent">
                    <CaseCount value={row.deliveredByOtherProducer} ui={ui} />
                  </Fact>
                  <Fact label="Work items delivered">
                    <CaseCount value={row.deliveredItemCount} ui={ui} />
                  </Fact>
                </FactList>
                {row.note ? <p className="text-sm text-text-secondary">{row.note}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      <FactList>
        <Fact label="Work that maps to no responsibility">
          <CaseCount
            value={body.unmapped.items}
            ui={ui}
            target={{
              key: "obl:unmapped",
              home: "obligations",
              label: "work that maps to no responsibility",
              section: "obligations",
              responsibility: AGENT_CASE_FILTER_NONE,
            }}
          />
        </Fact>
      </FactList>
    </>
  );
}

function QualityBody({ body, ui }: { body: AgentCardQualitySection; ui: DrillUi }) {
  const ind = body.judgeIndependence;
  const tiers = Object.entries(body.sourceDiversity).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      {body.criteria.length === 0 ? (
        <NoneYet>No observed cases yet: no declared criterion had work in scope.</NoneYet>
      ) : (
        <ul className="space-y-3">
          {body.criteria.map((criterion) => {
            const key = evaluationCriterionRefKey(criterion.criterion);
            return (
              <li key={key} className="space-y-2" data-testid="agent-card-criterion">
                <SubHeading>{criterion.text}</SubHeading>
                <p className="text-xs text-text-secondary">
                  {predicateText(criterion.predicate)} · responsibility {criterion.criterion.responsibilityKey}
                </p>
                <FactList>
                  <Fact label="Work items in scope">
                    <CaseCount
                      value={criterion.items}
                      ui={ui}
                      target={{
                        key: `q:${key}`,
                        home: "quality",
                        label: `“${criterion.text}”`,
                        section: "quality",
                        responsibility: criterion.criterion.responsibilityKey,
                        criterion: key,
                      }}
                    />
                  </Fact>
                  {AGENT_JUDGE_KINDS.map((judge) => {
                    const tally = criterion.byJudge[judge];
                    const target = (result: "pass" | "fail"): CaseDrillTarget => ({
                      key: `q:${key}:${judge}:${result}`,
                      home: "quality",
                      label: `${result === "pass" ? "passed" : "failed"} by ${JUDGE_TEXT[judge].toLowerCase()}, “${criterion.text}”`,
                      section: "quality",
                      responsibility: criterion.criterion.responsibilityKey,
                      state: result,
                      criterion: key,
                      judge,
                    });
                    return (
                      <Fact key={judge} label={JUDGE_TEXT[judge]}>
                        <CaseCount value={tally.pass} ui={ui} target={target("pass")} />
                        <span className="text-text-secondary"> passed · </span>
                        <CaseCount value={tally.fail} ui={ui} target={target("fail")} />
                        <span className="text-text-secondary"> failed · </span>
                        <CaseCount value={tally.unknown} ui={ui} />
                        <span className="text-text-secondary"> not judged</span>
                      </Fact>
                    );
                  })}
                </FactList>
              </li>
            );
          })}
        </ul>
      )}
      <SubHeading>Who judged, and what else was observed</SubHeading>
      <FactList>
        <Fact label="Judges independent of the producer">
          <CaseCount value={ind.independent} ui={ui} />
          <span className="text-text-secondary"> independent · </span>
          <CaseCount value={ind.notIndependent} ui={ui} />
          <span className="text-text-secondary"> not independent · </span>
          <CaseCount value={ind.unknown} ui={ui} />
          <span className="text-text-secondary"> unknown</span>
        </Fact>
        <Fact label="Source tiers behind the facts">
          {tiers.length === 0 ? (
            <span className="text-text-secondary">None recorded</span>
          ) : (
            <span>{tiers.map(([tier, n]) => `${tier}: ${n}`).join(" · ")}</span>
          )}
          <span className="block text-xs text-text-secondary">Different source tiers are not the same as independent judges.</span>
        </Fact>
        <Fact label="Unbound observations">
          <CaseCount
            value={body.unboundObservations}
            ui={ui}
            target={{
              key: "q:unbound",
              home: "quality",
              label: "unbound observations",
              section: "quality",
              criterion: AGENT_CASE_FILTER_NONE,
            }}
          />
          <span className="block text-xs text-text-secondary">They name no criterion, so they satisfy none.</span>
        </Fact>
        <Fact label="Rework on work it produced">
          <CaseCount value={body.rework.items} ui={ui} unit={body.rework.items === 1 ? "item" : "items"} />
          <span className="text-text-secondary">, reopened {times(body.rework.reopened)}</span>
        </Fact>
      </FactList>
    </>
  );
}

const FACTS: Array<{ key: keyof AgentCardAcceptanceSection["facts"]; label: string; caseFact: AgentAcceptanceFact }> = [
  { key: "automatedAcceptance", label: "Passed automated checks", caseFact: "automated" },
  { key: "humanAcceptance", label: "Accepted by a person", caseFact: "human" },
  { key: "use", label: "Used", caseFact: "use" },
  { key: "outcome", label: "Moved the result", caseFact: "outcome" },
];

function FactCounts({ fact, label, caseFact, ui }: { fact: AgentCardFactCount; label: string; caseFact: AgentAcceptanceFact; ui: DrillUi }) {
  const target = (state: "pass" | "fail" | "unknown", word: string): CaseDrillTarget => ({
    key: `acc:${caseFact}:${state}`,
    home: "acceptance",
    label: `${label.toLowerCase()}: ${word}`,
    section: "acceptance",
    state,
    fact: caseFact,
  });
  return (
    <>
      <CaseCount value={fact.yes} ui={ui} target={target("pass", "yes")} />
      <span className="text-text-secondary"> yes · </span>
      <CaseCount value={fact.no} ui={ui} target={target("fail", "no")} />
      <span className="text-text-secondary"> no · </span>
      <CaseCount value={fact.unknown} ui={ui} target={target("unknown", "unknown")} />
      <span className="text-text-secondary"> unknown, of {fact.of}</span>
    </>
  );
}

function AcceptanceBody({ body, ui }: { body: AgentCardAcceptanceSection; ui: DrillUi }) {
  const byResponsibility = Object.entries(body.delivered.byResponsibility).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <FactList>
        {FACTS.map((fact) => (
          <Fact key={fact.key} label={fact.label}>
            <FactCounts fact={body.facts[fact.key]} label={fact.label} caseFact={fact.caseFact} ui={ui} />
          </Fact>
        ))}
        <Fact label="Work items delivered">
          <CaseCount value={body.delivered.items} ui={ui} />
          {byResponsibility.length > 0 ? (
            <span className="block text-xs text-text-secondary">{byResponsibility.map(([key, n]) => `${key}: ${n}`).join(" · ")}</span>
          ) : null}
        </Fact>
      </FactList>
      <SubHeading>Projects it led and goals it owned</SubHeading>
      {body.accountable.length === 0 ? (
        <EmptyNote>It led no projects and owned no goals in this window.</EmptyNote>
      ) : (
        <ul className="space-y-2">
          {body.accountable.map((result) => {
            const outcome = Object.entries(result.outcome) as Array<[EvaluationOutcomeMetric, NonNullable<(typeof result.outcome)[EvaluationOutcomeMetric]>]>;
            return (
              <li key={`${result.ref.kind}-${result.ref.id}`} className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-card-accountable">
                <p className="font-medium text-text-primary">
                  {result.ref.kind === "project" ? "Project" : "Goal"}: {result.name ?? "Unknown name"}
                </p>
                <p className="text-text-secondary">
                  {result.intervals
                    .map((interval) => `${interval.role} from ${formatDateTime(interval.from)} to ${interval.to ? formatDateTime(interval.to) : "now"}`)
                    .join("; ")}
                </p>
                {outcome.length === 0 ? (
                  <p className="text-text-secondary">Outcome: Unknown — no outcome measures at this cut</p>
                ) : (
                  <ul className="space-y-0.5">
                    {outcome.map(([metricKey, metric]) => (
                      <li key={metricKey}>
                        {EVALUATION_METRIC_NAMES[metricKey]}: <span className="font-medium">{fmtValue(metric)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-text-secondary">
                  Recomputed from the same records (through event {result.citation.throughSeq}, card {result.citation.hash.slice(0, 12)}).
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function CostBody({ body, ui, personName }: { body: AgentCardCostSection; ui: DrillUi; personName: (userId: string) => string }) {
  const money = (cents: number | null, note: string) =>
    cents === null ? <UnknownValue note={note} /> : <span className="font-medium tabular-nums">{formatCents(cents)}</span>;
  return (
    <>
      <FactList>
        <Fact label="Agent spend">{money(body.spendCents, "no cost record in this window")}</Fact>
        <Fact label="Spend on runs with no issue">{money(body.unattributedSpendCents, "no cost record in this window")}</Fact>
        <Fact label="Runs">
          <CaseCount value={body.runs.total} ui={ui} />
        </Fact>
        <Fact label="Runs succeeded">
          <CaseCount value={body.runs.succeeded} of={body.runs.total} ui={ui} />
        </Fact>
        <Fact label="Runs failed">
          <CaseCount value={body.runs.failed} of={body.runs.total} ui={ui} />
        </Fact>
        <Fact label="Runs with no issue">
          <CaseCount value={body.runs.withoutIssue} of={body.runs.total} ui={ui} />
        </Fact>
      </FactList>
      <SubHeading>People's time (proxies)</SubHeading>
      <FactList>
        <Fact label="Questions it asked people">
          <CaseCount value={body.questionsToPeople.asked} ui={ui} />
        </Fact>
        <Fact label="Questions answered">
          <CaseCount value={body.questionsToPeople.answered} of={body.questionsToPeople.asked} ui={ui} />
        </Fact>
        <Fact label="Median wait for an answer">
          <CaseCount value={body.questionsToPeople.medianWaitMinutes} unit="minutes" ui={ui} unknownNote="no answered questions in this window" />
        </Fact>
        <Fact label="Reviews by people">
          <CaseCount value={body.humanReviewActions} ui={ui} />
        </Fact>
        <Fact label="Corrections by people">
          <CaseCount value={body.humanCorrections} ui={ui} />
        </Fact>
        <Fact label="Minutes people reported (self-reported)">
          <CaseCount value={body.selfReportedMinutes} unit="minutes" ui={ui} unknownNote="nobody reported minutes" />
        </Fact>
      </FactList>
      <SubHeading>By person</SubHeading>
      {body.byPerson === null ? (
        <EmptyNote>Visible to company admins and the agent's accountable person.</EmptyNote>
      ) : body.byPerson.length === 0 ? (
        <EmptyNote>Nobody spent time on this agent in this window.</EmptyNote>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="agent-card-by-person">
          {body.byPerson.map((row) => (
            <li key={row.userId}>
              {personName(row.userId)}: {row.questions} questions, {row.reviews} reviews, {row.corrections} corrections
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-secondary">Cost and people's time come from run and question records; they have no case list here.</p>
    </>
  );
}

function BoundsBody({ body, ui }: { body: AgentCardBoundsSection; ui: DrillUi }) {
  const dims = Object.entries(body.byDimension).sort(([a], [b]) => a.localeCompare(b));
  const target = (state: AgentCaseRow["state"], label: string): CaseDrillTarget => ({ key: `b:${state}`, home: "bounds", label, section: "bounds", state });
  return (
    <>
      <FactList>
        <Fact label="Allowed use">
          <CaseCount value={body.allowedUse} ui={ui} unknownNote="no record of allowed use" />
        </Fact>
        <Fact label="Refused attempts">
          <CaseCount value={body.refusedAttempts} ui={ui} target={target("refused", "refused attempts")} />
        </Fact>
        <Fact label="Tried again after a refusal">
          <CaseCount value={body.repeatedAfterRefusal} ui={ui} target={target("repeated_after_refusal", "tried again after a refusal")} />
        </Fact>
        <Fact label="Would have been refused (shadow)">
          <CaseCount value={body.wouldRefuse} ui={ui} target={target("would_refuse", "would have been refused")} />
        </Fact>
        <Fact label="Ran outside its access (a breach)">
          <CaseCount value={body.unauthorizedExecution} ui={ui} target={target("unauthorized_execution", "ran outside its access")} />
        </Fact>
      </FactList>
      {dims.length > 0 ? (
        <ul className="space-y-0.5 text-sm" data-testid="agent-card-bounds-dimensions">
          {dims.map(([dimension, n]) => (
            <li key={dimension}>
              <span className="font-mono text-xs">{dimension}</span>: refused {n.refused} · tried again {n.repeated} · would refuse {n.wouldRefuse} · ran outside {n.unauthorized}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** "Note disagreement": the accountable person or an admin records that they saw it. Both judgments stay. */
function NoteDisagreementAction({ companyId, agentId, disagreement }: { companyId: string; agentId: string; disagreement: AgentCardDisagreement }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const ids = [...new Set(disagreement.judgments.map((j) => j.eventId))];
  const mutation = useMutation({
    mutationFn: () =>
      agentPerformanceApi.recordDisposition(companyId, {
        kind: "disagreement_noted",
        subjectRef: { kind: "agent", id: agentId },
        item: disagreement.item,
        criterion: disagreement.criterion,
        judgmentEventIds: ids.slice(0, 20),
        note: note.trim(),
      }),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      setMessage("Noted. Both judgments stay; the next card shows it as noted.");
      void queryClient.invalidateQueries({ queryKey: agentPerformanceQueryKeys.cardAll(companyId, agentId) });
    },
    onError: (err) => setError(`Not recorded: ${apiErrorMessage(err)}`),
  });
  if (ids.length < 2) return null;
  return (
    <div className="space-y-2" data-testid="agent-card-note-disagreement">
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim()) mutation.mutate();
          }}
        >
          <label htmlFor={noteId} className="block text-sm text-text-primary">
            What did you make of it?
          </label>
          <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={2} required />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={mutation.isPending || !note.trim()}>
              {mutation.isPending ? "Recording…" : "Record note"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Note disagreement
        </Button>
      )}
      <p role="status" aria-live="polite" className={message ? "text-sm text-text-primary" : "sr-only"}>
        {message}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DecisionsBody({
  body,
  view,
  viewer,
  companyId,
  agentId,
  ui,
  onOpenEvent,
  personName,
}: {
  body: AgentCardDecisionsSection;
  view: AgentCardView;
  viewer: AgentCardViewer;
  companyId: string;
  agentId: string;
  ui: DrillUi;
  onOpenEvent: (eventId: string) => void;
  personName: (userId: string) => string;
}) {
  const mayNote = ui.enabled && view.viewer.canNoteDisagreement;
  const agreement = Object.entries(body.calibration.agreementByJudge).sort(([a], [b]) => a.localeCompare(b)) as Array<[keyof typeof JUDGE_TEXT, { agree: number; of: number }]>;
  return (
    <>
      <SubHeading>Exceptions</SubHeading>
      {body.exceptions.length === 0 ? (
        <EmptyNote>No exceptions in this window.</EmptyNote>
      ) : (
        <ul className="space-y-2">
          {body.exceptions.map((exception) => (
            <li key={exception.key} className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-card-exception">
              <p className="font-medium text-text-primary">{EXCEPTION_KIND_TEXT[exception.kind]}</p>
              <div className="flex flex-wrap gap-1.5">
                <StateBadge label="Severity" value={exception.severity} tone={exception.severity === "immediate" ? "problem" : "neutral"} />
                <StateBadge
                  label="For"
                  value={exception.routeToUserId ? (exception.routeToUserId === viewer.userId ? "You" : personName(exception.routeToUserId)) : "Nobody named"}
                />
              </div>
              <p className="text-text-secondary">
                <WorkItemLink item={exception.item} /> · raised {formatDateTime(exception.raisedAt)}
              </p>
              <p className="text-text-secondary">{exception.note}</p>
              <EvidenceRefs refs={exception.evidenceRefs} onOpen={onOpenEvent} />
            </li>
          ))}
        </ul>
      )}
      <SubHeading>Disagreements</SubHeading>
      {body.disagreements.length === 0 ? (
        <EmptyNote>No judgments disagree in this window.</EmptyNote>
      ) : (
        <ul className="space-y-2">
          {body.disagreements.map((disagreement) => {
            const criterion = criterionFromContract(view.contract, disagreement.criterion);
            return (
              <li
                key={`${evaluationCriterionRefKey(disagreement.criterion)}-${disagreement.item.kind}-${disagreement.item.id}`}
                className="space-y-1 rounded-md border border-border-soft px-3 py-2 text-sm"
                data-testid="agent-card-disagreement"
              >
                <p className="font-medium text-text-primary">{criterion?.text ?? disagreement.criterion.criterionId}</p>
                <p className="text-text-secondary">
                  <WorkItemLink item={disagreement.item} />
                </p>
                <ul className="space-y-0.5">
                  {disagreement.judgments.map((judgment) => (
                    <li key={judgment.eventId}>
                      {JUDGE_TEXT[judgment.judge]}: {judgment.result === "pass" ? "passed" : judgment.result === "fail" ? "failed" : "unknown"}{" "}
                      <span className="text-text-secondary">({formatDateTime(judgment.at)})</span>
                    </li>
                  ))}
                </ul>
                <StateBadge label="Noted by a person" value={disagreement.notedEventId ? "Yes" : "Not yet"} />
                <p className="text-xs text-text-secondary">Both judgments stay. Nothing is settled by vote.</p>
                {mayNote && !disagreement.notedEventId ? (
                  <NoteDisagreementAction companyId={companyId} agentId={agentId} disagreement={disagreement} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <SubHeading>Calibration</SubHeading>
      <FactList>
        <Fact label="Sampled for a person's review">
          <CaseCount value={body.calibration.sampled} ui={ui} />
        </Fact>
        <Fact label="Closed by that person">
          <CaseCount value={body.calibration.closed} of={body.calibration.sampled} ui={ui} />
        </Fact>
        {agreement.map(([judge, a]) => (
          <Fact key={judge} label={`${JUDGE_TEXT[judge]} agreed with the person`}>
            <CaseCount value={a.agree} of={a.of} ui={ui} />
          </Fact>
        ))}
        <Fact label="Work no responsibility owns">
          <CaseCount
            value={body.unownedWork}
            ui={ui}
            target={{
              key: "dec:unowned",
              home: "decisions",
              label: "work no responsibility owns",
              section: "obligations",
              responsibility: AGENT_CASE_FILTER_NONE,
            }}
          />
        </Fact>
      </FactList>
      <p className="text-xs text-text-secondary">
        Each sampled item, every disagreement and every potentially fatal flag goes to the named person as an issue in “Evaluator review items”. They close it with a verdict or an attestation.
      </p>
    </>
  );
}

function ReviewerBody({ body, ui }: { body: AgentCardReviewerSection; ui: DrillUi }) {
  const outcomes = Object.entries(body.reviews.byOutcome).sort(([a], [b]) => a.localeCompare(b));
  if (body.reviews.total === 0) return <NoneYet>No observed cases yet: it reviewed no other agent's work in this window.</NoneYet>;
  return (
    <FactList>
      <Fact label="Reviews">
        <CaseCount value={body.reviews.total} ui={ui} target={{ key: "rev", home: "reviewer", label: "its reviews", section: "reviewer" }} />
        <span className="text-text-secondary">
          {" "}
          ({body.reviews.bound} bound to a criterion, {body.reviews.unbound} unbound)
        </span>
      </Fact>
      {outcomes.length > 0 ? (
        <Fact label="Outcomes">{outcomes.map(([outcome, n]) => `${outcome.replace(/_/g, " ")}: ${n}`).join(" · ")}</Fact>
      ) : null}
      <Fact label="Independent of the producer">
        <CaseCount value={body.independence.independent} of={body.reviews.total} ui={ui} />
        <span className="text-text-secondary">
          {" "}
          · not independent {body.independence.notIndependent} · unknown {body.independence.unknown}
        </span>
      </Fact>
      <Fact label="Agreed with a person's later judgment">
        <CaseCount value={body.agreementWithPeople.agree} of={body.agreementWithPeople.of} ui={ui} />
        <span className="text-text-secondary"> · disagreed {body.agreementWithPeople.disagree}</span>
      </Fact>
    </FactList>
  );
}

function GapsBody({ gaps }: { gaps: AgentCardGap[] }) {
  if (gaps.length === 0) return <EmptyNote>No gaps reported.</EmptyNote>;
  return (
    <ul className="space-y-2">
      {gaps.map((gap, index) => (
        <li key={`${gap.code}-${index}`} className="rounded-md border border-border-soft px-3 py-2 text-sm">
          <p className="text-text-primary">{gap.message}</p>
          <p className="mt-0.5 font-mono text-xs text-text-secondary">
            {gap.code}
            {gap.responsibilityKey ? ` · ${gap.responsibilityKey}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function AgentCardDisplay({
  view,
  companyId,
  agentId,
  viewer,
  drillable,
  personName = (userId) => userId.slice(0, 8),
}: {
  view: AgentCardView;
  companyId: string;
  agentId: string;
  viewer: AgentCardViewer;
  /** True for a stored version: its numbers open their cases. */
  drillable: boolean;
  personName?: (userId: string) => string;
}) {
  const baseId = useId();
  const [open, setOpen] = useState<CaseDrillTarget | null>(null);
  const drawer = useEventDrawer();
  const version = view.stored?.version ?? null;
  const ui: DrillUi = {
    enabled: drillable && version !== null,
    openKey: open?.key ?? null,
    regionId: (home) => `${baseId}-cases-${home}`,
    toggle: (target) => setOpen((current) => (current?.key === target.key ? null : target)),
  };
  const drill = (home: string): ReactNode =>
    ui.enabled && open && open.home === home && version !== null ? (
      <AgentCaseDrilldown
        key={open.key}
        regionId={ui.regionId(home)}
        companyId={companyId}
        agentId={agentId}
        version={version}
        target={open}
        contract={view.contract}
        permissions={view.viewer}
        onClose={() => setOpen(null)}
        onOpenEvent={drawer.open}
      />
    ) : null;
  const contract = view.contract;

  return (
    <div className="space-y-8" data-testid="agent-card">
      <div className="space-y-1 text-sm text-text-secondary" data-testid="agent-card-header">
        <p>
          <span className="text-text-primary">Window:</span> {formatWindow(view.replay.window)}
        </p>
        <p>
          <span className="text-text-primary">As of:</span> {formatDateTime(view.replay.asOf)} · ledger read through event {view.replay.throughSeq}
        </p>
        <p data-testid="agent-card-contract">
          {contract.source === "declared"
            ? `Judged against the contract declared ${contract.declaredAt ? formatDateTime(contract.declaredAt) : "(date unknown)"}${
                contract.profileRevisionId ? ` with profile revision ${contract.profileRevisionId.slice(0, 8)}` : ""
              }.`
            : "No applied profile: no criteria are declared, so whether work is accepted can't be decided."}
        </p>
        {view.restricted ? <p>Numbers count only the records you can read.</p> : null}
        {view.markers.length > 0 ? <p>Notes: {view.markers.join(" · ")}</p> : null}
      </div>

      <CardSection
        id="agent-card-fatal"
        title={FATAL_TITLE}
        description="Shown first, whatever else the card says. A flag is potential until a person confirms or dismisses it."
        view={view.fatal}
        aside={drill("fatal")}
      >
        {(flags) => <FatalBody flags={flags} ui={ui} />}
      </CardSection>

      <div className="space-y-8" role="group" aria-labelledby={`${baseId}-worker`}>
        <h2 id={`${baseId}-worker`} className="text-sm font-medium uppercase tracking-wide text-text-secondary">
          Its own work
        </h2>
        <CardSection
          id="agent-card-obligations"
          title={CARD_QUESTIONS.obligations}
          description="Work owed by each responsibility, including periods in which nothing ran, and how each ended."
          view={view.worker.obligations}
          aside={drill("obligations")}
        >
          {(body) => <ObligationsBody body={body} ui={ui} />}
        </CardSection>
        <CardSection
          id="agent-card-quality"
          title={CARD_QUESTIONS.quality}
          description="Per criterion, split by who judged. Only judgments bound to a criterion count."
          view={view.worker.quality}
          aside={drill("quality")}
        >
          {(body) => <QualityBody body={body} ui={ui} />}
        </CardSection>
        <CardSection
          id="agent-card-acceptance"
          title={CARD_QUESTIONS.acceptance}
          description="Four separate facts about work it delivered. One does not stand in for another."
          view={view.worker.acceptance}
          aside={drill("acceptance")}
        >
          {(body) => <AcceptanceBody body={body} ui={ui} />}
        </CardSection>
        <CardSection
          id="agent-card-cost"
          title={CARD_QUESTIONS.cost}
          description="Agent spend, and proxies for people's time. Proxies are labelled; they are not hours saved."
          view={view.worker.cost}
        >
          {(body) => <CostBody body={body} ui={ui} personName={personName} />}
        </CardSection>
        <CardSection
          id="agent-card-bounds"
          title={CARD_QUESTIONS.bounds}
          description="A refused attempt is an attempt, not misconduct. Only running outside its access is a breach."
          view={view.worker.bounds}
          aside={drill("bounds")}
        >
          {(body) => <BoundsBody body={body} ui={ui} />}
        </CardSection>
        <CardSection
          id="agent-card-decisions"
          title={CARD_QUESTIONS.decisions}
          description="Exceptions, disagreements between judges, calibration and unowned work."
          view={view.worker.decisions}
          aside={drill("decisions")}
        >
          {(body) => (
            <DecisionsBody
              body={body}
              view={view}
              viewer={viewer}
              companyId={companyId}
              agentId={agentId}
              ui={ui}
              onOpenEvent={drawer.open}
              personName={personName}
            />
          )}
        </CardSection>
      </div>

      <CardSection
        id="agent-card-reviewer"
        title={REVIEWER_TITLE}
        description="Kept apart from its own work: reviewing is not producing."
        view={view.reviewer}
        aside={drill("reviewer")}
      >
        {(body) => <ReviewerBody body={body} ui={ui} />}
      </CardSection>

      <CardSection id="agent-card-gaps" title="Gaps" description="What these records can't show or don't check yet." view={view.gaps}>
        {(gaps) => <GapsBody gaps={gaps} />}
      </CardSection>

      {!ui.enabled ? (
        <Section id="agent-card-no-cases" title="Cases">
          <EmptyNote>This card was computed now and not stored, so its numbers don't open cases. A stored version's numbers do.</EmptyNote>
        </Section>
      ) : null}

      <EventDrawer companyId={companyId} eventId={drawer.eventId} onClose={drawer.close} />
    </div>
  );
}
