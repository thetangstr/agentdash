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
      <h1 className="text-2xl font-semibold mb-6">Billing</h1>
      <div className="border rounded p-4 bg-white">
        <div className="mb-2">Plan: <strong>{status.tier}</strong></div>
        <div className="mb-2">Seats paid: {status.seatsPaid}</div>
        {status.periodEnd && (
          <div className="mb-2 text-sm text-gray-600">
            Renews / ends: {new Date(status.periodEnd).toLocaleDateString()}
          </div>
        )}
        <div className="mt-4">
          {!isPro ? (
            <button className="bg-blue-600 text-white px-4 py-2 rounded" onClick={upgrade}>
              Start Pro trial (14 days, no card)
            </button>
          ) : (
            <button className="border px-4 py-2 rounded" onClick={manage}>
              Manage subscription
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
