// AgentDash: UX-2 (#783) — one work product: what shipped, where, by whom, at what cost.
import type { ShippedWorkProduct } from "@paperclipai/shared";
import { useState } from "react";
import { Coins, ExternalLink, FileText, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { useIsPhone } from "../hooks/useIsPhone";
import { Link } from "@/lib/router";
import { cn, issueUrl } from "../lib/utils";
import { shortenInstancePaths } from "../lib/instancePaths";
import { timeAgo } from "../lib/timeAgo";
import {
  TOKENS_COUNTED_NOTE,
  formatShippedUsage,
  LOCAL_FILE_NOTE,
  isLocalFileWorkProduct,
  workProductDisplayTitle,
  workProductHref,
  workProductState,
  workProductTimestamp,
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

export function WorkProductStateBadge({
  product,
  className,
}: {
  product: Pick<ShippedWorkProduct, "type" | "status"> & { createdAt?: Date | string | null; issue?: { status?: string | null } | null };
  className?: string;
}) {
  const state = workProductState(product);
  return (
    <span
      data-testid="work-product-state"
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shrink-0 max-sm:text-xs",
        TONE_CLASSES[state.tone],
        className,
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

/**
 * The phone card: title (two lines at most) and state on one row, then
 * "issue · agent · time" on one truncated line. Usage sits behind a tap so the
 * card stays two lines tall.
 */
function CompactShippedWorkProductRow({ product, showUsage }: { product: ShippedWorkProduct; showUsage: boolean }) {
  const [usageOpen, setUsageOpen] = useState(false);
  const target = workProductHref(product, issueUrl(product.issue));
  const titleHref = target?.external ? target.href : null;
  const internalHref = target && !target.external ? target.href : issueUrl(product.issue);
  const meta = [
    product.issue.identifier ?? product.issue.title,
    product.agent?.name ?? null,
    timeAgo(workProductTimestamp(product)),
  ].filter((part): part is string => Boolean(part));
  return (
    <div className="flex items-start gap-2 py-1 pl-3 pr-1" data-testid="shipped-row" data-compact="true">
      <span className="pt-3">
        <ProductIcon product={product} />
      </span>
      <div className="min-w-0 flex-1 py-2">
        <div className="flex items-start gap-2">
          {titleHref ? (
            <a
              href={titleHref}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 text-sm font-medium leading-5 hover:underline max-sm:-my-3 max-sm:py-3"
              data-testid="shipped-title"
            >
              {/* The clamp lives inside so the phone padding (44px hit area) never shows a third line. */}
              <span className="line-clamp-2">{workProductDisplayTitle(product.title)}</span>
            </a>
          ) : (
            <Link
              to={internalHref}
              className="min-w-0 flex-1 text-sm font-medium leading-5 hover:underline max-sm:-my-3 max-sm:py-3"
              data-testid="shipped-title"
            >
              {/* The clamp lives inside so the phone padding (44px hit area) never shows a third line. */}
              <span className="line-clamp-2">{workProductDisplayTitle(product.title)}</span>
            </Link>
          )}
          <WorkProductStateBadge product={product} className="text-xs" />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="shipped-meta">
          {meta.join(" · ")}
        </p>
        {!target && isLocalFileWorkProduct(product) ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="work-product-local-note">{LOCAL_FILE_NOTE}</p>
        ) : null}
        {showUsage && usageOpen ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="shipped-usage" title={TOKENS_COUNTED_NOTE}>
            {formatShippedUsage(product.usage)}
          </p>
        ) : null}
      </div>
      {showUsage ? (
        <button
          type="button"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            usageOpen && "bg-accent text-foreground",
          )}
          aria-expanded={usageOpen}
          aria-label={usageOpen ? "Hide tokens" : "Show tokens"}
          data-testid="shipped-usage-toggle"
          onClick={() => setUsageOpen((open) => !open)}
        >
          <Coins className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ShippedWorkProductRow({
  product,
  showIssue = true,
  showUsage = true,
  compactOnPhone = false,
}: {
  product: ShippedWorkProduct;
  showIssue?: boolean;
  showUsage?: boolean;
  /** AgentDash: mobile lists — render the compact card on phones (Shipped, Home). */
  compactOnPhone?: boolean;
}) {
  const isPhone = useIsPhone();
  if (compactOnPhone && isPhone) {
    return <CompactShippedWorkProductRow product={product} showUsage={showUsage} />;
  }
  // AgentDash (Scan 3 lane I): http(s) opens in a new tab; a local file the
  // server read in opens its issue document; a file: URL opens nothing.
  const target = workProductHref(product, issueUrl(product.issue));
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 max-sm:gap-2 max-sm:py-2" data-testid="shipped-row">
      <ProductIcon product={product} />
      <div className="min-w-0 flex-1 space-y-0.5">
        {/* AgentDash: phones keep title + state on one line (title truncates). */}
        <div className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap">
          {target?.external ? (
            <a
              href={target.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
              data-testid="shipped-title"
            >
              <span className="truncate">{workProductDisplayTitle(product.title)}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          ) : target ? (
            <Link
              to={target.href}
              className="inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:underline"
              data-testid="shipped-title"
            >
              <span className="truncate">{workProductDisplayTitle(product.title)}</span>
            </Link>
          ) : (
            <span className="truncate text-sm font-medium" data-testid="shipped-title">{workProductDisplayTitle(product.title)}</span>
          )}
          <WorkProductStateBadge product={product} />
        </div>
        {!target && isLocalFileWorkProduct(product) ? (
          <p className="text-xs text-muted-foreground" data-testid="work-product-local-note">{LOCAL_FILE_NOTE}</p>
        ) : null}
        {product.summary && !target?.external ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{shortenInstancePaths(product.summary)}</p>
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
          <span title={new Date(workProductTimestamp(product)).toLocaleString()}>{timeAgo(workProductTimestamp(product))}</span>
          {showUsage ? (
            <>
              <span aria-hidden>·</span>
              <span data-testid="shipped-usage" title={TOKENS_COUNTED_NOTE}>
                {formatShippedUsage(product.usage)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
