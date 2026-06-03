// AgentDash (AGE-123): Run ledger + monthly receipt page.
// Adds a "Runs" tab to the Costs page showing each agent-run in plain English,
// with CSV export and a monthly receipt summary card.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ReceiptText, Users, Zap } from "lucide-react";
import { agentRunsApi, type LedgerRow } from "../api/agent-runs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents, relativeTime, formatTokens } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";

const PAGE_SIZE = 50;
const NO_COMPANY = "__none__";

// ---------------------------------------------------------------------------
// Receipt card
// ---------------------------------------------------------------------------

function MonthlyReceiptCard({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.agentRunReceipt(companyId),
    queryFn: () => agentRunsApi.receipt(companyId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="px-5 py-8 text-sm text-muted-foreground">
          Loading receipt...
        </CardContent>
      </Card>
    );
  }

  if (!data || !data.quota) {
    return (
      <Card>
        <CardContent className="px-5 py-8 text-sm text-muted-foreground">
          No quota data available.
        </CardContent>
      </Card>
    );
  }

  const { quota, summary, activeAgentCount } = data;
  const usagePercent = quota.includedRuns > 0
    ? Math.min(100, Math.round((quota.usedRuns / quota.includedRuns) * 100))
    : 0;
  const barColor =
    usagePercent > 90 ? "bg-red-400" : usagePercent > 70 ? "bg-yellow-400" : "bg-emerald-400";

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ReceiptText className="h-4 w-4" />
          Monthly receipt
        </CardTitle>
        <CardDescription>
          Your team ({activeAgentCount} agent{activeAgentCount !== 1 ? "s" : ""}) completed{" "}
          {summary.total.toLocaleString()} task{summary.total !== 1 ? "s" : ""} using{" "}
          {quota.usedRuns.toLocaleString()} of {quota.includedRuns.toLocaleString()} included runs.{" "}
          {quota.overageRuns > 0
            ? `${quota.overageRuns.toLocaleString()} overage run${quota.overageRuns !== 1 ? "s" : ""}.`
            : "0 overage runs."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-2">
        {/* Usage bar */}
        <div className="space-y-2">
          <div className="h-2.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full transition-[width] duration-300", barColor)}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{quota.usedRuns.toLocaleString()} used</span>
            <span>{quota.remainingRuns.toLocaleString()} remaining</span>
          </div>
        </div>

        {/* Metric tiles */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="border border-border rounded-md p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="h-3 w-3" />
              Runs used
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {quota.usedRuns.toLocaleString()}
            </div>
          </div>
          <div className="border border-border rounded-md p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              Active agents
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {activeAgentCount}
            </div>
          </div>
          <div className="border border-border rounded-md p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ReceiptText className="h-3 w-3" />
              Plan
            </div>
            <div className="mt-1 text-lg font-semibold">
              {quota.tier}
            </div>
          </div>
        </div>

        {/* Complexity breakdown */}
        {summary.total > 0 ? (
          <div className="text-xs text-muted-foreground">
            Breakdown: {summary.simple} simple, {summary.medium} medium, {summary.complex} complex
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Complexity badge
// ---------------------------------------------------------------------------

function ComplexityBadge({ tier }: { tier: string }) {
  const style =
    tier === "complex"
      ? "border-red-300 text-red-700 bg-red-50 dark:border-red-800 dark:text-red-300 dark:bg-red-950"
      : tier === "medium"
        ? "border-yellow-300 text-yellow-700 bg-yellow-50 dark:border-yellow-800 dark:text-yellow-300 dark:bg-yellow-950"
        : "border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:bg-emerald-950";
  return (
    <span className={cn("inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium", style)}>
      {tier}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ledger row description
// ---------------------------------------------------------------------------

function runDescription(row: LedgerRow): string {
  const task = row.issueTitle ? `'${row.issueTitle}'` : "a task";
  return `Agent ${row.agentName} completed ${task} (${row.complexityTier})`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RunLedger() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<"desc" | "asc">("desc");

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs", href: "/costs" }, { label: "Runs" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? NO_COMPANY;

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agentRunLedger(companyId, undefined, undefined, PAGE_SIZE, offset, sort),
    queryFn: () => agentRunsApi.ledger(companyId, { limit: PAGE_SIZE, offset, sort }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  useEffect(() => {
    setOffset(0);
  }, [companyId, sort]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Zap} message="Select a company to view the run ledger." />;
  }

  function handleExportCsv() {
    if (!selectedCompanyId) return;
    const url = agentRunsApi.csvUrl(selectedCompanyId);
    window.open(url, "_blank");
  }

  const total = data?.total ?? 0;
  const pageStart = offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      {/* Receipt card */}
      <MonthlyReceiptCard companyId={companyId} />

      {/* Ledger */}
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Run ledger</CardTitle>
              <CardDescription>
                Each completed agent run in plain English. {total > 0 ? `${total.toLocaleString()} total runs.` : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSort(sort === "desc" ? "asc" : "desc")}
              >
                {sort === "desc" ? "Newest first" : "Oldest first"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={total === 0}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-5 pb-5 pt-2">
          {isLoading ? (
            <PageSkeleton variant="costs" />
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : !data || data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No agent runs recorded yet. Runs appear here as agents complete tasks.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                {data.rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-3 border border-border rounded-md px-4 py-3 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground">{runDescription(row)}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {relativeTime(row.completedAt)}
                        {row.durationMs != null ? ` · ${(row.durationMs / 60_000).toFixed(1)}min` : ""}
                        {row.tokenCount > 0 ? ` · ${formatTokens(row.tokenCount)} tokens` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <ComplexityBadge tier={row.complexityTier} />
                      <span className="font-medium tabular-nums text-sm">
                        {formatCents(row.costCents)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {total > PAGE_SIZE ? (
                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Showing {pageStart}–{pageEnd} of {total.toLocaleString()}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!data.hasMore}
                      onClick={() => setOffset(offset + PAGE_SIZE)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
