import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { EvaluationMilestoneSummary } from "@paperclipai/shared";
import { evaluationApi } from "@/api/evaluation";
import { ApiError } from "@/api/client";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfidenceBadge, fmtCents, fmtDate, fmtPct, MarkerList, ScoreValue, Sparkline } from "./shared";

/**
 * AgentDash: Company Evaluator — Milestone 4 dashboard. One card per milestone
 * with what its latest stored card says: outcome score with confidence and
 * coverage (or the words for why it is withheld), the trend over versions,
 * exceptions by severity, interventions, metered cost and the card's markers.
 * Milestones are ordered by card recency, never by score.
 */
export function EvaluationOverviewPage() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Company", href: "/dashboard" }, { label: "Evaluation" }]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.evaluation.overview(selectedCompanyId!),
    queryFn: () => evaluationApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <div className="text-sm text-muted-foreground">Select a company to view its evaluation.</div>;

  const withCards = data?.milestones.filter((m) => m.latest) ?? [];
  const withoutCards = data?.milestones.filter((m) => !m.latest) ?? [];

  return (
    <div className="max-w-6xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Evaluation</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What the Company Evaluator's stored cards say about each milestone. Every number carries its confidence and coverage, links to its formula and to the ledger events behind it. Stage 1 is shadow mode: the evaluator records and escalates, it changes nothing.
        </p>
        {data ? (
          <p className="text-xs text-muted-foreground">
            {data.principal.provisioned ? "Evaluator principal provisioned." : "No evaluator principal provisioned yet; cards come from administrators."} Ledger at sequence {data.ledger.maxSeq}.{" "}
            <Link to="/evaluation/founder" className="underline underline-offset-2">Founder view</Link>
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading cards…</div>
      ) : error ? (
        <div className="text-sm text-destructive">
          {error instanceof ApiError && error.status === 403 ? "You do not have permission to view this company's evaluation." : error instanceof Error ? error.message : "Failed to load the evaluation."}
        </div>
      ) : data ? (
        <div className="space-y-8">
          {withCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cards stored yet. Snapshots come from the shadow cadence or from an administrator.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {withCards.map((m) => (
                <MilestoneCard key={`${m.ref.kind}:${m.ref.id}`} milestone={m} />
              ))}
            </div>
          )}
          {withoutCards.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">Without a card yet</h2>
              <ul className="flex flex-wrap gap-2">
                {withoutCards.map((m) => (
                  <li key={`${m.ref.kind}:${m.ref.id}`}>
                    <Badge variant="ghost">{m.ref.kind} · {m.name}{m.status ? ` · ${m.status.replace(/_/g, " ")}` : ""}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MilestoneCard({ milestone: m }: { milestone: EvaluationMilestoneSummary }) {
  const latest = m.latest!;
  const ex = latest.exceptions;
  return (
    <Card data-testid={`milestone-${m.ref.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <Link to={`/evaluation/${m.ref.kind}/${m.ref.id}`} className="hover:underline">{m.name}</Link>
          <Badge variant="ghost">{m.ref.kind}{m.status ? ` · ${m.status.replace(/_/g, " ")}` : ""}</Badge>
        </CardTitle>
        <CardDescription>Card v{latest.version} stored {fmtDate(latest.storedAt)} · implementation {latest.formulaVersion}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Outcome score</div>
            <ScoreValue score={latest.outcome.score} reason={latest.outcome.reason} />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <ConfidenceBadge tier={latest.outcome.confidence} />
              {latest.outcome.coverage != null ? <span title="share of the included weight resting on decidable records">coverage {fmtPct(latest.outcome.coverage)}</span> : null}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Trend</div>
            <Link to={`/evaluation/${m.ref.kind}/${m.ref.id}/versions`} title="Open the stored versions"><Sparkline points={latest.trend} /></Link>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Exceptions</dt>
            <dd className="tabular-nums">
              {ex.total}
              <span className="block text-xs text-muted-foreground">{ex.immediate} immediate · {ex.material} material · {ex.routine} routine</span>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Interventions</dt>
            <dd className="tabular-nums">
              {latest.interventions == null ? (
                <span className="text-xs text-muted-foreground">not on this card</span>
              ) : (
                <>
                  {latest.interventions.count}
                  <span className="block text-xs text-muted-foreground">
                    across {latest.interventions.population} agent-owned {latest.interventions.population === 1 ? "item" : "items"} that reached review or done
                    {latest.interventions.caveat ? ` · ${latest.interventions.caveat}` : ""}
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Metered cost</dt>
            <dd className="tabular-nums">
              {latest.cost == null ? (
                <span className="text-xs text-muted-foreground">not on this card</span>
              ) : (
                <>
                  {fmtCents(latest.cost.cents)}
                  <span className="block text-xs text-muted-foreground">
                    {latest.cost.runs > 0 ? `metered on ${latest.cost.meteredRuns} of ${latest.cost.runs} runs` : "no runs"}
                    {latest.cost.runs > 0 && latest.cost.meteredRuns < latest.cost.runs ? " — the rest is unmetered, not free" : ""}
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>
        <div className="text-xs text-muted-foreground">
          {latest.operatingActors} {latest.operatingActors === 1 ? "agent" : "agents"} with an operating score · {latest.missingSources} {latest.missingSources === 1 ? "source" : "sources"} missing from this window
        </div>
        <MarkerList markers={latest.markers} />
      </CardContent>
    </Card>
  );
}
