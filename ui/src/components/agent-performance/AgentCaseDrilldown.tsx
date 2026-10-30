import { useId, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AgentAcceptanceFact,
  AgentCardContractSummary,
  AgentCardViewerPermissions,
  AgentCaseFilter,
  AgentCaseRow,
  AgentJudgeKind,
  EvaluationAgentDisposition,
} from "@paperclipai/shared";
import { evaluationCriterionRefKey } from "@paperclipai/shared";
import {
  AGENT_CASES_PAGE_SIZE,
  agentPerformanceApi,
  agentPerformanceQueryKeys,
} from "@/api/agent-performance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/utils";
import { EvidenceRefs } from "@/pages/evaluation/shared";
import {
  JUDGE_TEXT,
  ROLE_TEXT,
  WorkItemLink,
  caseStateText,
  caseStatesFor,
  criterionFromContract,
} from "./card-shared";
import { apiErrorMessage } from "./profile-shared";
import { EmptyNote } from "./shared";

// AgentDash: Agent Performance Management gate 3 (P3.5) — the cases behind
// one number on a stored agent card (`GET evaluation/agents/:agentId/cases`).
// The server filters by access class before counting or paging, so the list
// and its total only ever hold what this viewer may read. Unbound automated
// observations are shown as such: they name no criterion and satisfy none.
// The actions a person may take on a case sit beside it, and only where the
// card's `viewer` flags say the server accepts them from this person (the
// server still decides). Every filter is applied by the server, after the
// class filter, so the list and its total always agree.

/** Who is looking, for "You" labels. What they may do comes from the card (`view.viewer`). */
export interface AgentCardViewer {
  userId: string | null;
}

/** Which number's cases to show: the server filters by every field set here. */
export interface CaseDrillTarget {
  key: string;
  /** Which card block the list opens under. */
  home: string;
  label: string;
  section: AgentCaseRow["section"];
  state?: AgentCaseRow["state"];
  /** A responsibility key, or `AGENT_CASE_FILTER_NONE` for work with no responsibility. */
  responsibility?: string;
  fact?: AgentAcceptanceFact;
  /** A criterion tuple key (`evaluationCriterionRefKey`), or `AGENT_CASE_FILTER_NONE` for observations naming none. */
  criterion?: string;
  judge?: AgentJudgeKind;
}

export const UNBOUND_TEXT = "Unbound: names no criterion, so it satisfies none";

function isUnbound(row: AgentCaseRow): boolean {
  return row.section === "quality" && row.criterion === null;
}

/** The acceptance fact a case row stands for. */
const ACCEPTANCE_FACT_TEXT: Record<AgentAcceptanceFact, string> = {
  automated: "Passed automated checks",
  human: "Accepted by a person",
  use: "Used",
  outcome: "Moved the result",
};

function DispositionStatus({ message, error }: { message: string; error: string | null }) {
  return (
    <>
      <p role="status" aria-live="polite" className={message ? "text-sm text-text-primary" : "sr-only"}>
        {message}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function useRecordDisposition(companyId: string, agentId: string, onDone: (message: string) => void) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: EvaluationAgentDisposition) => agentPerformanceApi.recordDisposition(companyId, body),
    onSuccess: (result) => {
      setError(null);
      onDone(
        result.inserted > 0
          ? "Recorded. The next card reflects it."
          : "Already recorded; nothing new was added.",
      );
      void queryClient.invalidateQueries({ queryKey: agentPerformanceQueryKeys.cardAll(companyId, agentId) });
    },
    onError: (err) => setError(`Not recorded: ${apiErrorMessage(err)}`),
  });
  return { mutation, error };
}

/** "Confirm use": any person who can see the agent records that the work was used. A fact of use, not acceptance. */
function ConfirmUseAction({ companyId, agentId, row }: { companyId: string; agentId: string; row: AgentCaseRow }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const noteId = useId();
  const { mutation, error } = useRecordDisposition(companyId, agentId, (text) => {
    setMessage(text);
    setOpen(false);
  });
  if (!row.item) return null;
  const item = row.item;
  return (
    <div className="space-y-2" data-testid="agent-case-confirm-use">
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              kind: "use_confirmed",
              subjectRef: { kind: "agent", id: agentId },
              item,
              ...(row.responsibilityKey ? { responsibilityKey: row.responsibilityKey } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
              evidenceRefs: row.evidenceRefs.slice(0, 50),
            });
          }}
        >
          <label htmlFor={noteId} className="block text-sm text-text-primary">
            How was it used? (optional)
          </label>
          <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={2} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              {mutation.isPending ? "Recording…" : "Confirm use"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Confirm use
        </Button>
      )}
      <DispositionStatus message={message} error={error} />
    </div>
  );
}

