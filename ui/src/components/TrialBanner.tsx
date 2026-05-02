import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<{ tier: string; periodEnd: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { billingApi.status(companyId).then(setStatus); }, [companyId]);
  if (!status || status.tier !== "pro_trial" || !status.periodEnd || dismissed) return null;
  const daysLeft = Math.max(0, Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86400000));
  return (
    <div className="trial-banner bg-blue-100 text-blue-900 border-b border-blue-200 px-4 py-2 flex items-center justify-between">
      <div>
        Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left.{" "}
        <a className="underline" href="/billing">Add payment method</a>
      </div>
      <button className="text-blue-700" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
