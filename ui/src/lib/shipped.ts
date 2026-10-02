// AgentDash: UX-2 (#783) — shared formatting for work products ("what shipped").
import type { IssueWorkProduct, ShippedIssueUsage } from "@paperclipai/shared";
import { formatCents, formatTokens } from "./utils";

export const NOT_METERED_LABEL = "not metered yet";

/**
 * Usage for the runs on one issue, or a month. Never renders "0" for an issue
 * that has no metering at all: that reads as "free", which is a lie.
 */
export function formatShippedUsage(usage: ShippedIssueUsage | null | undefined): string {
  if (!usage || !usage.metered) return NOT_METERED_LABEL;
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = [`${formatTokens(tokens)} tokens`];
  if (usage.costCents > 0) parts.push(formatCents(usage.costCents));
  return parts.join(" · ");
}

export type WorkProductStateTone = "open" | "merged" | "closed" | "draft" | "neutral";

/** Statuses that mean the work was withdrawn or sent back, so a done issue does not make them accepted. */
const NOT_SHIPPED_STATUSES = new Set(["closed", "archived", "failed", "draft", "changes_requested"]);

/**
 * AgentDash (Scan 3 lane I): accepted = approved, merged, or on an issue that
 * is done (work accepted before acceptance was recorded on the product). The
 * server's `accepted=true` Shipped filter uses the same rule.
 */
export function isWorkProductAccepted(
  product: Pick<IssueWorkProduct, "status"> & { issue?: { status?: string | null } | null },
): boolean {
  const status = (product.status ?? "").toLowerCase();
  if (status === "approved" || status === "merged") return true;
  return product.issue?.status === "done" && !NOT_SHIPPED_STATUSES.has(status);
}

/**
 * Where a work product opens. Only http(s) links leave the app. A local file
 * the server read into an issue document opens that document. A file: URL or
 * anything else opens nothing: it would show a path from the agent's machine.
 */
export function workProductHref(
  product: Pick<IssueWorkProduct, "url" | "metadata">,
  issueHref: string,
): { href: string; external: boolean } | null {
  const documentKey = product.metadata && typeof product.metadata.documentKey === "string"
    ? product.metadata.documentKey
    : null;
  if (documentKey) return { href: `${issueHref}#document-${encodeURIComponent(documentKey)}`, external: false };
  const url = product.url?.trim() ?? "";
  if (/^https?:\/\//i.test(url)) return { href: url, external: true };
  return null;
}

/** A one-word state people recognise: open / merged / closed / draft for PRs. */
export function workProductState(
  product: Pick<IssueWorkProduct, "type" | "status"> & { issue?: { status?: string | null } | null },
): {
  label: string;
  tone: WorkProductStateTone;
} {
  const status = (product.status ?? "").toLowerCase();
  if (status === "merged") return { label: "merged", tone: "merged" };
  if (status === "closed" || status === "archived") return { label: "closed", tone: "closed" };
  if (status === "failed") return { label: "failed", tone: "closed" };
  if (status === "draft") return { label: "draft", tone: "draft" };
  if (status === "changes_requested") return { label: "changes requested", tone: "draft" };
  // AgentDash (MVP launch lane B): a board user accepting the issue records
  // its reviewed work products as approved; the person-facing word is
  // "accepted". Scan 3 lane I: so is anything on an issue that is done.
  if (isWorkProductAccepted(product)) return { label: "accepted", tone: "open" };
  if (product.type === "pull_request") return { label: "open", tone: "open" };
  return { label: status.replace(/_/g, " ") || "active", tone: "neutral" };
}

const TYPE_LABELS: Record<string, string> = {
  pull_request: "Pull request",
  branch: "Branch",
  commit: "Commit",
  preview_url: "Preview",
  runtime_service: "Service",
  artifact: "Artifact",
  document: "Document",
};

export function workProductTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}
