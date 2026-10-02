// AgentDash: UX-2 (#783) — shared formatting for work products ("what shipped").
import type { IssueWorkProduct, ShippedIssueUsage } from "@paperclipai/shared";
import { formatCents } from "./utils";
import { countedTokens, formatCountedTokens } from "./token-figures";

export { TOKENS_COUNTED_NOTE } from "./token-figures";

export const NOT_METERED_LABEL = "not metered yet";

/**
 * Usage for the runs on one issue, or a month. Never renders "0" for an issue
 * that has no metering at all: that reads as "free", which is a lie.
 */
export function formatShippedUsage(usage: ShippedIssueUsage | null | undefined): string {
  if (!usage || !usage.metered) return NOT_METERED_LABEL;
  // One definition with Home and the run page: input + output, no cache reads.
  const parts = [formatCountedTokens(countedTokens(usage))];
  if (usage.costCents > 0) parts.push(formatCents(usage.costCents));
  return parts.join(" · ");
}

export type WorkProductStateTone = "open" | "merged" | "closed" | "draft" | "neutral";

/** Statuses that mean the work was withdrawn or sent back, so a done issue does not make them accepted. */
const NOT_SHIPPED_STATUSES = new Set(["closed", "archived", "failed", "draft", "changes_requested"]);

/**
 * AgentDash (Scan 3 lane I): work recorded before this instant predates
 * acceptance being written onto work products; only for that work does "the
 * issue is done" count as accepted. Same constant as the server's
 * ACCEPTANCE_RECORDED_SINCE.
 */
export const ACCEPTANCE_RECORDED_SINCE = Date.parse("2026-10-02T00:00:00.000Z");

/**
 * AgentDash (Scan 3 lane I): accepted = approved, merged, or (for work
 * recorded before ACCEPTANCE_RECORDED_SINCE) on an issue that is done. The
 * server's `accepted=true` Shipped filter uses the same rule.
 */
export function isWorkProductAccepted(
  product: Pick<IssueWorkProduct, "status"> & {
    createdAt?: Date | string | null;
    metadata?: Record<string, unknown> | null;
    issue?: { status?: string | null } | null;
  },
): boolean {
  const status = (product.status ?? "").toLowerCase();
  if (status === "approved" || status === "merged") return true;
  // AgentDash (Scan 4 lane M): work that went through Request changes is
  // shipped only by an explicit acceptance, even if it predates the cutoff.
  if (product.metadata && "changesRequestedAt" in product.metadata) return false;
  const createdAt = product.createdAt ? new Date(product.createdAt).getTime() : Number.NaN;
  const legacy = Number.isFinite(createdAt) && createdAt < ACCEPTANCE_RECORDED_SINCE;
  return legacy && product.issue?.status === "done" && !NOT_SHIPPED_STATUSES.has(status);
}

/** A deliverable the agent saved on its own machine (a file: URL or provider "local"). */
export function isLocalFileWorkProduct(product: Pick<IssueWorkProduct, "url" | "provider">): boolean {
  return /^file:/i.test(product.url?.trim() ?? "") || (product.provider ?? "").toLowerCase() === "local";
}

export const LOCAL_FILE_NOTE = "The agent saved this on its computer. Ask it to attach the content.";

/** A title that is an absolute path or a file: URL shows as its file name. */
export function workProductDisplayTitle(title: string): string {
  const trimmed = title.trim();
  const looksLikePath = /^file:/i.test(trimmed) || (/^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed) && !/\s/.test(trimmed));
  if (!looksLikePath) return title;
  const base = trimmed.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(base) || "Deliverable";
  } catch {
    return base || "Deliverable";
  }
}

/**
 * Where a work product opens. Only http(s) links leave the app. A work product
 * that names an issue document (`metadata.documentKey`) opens that document on
 * its issue. A file: URL or anything else opens nothing: it would show a path
 * from the agent's machine.
 */
export function workProductHref(
  product: Pick<IssueWorkProduct, "url" | "metadata">,
  issueHref: string,
): { href: string; external: boolean } | null {
  const documentKey = product.metadata && typeof product.metadata.documentKey === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(product.metadata.documentKey)
    ? product.metadata.documentKey
    : null;
  if (documentKey) return { href: `${issueHref}#document-${encodeURIComponent(documentKey)}`, external: false };
  const url = product.url?.trim() ?? "";
  if (/^https?:\/\//i.test(url)) return { href: url, external: true };
  return null;
}

/** A one-word state people recognise: open / merged / closed / draft for PRs. */
export function workProductState(
  product: Pick<IssueWorkProduct, "type" | "status"> & { createdAt?: Date | string | null; issue?: { status?: string | null } | null },
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