/**
 * "Attest criterion": the criterion's named attester records satisfied or
 * not, bound to the criterion tuple, the agent and the work item. It cites
 * the case's own records: a quality case carries the item's delivery,
 * verdicts and run even before anyone has judged it.
 */
function AttestAction({
  companyId,
  agentId,
  row,
}: {
  companyId: string;
  agentId: string;
  row: AgentCaseRow & { criterion: NonNullable<AgentCaseRow["criterion"]>; item: NonNullable<AgentCaseRow["item"]> };
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<"satisfied" | "unsatisfied">("satisfied");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const groupName = useId();
  const noteId = useId();
  const evidence = row.evidenceRefs;
  const { mutation, error } = useRecordDisposition(companyId, agentId, (text) => {
    setMessage(text);
    setOpen(false);
  });
  const evidenceMissing = open && evidence.length === 0;

  return (
    <div className="space-y-2" data-testid="agent-case-attest">
      {open ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (evidence.length === 0) return;
            mutation.mutate({
              kind: "criterion_attest",
              binding: { criterion: row.criterion, subjectRef: { kind: "agent", id: agentId }, item: row.item },
              result,
              evidenceRefs: evidence.slice(0, 50),
              ...(note.trim() ? { note: note.trim() } : {}),
            });
          }}
        >
          <fieldset className="space-y-1">
            <legend className="text-sm text-text-primary">Does this work meet the criterion?</legend>
            {(["satisfied", "unsatisfied"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={groupName}
                  value={value}
                  checked={result === value}
                  onChange={() => setResult(value)}
                  className="accent-foreground"
                />
                {value === "satisfied" ? "Meets it" : "Does not meet it"}
              </label>
            ))}
          </fieldset>
          <label htmlFor={noteId} className="block text-sm text-text-primary">
            Note (optional)
          </label>
          <Textarea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} rows={2} />
          {evidenceMissing ? (
            <p className="text-sm text-text-secondary">
              There is no ledger record to cite for this item yet, so it can't be attested here.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={mutation.isPending || evidence.length === 0}>
              {mutation.isPending ? "Recording…" : "Record attestation"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Attest criterion
        </Button>
      )}
      <DispositionStatus message={message} error={error} />
    </div>
  );
}

function CaseRowItem({
  row,
  contract,
  permissions,
  companyId,
  agentId,
  onOpenEvent,
}: {
  row: AgentCaseRow;
  contract: AgentCardContractSummary;
  permissions: AgentCardViewerPermissions;
  companyId: string;
  agentId: string;
  onOpenEvent: (eventId: string) => void;
}) {
  const criterion = row.criterion ? criterionFromContract(contract, row.criterion) : null;
  const fact = row.section === "acceptance" && row.fact ? ACCEPTANCE_FACT_TEXT[row.fact] : undefined;
  const canConfirmUse =
    permissions.canConfirmUse &&
    Boolean(row.item) &&
    ((row.section === "acceptance" && row.fact === "use" && row.state !== "pass") ||
      (row.section === "obligations" && (row.state === "delivered_on_time" || row.state === "delivered_late")));
  const canAttest =
    row.section === "quality" &&
    row.criterion !== null &&
    row.item !== null &&
    row.judge !== "person" &&
    permissions.attestableCriteria.includes(evaluationCriterionRefKey(row.criterion));
  return (
    <li className="space-y-2 rounded-md border border-border-soft px-3 py-2 text-sm" data-testid="agent-case-row">
      <div className="flex flex-wrap items-center gap-2">
        <WorkItemLink item={row.item} label={row.itemLabel} />
        <Badge variant="outline" className="whitespace-normal text-left">
          <span className="font-normal text-text-secondary">State:</span> {caseStateText(row.state)}
        </Badge>
        {isUnbound(row) ? (
          <Badge variant="secondary" className="whitespace-normal text-left" data-testid="agent-case-unbound">
            {UNBOUND_TEXT}
          </Badge>
        ) : null}
      </div>
      <p className="text-text-secondary">
        {ROLE_TEXT[row.role]}
        {row.judge ? ` · judged by ${JUDGE_TEXT[row.judge].toLowerCase()}` : ""}
        {row.responsibilityKey ? ` · responsibility ${row.responsibilityKey}` : row.section === "obligations" ? " · no responsibility" : ""}
        {" · "}
        {formatDateTime(row.at)}
      </p>
      {fact ? <p className="text-text-primary">{fact}</p> : null}
      {row.criterion ? (
        <p className="text-text-primary">
          Criterion: {criterion?.text ?? row.criterion.criterionId}
        </p>
      ) : null}
      {row.note && !fact ? <p className="text-text-secondary">{row.note}</p> : null}
      <EvidenceRefs refs={row.evidenceRefs} onOpen={onOpenEvent} />
      {canConfirmUse ? <ConfirmUseAction companyId={companyId} agentId={agentId} row={row} /> : null}
      {canAttest ? (
        <AttestAction
          companyId={companyId}
          agentId={agentId}
          row={row as AgentCaseRow & { criterion: NonNullable<AgentCaseRow["criterion"]>; item: NonNullable<AgentCaseRow["item"]> }}
        />
      ) : null}
    </li>
  );
}

