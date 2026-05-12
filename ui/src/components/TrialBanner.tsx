import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

const DISMISSED_KEY = "trial-banner-dismissed";

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<{ tier: string; periodEnd: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(`${DISMISSED_KEY}-${companyId}`) === "1");

  useEffect(() => {
    billingApi.status(companyId).then(setStatus).catch(() => {});
  }, [companyId]);

  if (!status || status.tier !== "pro_trial" || !status.periodEnd || dismissed) return null;

  const daysLeft = Math.max(
    0,
    Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86400000),
  );

  function handleDismiss() {
    sessionStorage.setItem(`${DISMISSED_KEY}-${companyId}`, "1");
    setDismissed(true);
  }

  async function handleAddPaymentMethod(e: React.MouseEvent) {
    e.preventDefault();
    try {
      const { url } = await billingApi.openPortal(companyId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // fallback: open billing page
      window.open("/billing", "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className="trial-banner bg-accent-100 text-accent-700 border-b border-accent-200 px-4 py-2 flex items-center justify-between text-sm">
      <div>
        Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left.{" "}
        <a
          className="underline underline-offset-2 hover:text-accent-600 transition-colors"
          href="/billing"
          onClick={handleAddPaymentMethod}
        >
          Add payment method
        </a>
      </div>
      <button
        className="text-accent-600 hover:text-accent-700 transition-colors ml-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 rounded"
        onClick={handleDismiss}
        aria-label="Dismiss trial banner"
      >
        ×
      </button>
    </div>
  );
}
