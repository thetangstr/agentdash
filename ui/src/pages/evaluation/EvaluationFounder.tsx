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
import { ConfidenceBadge, EventDrawer, EvidenceRefs, fmtDate, MarkerList, ScoreValue, SeverityBadge, useEventDrawer } from "./shared";

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
  const decisions = useQuery({
    queryKey: queryKeys.evaluation.events(companyId, "evaluation.correction,evaluation.disposition"),
    queryFn: () => evaluationApi.events(companyId, { type: "evaluation.correction,evaluation.disposition", limit: 1000 }),
    enabled: !!selectedCompanyId,
  });

  const pendingCorrections = useMemo(() => {
    const events = decisions.data?.events ?? [];
    const decided = new Set(
      events
        .filter((e) => e.eventType === "evaluation.disposition" && (e.payload as { kind?: string }).kind === "correction_decided")
        .map((e) => String((e.payload as { correctionEventId?: string }).correctionEventId ?? "")),
    );
    return events.filter((e) => e.eventType === "evaluation.correction" && !decided.has(e.id));
  }, [decisions.data]);

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
                    const p = c.payload as { disputedEventId?: string; claimedFact?: string; filedBy?: string };
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
                  {withCards.map((m) => (
                    <li key={`${m.ref.kind}:${m.ref.id}`} className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft pb-3 last:border-b-0 last:pb-0">
                      <div>
                        <Link to={`/evaluation/${m.ref.kind}/${m.ref.id}`} className="font-medium hover:underline">{m.name}</Link>
                        <div className="mt-1"><MarkerList markers={m.latest!.markers} /></div>
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
              <FounderExceptions cards={cards.map((q) => q.data?.latest?.card ?? null)} names={withCards.map((m) => m.name)} onOpen={drawer.open} />
            </CardContent>
          </Card>
        </div>
      )}
      <EventDrawer companyId={companyId} eventId={drawer.eventId} onClose={drawer.close} />
    </div>
  );
}

function FounderExceptions({ cards, names, onOpen }: { cards: Array<ScoredCard | null>; names: string[]; onOpen: (id: string) => void }) {
  const rows: Array<{ milestone: string; e: ExceptionRecord }> = [];
  cards.forEach((card, i) => {
    for (const e of card?.exceptions ?? []) {
      if (e.severity === "immediate" || e.severity === "material" || e.routing?.founderView) rows.push({ milestone: names[i] ?? "", e });
    }
  });
  rows.sort((a, b) => (a.e.severity === b.e.severity ? (a.e.raisedAt < b.e.raisedAt ? 1 : -1) : a.e.severity === "immediate" ? -1 : b.e.severity === "immediate" ? 1 : a.e.severity === "material" ? -1 : 1));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">None on the latest cards.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {rows.map(({ milestone, e }) => (
        <li key={`${milestone}:${e.key}`} className="rounded border border-border-soft p-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={e.severity} />
            <span className="font-medium">{e.id} {e.title}</span>
            <span className="text-muted-foreground">· {milestone} · {e.subject.identifier ?? e.subject.kind}</span>
          </div>
          <p className="mt-1 text-muted-foreground">{e.note}</p>
          <div className="mt-1"><EvidenceRefs refs={e.evidenceRefs} onOpen={onOpen} /></div>
        </li>
      ))}
    </ul>
  );
}
