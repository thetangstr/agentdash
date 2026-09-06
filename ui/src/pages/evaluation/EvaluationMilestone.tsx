import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { ActorRow, EvaluationMilestoneRef, ExceptionRecord, MetricResult, ScoredCard } from "@paperclipai/shared";
import { evaluationApi } from "@/api/evaluation";
import { accessApi } from "@/api/access";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useParams } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { actorDisplayName, compositeDescription, ConfidenceBadge, EventDrawer, EvidenceRefs, excludedLine, fmtDate, fmtPct, includedLine, MarkerList, metricName, MetricsTable, routeWords, ScoreValue, SeverityBadge, useEventDrawer } from "./shared";
import type { ScorecardVerifyResult } from "@/api/evaluation";

/**
 * AgentDash: Company Evaluator — one milestone's card (Milestone 4 drill-down).
 * Scorecard, operating rows, exceptions, review items, the ledger window and the
 * stored versions. Every number links to its formula and to the events behind
 * it; agents are listed by name, never ranked; administrators may verify,
 * replay and store a snapshot — the only writes on this page.
 */

const TABS = ["scorecard", "operating", "exceptions", "review-items", "ledger", "versions"] as const;
type Tab = (typeof TABS)[number];

export function EvaluationMilestone() {
  const { kind, id, tab } = useParams<{ kind: string; id: string; tab?: string }>();
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const drawer = useEventDrawer();
  const companyId = selectedCompanyId!;
  const ref = useMemo<EvaluationMilestoneRef | null>(() => (kind === "project" || kind === "goal") && id ? { kind, id } : null, [kind, id]);
  const activeTab: Tab = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "scorecard";
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [replayRequested, setReplayRequested] = useState(false);
  const [ledgerType, setLedgerType] = useState<string | null>(null);

  const latest = useQuery({
    queryKey: queryKeys.evaluation.latest(companyId, ref?.kind ?? "", ref?.id ?? "", false),
    queryFn: () => evaluationApi.latest(companyId, ref!, false),
    enabled: !!selectedCompanyId && !!ref,
  });
  const card: ScoredCard | null = latest.data?.latest?.card ?? null;
  // a card stored before the scoring engine (Milestone 1 digest) has no composite, metrics or exceptions to render
  const scored = !!card && !!card.outcomeComposite && Array.isArray(card.actors) && Array.isArray(card.exceptions);
  const name = card?.milestoneName ?? `${ref?.kind ?? ""} ${ref?.id?.slice(0, 8) ?? ""}`;

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Company", href: "/dashboard" }, { label: "Evaluation", href: "/evaluation" }, { label: name }]);
  }, [selectedCompany?.name, setBreadcrumbs, name]);
  // results of one milestone's verify or snapshot never show on another
  useEffect(() => {
    setVerifyResult(null);
    setReplayRequested(false);
    snapshot.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.kind, ref?.id]);

  const versions = useQuery({
    queryKey: queryKeys.evaluation.versions(companyId, ref?.kind ?? "", ref?.id ?? ""),
    queryFn: () => evaluationApi.versions(companyId, ref!),
    enabled: !!selectedCompanyId && !!ref && activeTab === "versions",
  });
  const overview = useQuery({
    queryKey: queryKeys.evaluation.overview(companyId),
    queryFn: () => evaluationApi.overview(companyId),
    enabled: !!selectedCompanyId && activeTab === "review-items",
  });
  const reviewProjectId = overview.data?.reviewProjectId ?? null;
  const reviewItems = useQuery({
    queryKey: ["evaluation", companyId, "review-items", reviewProjectId ?? ""],
    queryFn: () => issuesApi.list(companyId, { projectId: reviewProjectId! }),
    enabled: !!selectedCompanyId && !!reviewProjectId && activeTab === "review-items",
  });
  // the rows tagged with this milestone, cut at the card's sequence, newest first — the drill-down behind the card's window
  const throughSeq = card ? Number(card.throughSeq) : undefined;
  const ledger = useQuery({
    queryKey: queryKeys.evaluation.events(companyId, ledgerType, ref ? `${ref.kind}:${ref.id}:${throughSeq ?? "live"}` : null),
    queryFn: () => evaluationApi.events(companyId, { type: ledgerType ?? undefined, limit: 500, ref: ref!, throughSeq, order: "desc" }),
    enabled: !!selectedCompanyId && !!ref && activeTab === "ledger" && !!card,
  });
  // administrator-only offers; the server gates the actions themselves, so a 403 here simply means "not an administrator"
  const wantsAdminOffers = activeTab === "versions" || (!!latest.data && !latest.data.latest) || (!!card && !scored);
  const access = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: !!selectedCompanyId && wantsAdminOffers,
    retry: false,
  });
  const isAdmin = access.data?.access.currentUserRole === "admin";
  const runVerify = async () => {
    if (!ref) return;
    setVerifying(true);
    try {
      const r = await evaluationApi.latest(companyId, ref, true);
      const v: ScorecardVerifyResult | null = r.verify;
      setVerifyResult(v ? { ok: v.ok, reason: v.reason } : { ok: false, reason: "no stored card to verify" });
    } catch (err) {
      setVerifyResult({ ok: false, reason: err instanceof Error ? err.message : "verification failed" });
    } finally {
      setVerifying(false);
    }
  };
  const replay = useQuery({
    queryKey: queryKeys.evaluation.replay(companyId, ref?.kind ?? "", ref?.id ?? ""),
    queryFn: () => evaluationApi.replay(companyId, ref!),
    enabled: !!selectedCompanyId && !!ref && replayRequested && isAdmin,
  });
  const snapshot = useMutation({
    mutationFn: () => evaluationApi.snapshot(companyId, ref!, true),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evaluation", companyId] });
    },
  });

  if (!selectedCompanyId) return <div className="text-sm text-muted-foreground">Select a company to view its evaluation.</div>;
  if (!ref) return <div className="text-sm text-destructive">Unknown milestone reference.</div>;

  const onTab = (value: string) => navigate(`/evaluation/${ref.kind}/${ref.id}${value === "scorecard" ? "" : `/${value}`}`);

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{name}</h1>
          <Badge variant="ghost">{ref.kind}</Badge>
          {latest.data?.latest ? <Badge variant="outline">card v{latest.data.latest.version}</Badge> : null}
        </div>
        {card ? <MarkerList markers={card.markers} /> : null}
      </div>

      <Tabs value={activeTab} onValueChange={onTab}>
        <PageTabBar
          items={[
            { value: "scorecard", label: "Scorecard" },
            { value: "operating", label: "Operating" },
            { value: "exceptions", label: `Exceptions${card ? ` (${card.exceptionsTotal})` : ""}` },
            { value: "review-items", label: "Review items" },
            { value: "ledger", label: "Ledger" },
            { value: "versions", label: "Versions" },
          ]}
          align="start"
          value={activeTab}
          onValueChange={onTab}
        />
      </Tabs>

      {latest.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading card…</div>
      ) : latest.error ? (
        <div className="text-sm text-destructive">{latest.error instanceof ApiError && latest.error.status === 403 ? "You do not have permission to view this card." : latest.error instanceof Error ? latest.error.message : "Failed to load the card."}</div>
      ) : !card ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">No card stored for this milestone yet. Snapshots come from the shadow cadence or from an administrator.</p>
          {isAdmin ? (
            <Button size="sm" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>{snapshot.isPending ? "Storing…" : "Store a card and raise its review items"}</Button>
          ) : null}
          {isAdmin ? <p className="text-xs text-muted-foreground">Storing a card also creates or updates the evaluator's review items for humans — the one write this page offers, and only to administrators.</p> : null}
          {snapshot.error ? <p className="text-sm text-destructive">{snapshot.error instanceof Error ? snapshot.error.message : "Snapshot failed."}</p> : null}
        </div>
      ) : !scored ? (
        <div className="space-y-2" data-testid="unscored-card">
          <p className="text-sm text-muted-foreground">This card (implementation {card.formulaVersion}) predates the scoring engine: it is a ledger digest with no metrics, composite or exceptions to show. A new version scores it.</p>
          <p className="text-xs text-muted-foreground">{card.eventCount} events through sequence {card.throughSeq}.</p>
          {isAdmin ? (
            <>
              <Button size="sm" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>{snapshot.isPending ? "Storing…" : "Store a new version and raise review items"}</Button>
              <p className="text-xs text-muted-foreground">Storing a version also creates or updates the evaluator's review items for humans; it never touches reviewed work.</p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">An administrator can store a new version.</p>
          )}
          {snapshot.error ? <p className="text-sm text-destructive">{snapshot.error instanceof Error ? snapshot.error.message : "Snapshot failed."}</p> : null}
        </div>
      ) : activeTab === "scorecard" ? (
        <ScorecardTab card={card} onOpenEvent={drawer.open} />
      ) : activeTab === "operating" ? (
        <OperatingTab card={card} onOpenEvent={drawer.open} />
      ) : activeTab === "exceptions" ? (
        <ExceptionsTab card={card} onOpenEvent={drawer.open} />
      ) : activeTab === "review-items" ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Items the evaluator raised for humans, in its own project. Closing one is the human's decision; nothing here touches reviewed work.</p>
          {overview.isLoading || reviewItems.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !reviewProjectId ? (
            <p className="text-sm text-muted-foreground">No review items yet: the review-items project is created with the first exception.</p>
          ) : (reviewItems.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">The review-items project is empty.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="py-1.5">Item</th><th>Status</th><th>Priority</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {(reviewItems.data ?? []).map((it) => (
                  <tr key={it.id} className="border-t border-border-soft">
                    <td className="py-1.5"><Link to={`/issues/${it.id}`} className="hover:underline">{it.title}</Link></td>
                    <td><StatusBadge status={it.status} /></td>
                    <td className="text-muted-foreground">{it.priority}</td>
                    <td className="text-muted-foreground">{fmtDate(it.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : activeTab === "ledger" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="text-muted-foreground" htmlFor="ledger-type">Event type</label>
            <select id="ledger-type" className="rounded border border-border-soft bg-background px-2 py-1 text-sm" value={ledgerType ?? ""} onChange={(e) => setLedgerType(e.target.value || null)}>
              <option value="">all types in the window</option>
              {Object.keys(card.byType ?? {}).sort().map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {ledger.data ? `${ledger.data.count} ${ledger.data.count === 1 ? "event" : "events"} tagged with this ${ref.kind} through sequence ${card.throughSeq}, newest first${ledger.data.count >= 500 ? " (first 500)" : ""}` : ""}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            The card's window counted {card.eventCount} events, including company-level records (roster snapshots, refusals, findings) that carry no milestone tag and are not listed here; the type list comes from the card's window.
          </p>
          {ledger.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading events…</p>
          ) : ledger.error ? (
            <p className="text-sm text-destructive">{ledger.error instanceof Error ? ledger.error.message : "Failed to load events."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="py-1.5">Time</th><th>Type</th><th>Actor</th><th>Source</th><th>Event</th></tr>
              </thead>
              <tbody>
                {(ledger.data?.events ?? []).map((e) => (
                  <tr key={e.id} className="border-t border-border-soft">
                    <td className="py-1.5 whitespace-nowrap text-muted-foreground">{fmtDate(e.eventTime)}</td>
                    <td className="font-mono text-xs">{e.eventType}</td>
                    <td className="font-mono text-xs text-muted-foreground">{e.actorType}{e.actorId ? ` ${e.actorId.slice(0, 8)}` : ""}</td>
                    <td className="font-mono text-xs text-muted-foreground">{e.sourceTable}</td>
                    <td><button type="button" className="font-mono text-xs underline underline-offset-2" onClick={() => drawer.open(e.id)}>{e.id.slice(0, 8)}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {isAdmin ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void runVerify()} disabled={verifying}>{verifying ? "Verifying…" : "Verify latest against a replay"}</Button>
                <Button size="sm" variant="outline" onClick={() => setReplayRequested(true)} disabled={replay.isFetching}>Replay now</Button>
                <Button size="sm" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>{snapshot.isPending ? "Storing…" : "Store a new version and raise review items"}</Button>
              </div>
              <p className="text-xs text-muted-foreground">Storing a version also creates or updates the evaluator's review items for humans; it never touches reviewed work.</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Verification, replay and snapshots are administrator actions.</p>
          )}
          {verifyResult ? (
            <p className="text-sm" data-testid="verify-result">
              {verifyResult.ok ? "Replay agrees with the stored card byte for byte." : `Replay does not agree: ${verifyResult.reason ?? "hash mismatch"}.`}
            </p>
          ) : null}
          {snapshot.data ? (
            <p className="text-sm" data-testid="snapshot-result">
              Stored version {snapshot.data.stored.version}
              {snapshot.data.reviewItems && !("error" in snapshot.data.reviewItems) ? `; review items: ${snapshot.data.reviewItems.created.length} created, ${snapshot.data.reviewItems.updated.length} updated, ${snapshot.data.reviewItems.closed.length} left closed` : ""}.
            </p>
          ) : null}
          {replay.data ? (
            <p className="text-sm">
              Replay hash <span className="font-mono">{replay.data.hash.slice(0, 12)}</span> {latest.data?.latest && replay.data.hash === latest.data.latest.cardHash ? "matches" : "differs from"} the stored <span className="font-mono">{latest.data?.latest?.cardHash.slice(0, 12)}</span> through sequence {String(replay.data.throughSeq)}.
            </p>
          ) : replay.error ? (
            <p className="text-sm text-destructive">{replay.error instanceof Error ? replay.error.message : "Replay failed."}</p>
          ) : null}
          {snapshot.error ? <p className="text-sm text-destructive">{snapshot.error instanceof Error ? snapshot.error.message : "Snapshot failed."}</p> : null}
          {versions.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading versions…</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="py-1.5">Version</th><th>Stored</th><th>Outcome</th><th>Confidence</th><th>Exceptions</th><th>Card engine</th><th>Contract</th><th>Through</th><th>Hash</th></tr>
              </thead>
              <tbody>
                {[...(versions.data?.versions ?? [])].reverse().map((v) => (
                  <tr key={v.version} className="border-t border-border-soft">
                    <td className="py-1.5 tabular-nums">v{v.version}</td>
                    <td className="text-muted-foreground">{fmtDate(v.storedAt)}</td>
                    <td className="tabular-nums">{v.outcome.score == null ? <span className="text-xs text-muted-foreground">withheld</span> : Math.round(v.outcome.score)}</td>
                    <td><ConfidenceBadge tier={v.outcome.confidence} /></td>
                    <td className="tabular-nums">{v.exceptionsTotal}</td>
                    <td className="font-mono text-xs">{v.formulaVersion}</td>
                    <td className="font-mono text-xs">{v.contractVersion}</td>
                    <td className="tabular-nums">{v.throughSeq}</td>
                    <td className="font-mono text-xs text-muted-foreground" title={v.cardHash}>{v.cardHash.slice(0, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <EventDrawer companyId={companyId} eventId={drawer.eventId} onClose={drawer.close} />
    </div>
  );
}

function ScorecardTab({ card, onOpenEvent }: { card: ScoredCard; onOpenEvent: (id: string) => void }) {
  const c = card.outcomeComposite;
  const metrics = Object.values(card.outcome ?? {}).filter((m): m is MetricResult => !!m).sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outcome score</CardTitle>
            <CardDescription>{compositeDescription(c, "outcome")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <ScoreValue score={c?.score} reason={c?.guard?.reason} />
              <ConfidenceBadge tier={c?.confidence} />
              {c?.coverage != null ? <span className="text-xs text-muted-foreground">coverage {fmtPct(c.coverage)}</span> : null}
            </div>
            {c?.guard?.reasons?.length ? (
              <ul className="list-disc pl-4 text-xs text-muted-foreground" data-testid="guard-reasons">
                {c.guard.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            {c?.included?.length ? (
              <p className="text-xs text-muted-foreground">Included: {includedLine(c)}.</p>
            ) : null}
            {c?.excluded?.length ? (
              <p className="text-xs text-muted-foreground">Excluded: {excludedLine(c)}.</p>
            ) : null}
            {c?.flags?.length ? <p className="text-xs text-destructive">Flags: {c.flags.join("; ")}.</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Contract and window</CardTitle>
            <CardDescription>What the card was judged against and what it could see.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Contract</dt>
              <dd>{card.contract.source} · {card.contract.contractVersion}{card.contract.declaredAt ? ` · declared ${fmtDate(card.contract.declaredAt)}` : ""}</dd>
              <dt className="text-muted-foreground">Criteria</dt>
              <dd>{card.contract.criteriaCount} declared, {card.contract.measurableCriteria} measurable</dd>
              <dt className="text-muted-foreground">Required evidence</dt>
              <dd>{card.contract.requiredEvidence.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">Target date</dt>
              <dd>{card.contract.targetDate ?? "none set"}</dd>
              <dt className="text-muted-foreground">Items</dt>
              <dd>{card.membership.items} in scope · {card.membership.done} done · {card.membership.open} open · {card.membership.cancelled} cancelled</dd>
              <dt className="text-muted-foreground">Window</dt>
              <dd>{card.eventCount} events, {fmtDate(card.firstEventTime)} to {fmtDate(card.lastEventTime)} · as of {fmtDate(card.asOf)}</dd>
              <dt className="text-muted-foreground">Ingest lag</dt>
              <dd>up to {Math.round(card.maxIngestLagMs / 60000)} minutes</dd>
              {card.missingSources.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">Missing sources</dt>
                  <dd>{card.missingSources.join("; ")}</dd>
                </>
              ) : null}
              {card.contract.exceptions.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">Weak contract</dt>
                  <dd>{card.contract.exceptions.join("; ")}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Outcome metrics</h2>
        <p className="text-xs text-muted-foreground">Open a row for its formula, breakdown and the events behind it. Nothing is shown at the insufficient tier except the words.</p>
        <MetricsTable metrics={metrics} onOpenEvent={onOpenEvent} />
      </div>
      {card.excludedMetrics.length > 0 ? (
        <p className="text-xs text-muted-foreground">Not in any composite: {card.excludedMetrics.map((x) => `${metricName(x.key)} (${x.scope}) — ${x.reason}`).join("; ")}.</p>
      ) : null}
    </div>
  );
}

function OperatingTab({ card, onOpenEvent }: { card: ScoredCard; onOpenEvent: (id: string) => void }) {
  const agentsRows = card.actors.filter((a) => a.actorType === "agent").sort((a, b) => actorDisplayName(a).localeCompare(actorDisplayName(b)) || a.actorKey.localeCompare(b.actorKey));
  const companyRows = card.actors.filter((a) => a.actorType !== "agent");
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" data-testid="not-a-ranking">
        Agents are listed by name. Each operating score is a coverage-weighted mean shown with its confidence and the share of records it rests on; work difficulty is not normalised beyond that, so this is not a ranking and must not be read as one.
      </p>
      {agentsRows.length === 0 ? <p className="text-sm text-muted-foreground">No agent operating rows on this card.</p> : agentsRows.map((row) => <ActorCard key={row.actorKey} row={row} onOpenEvent={onOpenEvent} />)}
      {companyRows.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Owed by the company or the platform</h2>
          {companyRows.map((row) => (
            <ActorCard key={row.actorKey} row={row} onOpenEvent={onOpenEvent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActorCard({ row, onOpenEvent }: { row: ActorRow; onOpenEvent: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const metrics = Object.values(row.metrics ?? {}).filter((m): m is MetricResult => !!m).sort((a, b) => a.key.localeCompare(b.key));
  const c = row.composite;
  return (
    <Card data-testid={`actor-${row.actorKey}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span title={row.actorId ?? undefined}>{actorDisplayName(row)}</span>
          <span className="flex items-center gap-2">
            {c ? (
              <>
                <ScoreValue score={c.score} reason={c.guard?.reason} className="text-xl" />
                <ConfidenceBadge tier={c.confidence} />
                {c.coverage != null ? <span className="text-xs text-muted-foreground">coverage {fmtPct(c.coverage)}</span> : null}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">no operating score</span>
            )}
          </span>
        </CardTitle>
        <CardDescription>
          {c ? compositeDescription(c, "operating") : "No operating composite: fewer than three metrics have evidence for this row."}
          {c?.included?.length ? ` Included: ${includedLine(c)}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide metrics" : `Show ${metrics.length} metrics`}</Button>
        {open ? (
          <div className="mt-3 space-y-2">
            {c?.guard?.reasons?.length ? <p className="text-xs text-muted-foreground">Score withheld: {c.guard.reasons.join("; ")}.</p> : null}
            {c?.excluded?.length ? <p className="text-xs text-muted-foreground">Excluded: {excludedLine(c)}.</p> : null}
            <MetricsTable metrics={metrics} onOpenEvent={onOpenEvent} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExceptionsTab({ card, onOpenEvent }: { card: ScoredCard; onOpenEvent: (id: string) => void }) {
  const groups: Array<[ExceptionRecord["severity"], ExceptionRecord[]]> = (["immediate", "material", "routine"] as const).map((s) => [s, card.exceptions.filter((e) => e.severity === s)]);
  if (card.exceptions.length === 0) return <p className="text-sm text-muted-foreground">No exceptions on this card.</p>;
  return (
    <div className="space-y-6">
      {card.exceptionsTotal > card.exceptions.length ? (
        <p className="text-xs text-muted-foreground">{card.exceptionsTotal} exceptions in total; the card carries the first {card.exceptions.length}, immediate and material first.</p>
      ) : null}
      {groups.map(([severity, list]) =>
        list.length === 0 ? null : (
          <div key={severity} className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-medium"><SeverityBadge severity={severity} /> {list.length}</h2>
            <ul className="space-y-2">
              {list.map((e) => (
                <li key={e.key} className="rounded border border-border-soft p-3 text-sm" data-testid={`exception-${e.key}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.id} {e.title}</span>
                    <span className="text-muted-foreground">· {e.subject.kind} {e.subject.identifier ?? ""}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDate(e.raisedAt)}</span>
                  </div>
                  <p className="mt-1">{e.note}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>routed to: {routeWords(e.routes, "milestone")}</span>
                    {e.markers.length > 0 ? <span>{e.markers.join("; ")}</span> : null}
                  </div>
                  <div className="mt-1"><EvidenceRefs refs={e.evidenceRefs} onOpen={onOpenEvent} /></div>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}
