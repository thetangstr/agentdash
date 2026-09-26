// AgentDash: UX-2 (#783) — one work product: what shipped, where, by whom, at what cost.
import type { ShippedWorkProduct } from "@paperclipai/shared";
import { ExternalLink, FileText, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { Link } from "@/lib/router";
import { cn, issueUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import {
  formatShippedUsage,
  workProductState,
  workProductTypeLabel,
  type WorkProductStateTone,
} from "../lib/shipped";

const TONE_CLASSES: Record<WorkProductStateTone, string> = {
  open: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  merged: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  closed: "bg-muted text-muted-foreground",
  draft: "bg-muted text-muted-foreground",
  neutral: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function WorkProductStateBadge({ product }: { product: Pick<ShippedWorkProduct, "type" | "status"> }) {
  const state = workProductState(product);
  return (
    <span
      data-testid="work-product-state"
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shrink-0",
        TONE_CLASSES[state.tone],
      )}
    >
      {state.label}
    </span>
  );
}

function ProductIcon({ product }: { product: ShippedWorkProduct }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (product.type !== "pull_request") return <FileText className={className} />;
  const tone = workProductState(product).tone;
  if (tone === "merged") return <GitMerge className={className} />;
  if (tone === "closed") return <GitPullRequestClosed className={className} />;
  return <GitPullRequest className={className} />;
}

export function ShippedWorkProductRow({
  product,
  showIssue = true,
  showUsage = true,
}: {
  product: ShippedWorkProduct;
  showIssue?: boolean;
  showUsage?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5" data-testid="shipped-row">
      <ProductIcon product={product} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          {product.url ? (
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
            >
              <span className="truncate">{product.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <span className="truncate text-sm font-medium">{product.title}</span>
          )}
          <WorkProductStateBadge product={product} />
        </div>
        {product.summary && !product.url ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{product.summary}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{workProductTypeLabel(product.type)}</span>
          {showIssue ? (
            <>
              <span aria-hidden>·</span>
              <Link to={issueUrl(product.issue)} className="hover:underline">
                {product.issue.identifier ? `${product.issue.identifier} ` : ""}
                {product.issue.title}
              </Link>
            </>
          ) : null}
          {product.agent ? (
            <>
              <span aria-hidden>·</span>
              <span>{product.agent.name}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span title={new Date(product.createdAt).toLocaleString()}>{timeAgo(product.createdAt)}</span>
          {showUsage ? (
            <>
              <span aria-hidden>·</span>
              <span data-testid="shipped-usage">{formatShippedUsage(product.usage)}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
