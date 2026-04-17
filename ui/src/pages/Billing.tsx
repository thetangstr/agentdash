// AgentDash: Billing page
// Surfaces the company's current tier, limits, and feature matrix. The CTA
// to upgrade opens the shared UpgradeDialog and currently routes to sales;
// Phase 3 wires this to a Stripe checkout session.

import { useState } from "react";
import {
  TIERS,
  entitlementsForTier,
  type Tier,
} from "@agentdash/shared";
import { useEntitlements } from "../hooks/useEntitlements";
import { TierBadge } from "../components/TierBadge";
import { UpgradeDialog } from "../components/UpgradeDialog";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

const FEATURE_ROWS: Array<{
  key: "hubspotSync" | "autoResearch" | "assessMode" | "prioritySupport";
  label: string;
}> = [
  { key: "hubspotSync", label: "HubSpot bi-directional sync" },
  { key: "autoResearch", label: "AutoResearch agents" },
  { key: "assessMode", label: "Assess mode" },
  { key: "prioritySupport", label: "Priority support" },
];

function nextTier(tier: Tier): Tier | null {
  const idx = TIERS.indexOf(tier);
  if (idx === -1 || idx === TIERS.length - 1) return null;
  return TIERS[idx + 1];
}

export function Billing() {
  const { tier, entitlements, isLoading } = useEntitlements();
  const [dialogOpen, setDialogOpen] = useState(false);
  const upgradeTarget = nextTier(tier);

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6"
      data-testid="billing-page"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Plan & billing</h1>
          <p className="text-sm text-muted-foreground">
            Your workspace is on the{" "}
            <span className="font-medium text-foreground">
              {TIER_LABEL[tier]}
            </span>{" "}
            plan.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TierBadge tier={tier} />
          {upgradeTarget && (
            <Button
              onClick={() => setDialogOpen(true)}
              data-testid="billing-upgrade"
            >
              Upgrade to {TIER_LABEL[upgradeTarget]}
            </Button>
          )}
        </div>
      </header>

      <section
        className="rounded-md border border-border bg-card p-4"
        data-testid="billing-limits"
      >
        <h2 className="text-sm font-semibold">Current limits</h2>
        {isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Agents
              </dt>
              <dd className="text-lg font-medium">
                {entitlements.limits.agents.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Actions / month
              </dt>
              <dd className="text-lg font-medium">
                {entitlements.limits.monthlyActions.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Pipelines
              </dt>
              <dd className="text-lg font-medium">
                {entitlements.limits.pipelines.toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm" data-testid="billing-matrix">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-2 font-medium">Feature</th>
              {TIERS.map((t) => (
                <th
                  key={t}
                  className="px-4 py-2 text-center font-medium"
                  data-tier-column={t}
                >
                  {TIER_LABEL[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURE_ROWS.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{row.label}</td>
                {TIERS.map((t) => {
                  const enabled = entitlementsForTier(t).features[row.key];
                  return (
                    <td
                      key={t}
                      className="px-4 py-2 text-center"
                      data-testid={`matrix-${row.key}-${t}`}
                    >
                      {enabled ? (
                        <Check
                          className="mx-auto h-4 w-4 text-emerald-600 dark:text-emerald-400"
                          aria-label="included"
                        />
                      ) : (
                        <X
                          className="mx-auto h-4 w-4 text-muted-foreground"
                          aria-label="not included"
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {upgradeTarget && (
        <UpgradeDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          currentTier={tier}
          requiredTier={upgradeTarget}
        />
      )}
    </div>
  );
}
