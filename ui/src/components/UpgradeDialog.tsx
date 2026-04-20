// AgentDash: UpgradeDialog
// Generic upgrade prompt shown wherever a gated feature requires a higher tier.
// Phase 2: CTA is "Contact sales" — Phase 3 replaces this with a Stripe
// checkout redirect routed through packages/billing.

import { entitlementsForTier, type Tier } from "@agentdash/shared";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

const FEATURE_LABEL: Record<string, string> = {
  hubspotSync: "HubSpot bi-directional sync",
  autoResearch: "AutoResearch agents",
  assessMode: "Assess mode",
  prioritySupport: "Priority support",
};

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTier: Tier;
  requiredTier: Tier;
  featureName?: string;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  currentTier,
  requiredTier,
  featureName,
}: UpgradeDialogProps) {
  const current = entitlementsForTier(currentTier);
  const target = entitlementsForTier(requiredTier);

  const gainedFeatures = (
    Object.keys(target.features) as Array<keyof typeof target.features>
  ).filter((key) => target.features[key] && !current.features[key]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="upgrade-dialog-title">
            Upgrade to {TIER_LABEL[requiredTier]}
          </DialogTitle>
          <DialogDescription>
            {featureName
              ? `${featureName} requires the ${TIER_LABEL[requiredTier]} plan.`
              : `This capability is part of the ${TIER_LABEL[requiredTier]} plan.`}{" "}
            Your workspace is on {TIER_LABEL[currentTier]}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <div>
            <div className="font-medium text-foreground">
              What you unlock on {TIER_LABEL[requiredTier]}:
            </div>
            <ul
              className="mt-2 space-y-1 text-muted-foreground"
              data-testid="upgrade-features"
            >
              {gainedFeatures.length === 0 ? (
                <li>Higher limits and capacity.</li>
              ) : (
                gainedFeatures.map((key) => (
                  <li key={key}>• {FEATURE_LABEL[key] ?? key}</li>
                ))
              )}
              <li>
                • Up to {target.limits.agents.toLocaleString()} agents,{" "}
                {target.limits.monthlyActions.toLocaleString()} actions/month,{" "}
                {target.limits.pipelines.toLocaleString()} pipelines.
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="upgrade-dismiss"
          >
            Not now
          </Button>
          <Button asChild data-testid="upgrade-cta">
            <a href="mailto:sales@agentdash.com?subject=Upgrade%20request">
              Contact sales
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
