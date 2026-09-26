// AgentDash: UX-2 (#783) — "Result" on issue detail: what this issue produced.
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { formatShippedUsage } from "../lib/shipped";
import { ShippedWorkProductRow } from "./ShippedWorkProductRow";

export function IssueResultBlock({ companyId, issueId }: { companyId: string; issueId: string }) {
  // Default profile only: an agentdash_mk company keeps issue detail as it was.
  const { selectedCompany } = useCompany();
  const enabled = selectedCompany?.productProfile !== "agentdash_mk";
  const { data } = useQuery({
    queryKey: queryKeys.shipped(companyId, { issueId }),
    queryFn: () => issuesApi.listShipped(companyId, { issueId }),
    enabled,
  });
  const items = data?.items ?? [];
  if (!enabled || items.length === 0) return null;
  const usage = items[0]!.usage;
  return (
    <section
      aria-label="Result"
      data-testid="issue-result-block"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">Result</h3>
        <span className="text-xs text-muted-foreground">{formatShippedUsage(usage)}</span>
      </div>
      <div className="divide-y divide-border">
        {items.map((product) => (
          <ShippedWorkProductRow key={product.id} product={product} showIssue={false} showUsage={false} />
        ))}
      </div>
    </section>
  );
}
