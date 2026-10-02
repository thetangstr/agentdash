// AgentDash: UX-2 (#783) — "Result" on issue detail: what this issue produced.
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { TOKENS_COUNTED_NOTE, formatShippedUsage } from "../lib/shipped";
import { ShippedWorkProductRow } from "./ShippedWorkProductRow";

export function IssueResultBlock({ companyId, issueId }: { companyId: string; issueId: string }) {
  // Same block for every company (one UX).
  const { data } = useQuery({
    queryKey: queryKeys.shipped(companyId, { issueId }),
    queryFn: () => issuesApi.listShipped(companyId, { issueId }),
  });
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  const usage = items[0]!.usage;
  return (
    <section
      aria-label="Result"
      data-testid="issue-result-block"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 max-sm:py-1.5">
        <h3 className="text-sm font-medium">Result</h3>
        <span className="text-xs text-muted-foreground" title={TOKENS_COUNTED_NOTE}>
          {formatShippedUsage(usage)}
        </span>
      </div>
      <div className="divide-y divide-border">
        {items.map((product) => (
          <ShippedWorkProductRow key={product.id} product={product} showIssue={false} showUsage={false} />
        ))}
      </div>
    </section>
  );
}
