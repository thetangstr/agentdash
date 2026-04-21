// AgentDash: Billing page
// Surfaces the company's current tier, limits, and feature matrix. The CTA
// to upgrade opens the shared UpgradeDialog which routes to Stripe Checkout.

import { useState } from "react";
import {
  TIERS,
  entitlementsForTier,
  type Tier,
} from "@agentdash/shared";
import { useEntitlements } from "../hooks/useEntitlements";
import { TierBadge } from "../components/TierBadge";
import { UpgradeDialog } from "../components/UpgradeDialog";
import { LuxePageHeader } from "../components/LuxePageHeader";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { billingApi } from "../api/billing";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";

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
  const { tier, entitlements, isLoading, stripeCustomerId, subscriptionStatus, currentPeriodEnd } = useEntitlements();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPortalRedirecting, setIsPortalRedirecting] = useState(false);
  const upgradeTarget = nextTier(tier);

  async function handleManageSubscription() {
    if (!selectedCompanyId) return;
    setIsPortalRedirecting(true);
    try {
      const { url } = await billingApi.createPortalSession(selectedCompanyId);
      window.location.href = url;
    } catch (err) {
      setIsPortalRedirecting(false);
      pushToast({
        tone: "error",
        title: "Could not open billing portal",
        body: err instanceof Error ? err.message : "Please try again.",
      });
    }
  }

  const renewalDateLabel = (() => {
    if (!currentPeriodEnd) return null;
    const d = new Date(currentPeriodEnd);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  })();

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6"
      data-testid="billing-page"
    >
      {subscriptionStatus === "past_due" && (
        <div
          className="rounded-md border border-yellow-400 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-600 dark:bg-yellow-950 dark:text-yellow-200"
          data-testid="billing-past-due-banner"
        >
          <strong>Payment past due.</strong> Please update your payment method to avoid service interruption.
        </div>
      )}

      {subscriptionStatus === "canceled" && (
        <div
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
          data-testid="billing-canceled-banner"
        >
          <strong>Subscription canceled</strong>
          {renewalDateLabel ? ` — access ends ${renewalDateLabel}.` : "."}
        </div>
      )}

      <header className="flex items-start justify-between gap-4">
        <LuxePageHeader
          eyebrow="Billing"
          title={<>Plan &amp; <span className="soft">billing</span></>}
          subtitle={
            <>
              Your workspace is on the{" "}
              <span className="font-medium text-foreground">{TIER_LABEL[tier]}</span> plan.
              {subscriptionStatus === "active" && renewalDateLabel && (
                <span className="ml-2 text-muted-foreground" data-testid="billing-renewal-date">
                  Renews on {renewalDateLabel}.
                </span>
              )}
            </>
          }
          slim
        />
        <div className="flex items-center gap-2">
          <TierBadge tier={tier} />
          {stripeCustomerId && (
            <Button
              variant="outline"
              onClick={handleManageSubscription}
              disabled={isPortalRedirecting}
              data-testid="billing-manage-subscription"
            >
              {isPortalRedirecting ? "Opening…" : "Manage Subscription"}
            </Button>
          )}
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
