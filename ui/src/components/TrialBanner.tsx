import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<{ tier: string; periodEnd: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { billingApi.status(companyId).then(setStatus); }, [companyId]);
  if (!status || status.tier !== "pro_trial" || !status.periodEnd || dismissed) return null;
  const daysLeft = Math.max(0, Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86400000));
  return (
    <div className="trial-banner bg-accent-100 text-accent-700 border-b border-accent-200 px-4 py-2 flex items-center justify-between text-sm">
      <div>
        Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left.{" "}
        <a className="underline underline-offset-2 hover:text-accent-600 transition-colors" href="/billing">
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
