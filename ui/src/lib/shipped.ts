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

/** A one-word state people recognise: open / merged / closed / draft for PRs. */
export function workProductState(product: Pick<IssueWorkProduct, "type" | "status">): {
  label: string;
  tone: WorkProductStateTone;
} {
  const status = (product.status ?? "").toLowerCase();
  if (status === "merged") return { label: "merged", tone: "merged" };
  if (status === "closed" || status === "archived") return { label: "closed", tone: "closed" };
  if (status === "failed") return { label: "failed", tone: "closed" };
  if (status === "draft") return { label: "draft", tone: "draft" };
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
