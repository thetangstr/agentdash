import { useEffect, useState } from "react";
import { billingApi, type BillingStatus } from "../api/billing";

export default function BillingPage({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  useEffect(() => { billingApi.status(companyId).then(setStatus); }, [companyId]);
  if (!status) return <div className="p-8">Loading…</div>;

  const isPro = status.tier === "pro_trial" || status.tier === "pro_active";

  async function upgrade() {
    const r = await billingApi.startCheckout(companyId);
    window.location.href = r.url;
  }
  async function manage() {
    const r = await billingApi.openPortal(companyId);
    window.location.href = r.url;
  }

  return (
    <div className="billing-page p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-text-primary mb-6">Billing</h1>
      <div className="border border-border-soft rounded-lg p-6 bg-surface-raised shadow-sm">
        <div className="mb-2 text-text-primary">
          Plan: <strong className="text-text-primary">{status.tier}</strong>
        </div>
        <div className="mb-2 text-text-primary">Seats paid: {status.seatsPaid}</div>
        {status.periodEnd && (
          <div className="mb-2 text-sm text-text-secondary">
            Renews / ends: {new Date(status.periodEnd).toLocaleDateString()}
          </div>
        )}
        <div className="mt-6">
          {!isPro ? (
            <button
              className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
              onClick={upgrade}
            >
              Start Pro trial (14 days, no card)
            </button>
          ) : (
            <button
              className="border border-border-soft px-4 py-2 rounded-md font-medium text-text-primary hover:bg-surface-sunken transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
              onClick={manage}
            >
              Manage subscription
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
