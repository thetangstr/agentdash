import { useEffect, useState } from "react";
import { billingApi } from "../api/billing";

const DISMISSED_KEY = "trial-banner-dismissed";

function wasDismissed(companyId: string): boolean {
  try {
    return sessionStorage.getItem(`${DISMISSED_KEY}:${companyId}`) === "1";
  } catch {
    return false;
  }
}

function markDismissed(companyId: string): void {
  try {
    sessionStorage.setItem(`${DISMISSED_KEY}:${companyId}`, "1");
  } catch {
    // sessionStorage unavailable — ignore
  }
}

export function TrialBanner({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<{ tier: string; periodEnd: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(() => wasDismissed(companyId));

  useEffect(() => {
    billingApi.status(companyId).then(setStatus);
  }, [companyId]);

  if (!status || status.tier !== "pro_trial" || !status.periodEnd || dismissed) return null;

  const daysLeft = Math.max(
    0,
    Math.round((new Date(status.periodEnd).getTime() - Date.now()) / 86400000)
  );

  function handleDismiss() {
    setDismissed(true);
    markDismissed(companyId);
  }

  async function handleCta() {
    try {
      const { url } = await billingApi.openPortal(companyId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // fallback: navigate to billing page
      window.open("/billing", "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className="trial-banner bg-accent-100 text-accent-700 border-b border-accent-200 px-4 py-2 flex items-center justify-between text-sm">
      <div>
        Pro trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left.{" "}
        <button
          className="underline underline-offset-2 hover:text-accent-600 transition-colors bg-transparent border-none p-0 cursor-pointer"
          onClick={handleCta}
        >
          Add payment method
        </button>
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
