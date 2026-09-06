import { useEffect, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { ExceptionRecord, ScoredCard } from "@paperclipai/shared";
import { evaluationApi } from "@/api/evaluation";
import { ApiError } from "@/api/client";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfidenceBadge, EventDrawer, EvidenceRefs, fmtDate, MarkerList, routeWords, ScoreValue, SeverityBadge, useEventDrawer } from "./shared";

/**
 * AgentDash: Company Evaluator — founder view (mandate, Milestone 4 item 3):
 * only decisions, material risk and exceptions. No operating rows, no
 * per-agent numbers, no ranking.
 */
export function EvaluationFounder() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const drawer = useEventDrawer();
  const companyId = selectedCompanyId!;

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Company", href: "/dashboard" }, { label: "Evaluation", href: "/evaluation" }, { label: "Founder view" }]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const overview = useQuery({
    queryKey: queryKeys.evaluation.overview(companyId),
    queryFn: () => evaluationApi.overview(companyId),
    enabled: !!selectedCompanyId,
  });
  const withCards = overview.data?.milestones.filter((m) => m.latest) ?? [];
  const cards = useQueries({
    queries: withCards.map((m) => ({
      queryKey: queryKeys.evaluation.latest(companyId, m.ref.kind, m.ref.id, false),
      queryFn: () => evaluationApi.latest(companyId, m.ref),
    })),
  });
  // newest first, so a truncated list loses the oldest decisions, never the ones waiting now
  const decisions = useQuery({
    queryKey: queryKeys.evaluation.events(companyId, "evaluation.correction,evaluation.disposition", "desc"),
    queryFn: () => evaluationApi.events(companyId, { type: "evaluation.correction,evaluation.disposition", limit: 1000, order: "desc" }),
    enabled: !!selectedCompanyId,
  });

  const { pendingCorrections, rejectedCorrections } = useMemo(() => {
    const events = decisions.data?.events ?? [];
    const decided = new Map<string, string>();
    for (const e of events) {
      if (e.eventType !== "evaluation.disposition") continue;
      const p = e.payload as { kind?: string; correctionEventId?: string; decision?: string };
      if (p.kind === "correction_decided" && p.correctionEventId) decided.set(p.correctionEventId, p.decision ?? "decided");
    }
    const corrections = events.filter((e) => e.eventType === "evaluation.correction");
    return {
      pendingCorrections: corrections.filter((e) => !decided.has(e.id)),
      // §9.4: every rejected correction stays visible here without a second filing
      rejectedCorrections: corrections.filter((e) => decided.get(e.id) === "rejected"),
    };
  }, [decisions.data]);
  const cardsPending = cards.some((q) => q.isPending);
  const cardsFailed = cards.filter((q) => q.isError).length;

  if (!selectedCompanyId) return <div className="text-sm text-muted-foreground">Select a company to view its evaluation.</div>;
  const error = overview.error ?? decisions.error;

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Founder view</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Only what needs you: decisions waiting, material risk on the cards, and the exceptions raised for your view. Everything else stays on the <Link to="/evaluation" className="underline underline-offset-2">dashboard</Link>.
        </p>
      </div>

      {overview.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error instanceof ApiError && error.status === 403 ? "You do not have permission to view this company's evaluation." : error instanceof Error ? error.message : "Failed to load."}</div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Decisions waiting</CardTitle>
              <CardDescription>Corrections filed by humans that no disposition has decided yet. A manager or you decides; an administrator records it.</CardDescription>
            </CardHeader>
            <CardContent>
              {pendingCorrections.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {pendingCorrections.map((c) => {
                    const p = c.payload as { disputedEventId?: string; claimedFact?: string };
                    return (
                      <li key={c.id} className="rounded border border-border-soft p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">Correction filed {fmtDate(c.eventTime)}</span>
                          <EvidenceRefs refs={[c.id, ...(p.disputedEventId ? [p.disputedEventId] : [])]} onOpen={drawer.open} />
                        </div>
                        <p className="mt-1 text-muted-foreground">{p.claimedFact ?? "no claim recorded"}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {rejectedCorrections.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Rejected corrections</CardTitle>
                <CardDescription>Corrections a manager or you rejected; they stay here without a second filing.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {rejectedCorrections.map((c) => {
                    const p = c.payload as { disputedEventId?: string; claimedFact?: string };
                    return (
                      <li key={c.id} className="rounded border border-border-soft p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">Correction filed {fmtDate(c.eventTime)} — rejected</span>
                          <EvidenceRefs refs={[c.id, ...(p.disputedEventId ? [p.disputedEventId] : [])]} onOpen={drawer.open} />
                        </div>
                        <p className="mt-1 text-muted-foreground">{p.claimedFact ?? "no claim recorded"}</p>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Material risk</CardTitle>
              <CardDescription>Per milestone: the outcome score with its confidence, and the markers that limit what the card can claim.</CardDescription>
            </CardHeader>
            <CardContent>
              {withCards.length === 0 ? (
                <p className="text-sm text-muted-foreground">No cards stored yet.</p>
              ) : (
                <ul className="space-y-3">
                  {[...withCards]
                    // a withheld score is the highest-attention case: it comes first
                    .map((m, i) => ({ m, i }))
                    .sort((a, b) => Number(b.m.latest!.outcome.score == null) - Number(a.m.latest!.outcome.score == null) || a.i - b.i)
                    .map(({ m, i }) => (
                    <li key={`${m.ref.kind}:${m.ref.id}`} className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft pb-3 last:border-b-0 last:pb-0" data-testid={`risk-${m.ref.id}`}>
                      <div>
                        <Link to={`/evaluation/${m.ref.kind}/${m.ref.id}`} className="font-medium hover:underline">{m.name}</Link>
                        <div className="mt-1"><MarkerList markers={m.latest!.markers} /></div>
                        {(cards[i]?.data?.latest?.card?.contract?.exceptions ?? []).length > 0 ? (
                          <p className="mt-1 text-xs" data-testid={`acceptance-${m.ref.id}`}>
                            <span className="font-medium">Your acceptance is required:</span> {cards[i]!.data!.latest!.card.contract.exceptions.join("; ")}
                          </p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <ScoreValue score={m.latest!.outcome.score} reason={m.latest!.outcome.reason} className="text-2xl" />
                        <div className="mt-1"><ConfidenceBadge tier={m.latest!.outcome.confidence} /></div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Exceptions for your view</CardTitle>
              <CardDescription>Immediate and material exceptions, and any routed to the founder view, across the latest cards.</CardDescription>
            </CardHeader>
            <CardContent>
              {cardsPending ? (
                <p className="text-sm text-muted-foreground" data-testid="founder-exceptions-loading">Loading the latest cards…</p>
              ) : (
                <>
                  {cardsFailed > 0 ? (
                    <p className="mb-2 text-sm text-destructive" data-testid="founder-exceptions-failed">{cardsFailed} of {withCards.length} cards could not be loaded; this list is incomplete.</p>
                  ) : null}
                  <FounderExceptions cards={cards.map((q) => q.data?.latest?.card ?? null)} refs={withCards.map((m) => `${m.ref.kind}:${m.ref.id}`)} names={withCards.map((m) => m.name)} onOpen={drawer.open} />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <EventDrawer companyId={companyId} eventId={drawer.eventId} onClose={drawer.close} />
    </div>
  );
}

function FounderExceptions({ cards, refs, names, onOpen }: { cards: Array<ScoredCard | null>; refs: string[]; names: string[]; onOpen: (id: string) => void }) {
  const rows: Array<{ milestone: string; refKey: string; e: ExceptionRecord }> = [];
  cards.forEach((card, i) => {
    for (const e of card?.exceptions ?? []) {
      if (e.severity === "immediate" || e.severity === "material" || e.routing?.founderView) rows.push({ milestone: names[i] ?? "", refKey: refs[i] ?? String(i), e });
    }
  });
  rows.sort((a, b) => (a.e.severity === b.e.severity ? (a.e.raisedAt < b.e.raisedAt ? 1 : -1) : a.e.severity === "immediate" ? -1 : b.e.severity === "immediate" ? 1 : a.e.severity === "material" ? -1 : 1));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">None on the latest cards.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {rows.map(({ milestone, refKey, e }) => (
        <li key={`${refKey}:${e.key}`} className="rounded border border-border-soft p-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={e.severity} />
            <span className="font-medium">{e.title}</span>
            <span className="text-muted-foreground">· {milestone} · {e.subject.identifier ?? e.subject.kind}</span>
          </div>
          <p className="mt-1 text-muted-foreground">{e.note}</p>
          <p className="mt-1 text-xs text-muted-foreground">routed to: {routeWords(e.routes, "founder")}</p>
          <div className="mt-1"><EvidenceRefs refs={e.evidenceRefs} onOpen={onOpen} /></div>
        </li>
      ))}
    </ul>
  );
}
