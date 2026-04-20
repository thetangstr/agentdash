// AgentDash: TierBadge
// Small pill that surfaces the company's current tier. Used in the
// Billing page, Settings surface, and anywhere we need a glance-level
// signal of the active plan.

import type { Tier } from "@agentdash/shared";

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

const TIER_STYLE: Record<Tier, string> = {
  free: "border-muted-foreground/30 bg-muted text-muted-foreground",
  pro: "border-primary/40 bg-primary/10 text-primary",
  enterprise: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

interface TierBadgeProps {
  tier: Tier;
  className?: string;
}

export function TierBadge({ tier, className }: TierBadgeProps) {
  const base =
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";
  return (
    <span
      className={[base, TIER_STYLE[tier], className ?? ""].join(" ").trim()}
      data-testid="tier-badge"
      data-tier={tier}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}
