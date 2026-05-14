// Pro-tier billing banner. Despite the historical name "TrialBanner", this
// component renders one of two states:
//   - pro_trial    → countdown banner (#208)
//   - pro_past_due → payment-failed warning (#250)
// All other tiers self-suppress.

import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

interface BillingStatusLite {
  tier: string;
  periodEnd: string | null;
}

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<BillingStatusLite | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    billingApi.status(companyId).then(setStatus);
  }, [companyId]);

  if (!status || dismissed) return null;

  if (status.tier === "pro_trial" && status.periodEnd) {
    const daysLeft = Math.max(
      0,
      Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86_400_000),
    );
    return (
      <div className="trial-banner bg-accent-100 text-accent-700 border-b border-accent-200 px-4 py-2 flex items-center justify-between text-sm">
        <div>
          Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left.{" "}
          <a
            className="underline underline-offset-2 hover:text-accent-600 transition-colors"
            href="/billing"
          >
            Add payment method
          </a>
        </div>
        <button
          className="text-accent-600 hover:text-accent-700 transition-colors ml-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 rounded"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss trial banner"
        >
          ×
        </button>
      </div>
    );
  }

  if (status.tier === "pro_past_due") {
    // Closes #250: pro_past_due was added to the entitlement model but had
    // no UI surface — payment-failed users were silently capped on writes
    // with no visible explanation. Render a prominent (non-dismissible)
    // banner pointing at the customer portal so they can fix the card.
    return (
      <div className="past-due-banner bg-destructive/15 text-destructive border-b border-destructive/30 px-4 py-2 flex items-center justify-between text-sm font-medium">
        <div>
          ⚠ Payment failed — your subscription is past due. Inviting teammates
          and hiring agents are paused until the card is updated.{" "}
          <a
            className="underline underline-offset-2 hover:text-destructive/80 transition-colors"
            href="/billing"
          >
            Update payment method
          </a>
        </div>
      </div>
    );
  }

  return null;
}