export function AgentCaseDrilldown({
  regionId,
  companyId,
  agentId,
  version,
  target,
  contract,
  permissions,
  onClose,
  onOpenEvent,
}: {
  regionId: string;
  companyId: string;
  agentId: string;
  version: number;
  target: CaseDrillTarget;
  contract: AgentCardContractSummary;
  /** The card's `viewer` flags. */
  permissions: AgentCardViewerPermissions;
  onClose: () => void;
  onOpenEvent: (eventId: string) => void;
}) {
  const [state, setState] = useState<AgentCaseRow["state"] | "">(target.state ?? "");
  const headingId = `${regionId}-heading`;
  const filterId = `${regionId}-state`;
  const filter: AgentCaseFilter = {
    version,
    section: target.section,
    ...(target.responsibility ? { responsibility: target.responsibility } : {}),
    ...(target.fact ? { fact: target.fact } : {}),
    ...(target.criterion ? { criterion: target.criterion } : {}),
    ...(target.judge ? { judge: target.judge } : {}),
    ...(state ? { state } : {}),
    limit: AGENT_CASES_PAGE_SIZE,
  };
  const query = useInfiniteQuery({
    queryKey: agentPerformanceQueryKeys.cases(companyId, agentId, filter),
    queryFn: ({ pageParam }) => agentPerformanceApi.cases(companyId, agentId, { ...filter, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.rows);
  const total = pages[0]?.total ?? 0;
  const restricted = pages[0]?.restricted ?? false;

  return (
    <section
      id={regionId}
      aria-labelledby={headingId}
      className="space-y-3 rounded-md border border-border-soft bg-surface-sunken px-3 py-3"
      data-testid="agent-case-drilldown"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 id={headingId} className="text-sm font-medium text-text-primary">
          Cases: {target.label}
        </h4>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close cases
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={filterId} className="text-text-secondary">
          State
        </label>
        <select
          id={filterId}
          value={state}
          onChange={(event) => setState(event.target.value as AgentCaseRow["state"] | "")}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          data-testid="agent-case-state-filter"
        >
          <option value="">All states</option>
          {caseStatesFor(target.section).map((value) => (
            <option key={value} value={value}>
              {caseStateText(value)}
            </option>
          ))}
        </select>
      </div>
      <div aria-live="polite" className="space-y-2">
        {query.isLoading ? (
          <p role="status" className="text-sm text-text-secondary">
            Loading cases…
          </p>
        ) : query.error ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load the cases: {apiErrorMessage(query.error)}
          </p>
        ) : (
          <>
            <p className="text-sm text-text-secondary" data-testid="agent-case-total">
              {`${total} ${total === 1 ? "case" : "cases"}.`}
              {restricted ? " Only cases you can read are listed and counted." : ""}
            </p>
            {rows.length === 0 ? (
              <EmptyNote>No cases match.</EmptyNote>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => (
                  <CaseRowItem
                    key={row.caseId}
                    row={row}
                    contract={contract}
                    permissions={permissions}
                    companyId={companyId}
                    agentId={agentId}
                    onOpenEvent={onOpenEvent}
                  />
                ))}
              </ul>
            )}
            {query.hasNextPage ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading more…" : "Show more cases"}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

