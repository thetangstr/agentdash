import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { billingApi, type BillingStatus } from "../api/billing";
import { useToastActions } from "../context/ToastContext";

const PRO_TIERS: ReadonlyArray<BillingStatus["tier"]> = ["pro_trial", "pro_active"];

// Closes #251: Stripe webhook race window. After checkout redirect, the
// subscription.created webhook may not have hit our /webhook endpoint by
// the time the user lands here. Poll status with bounded backoff so the
// UI catches up to Pro within ~10s instead of forcing a manual reload.
const WEBHOOK_RACE_POLL_INTERVAL_MS = 2000;
const WEBHOOK_RACE_POLL_MAX_ATTEMPTS = 5;

export default function BillingPage({ companyId }: { companyId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const handledSession = useRef(false);

  // Initial status fetch + manual refetch helper.
  function loadStatus() {
    return billingApi.status(companyId).then(setStatus);
  }

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // Closes #251: handle ?session=success / ?session=cancel callback from Stripe.
  useEffect(() => {
    if (handledSession.current) return;
    const params = new URLSearchParams(location.search);
    const session = params.get("session");
    if (!session) return;
    handledSession.current = true;

    // Strip the param so a refresh doesn't re-trigger.
    params.delete("session");
    const cleanedSearch = params.toString();
    navigate(
      { pathname: location.pathname, search: cleanedSearch ? `?${cleanedSearch}` : "" },
      { replace: true },
    );

    if (session === "cancel") {
      pushToast({
        title: "Checkout canceled",
        body: "No charge was made. You can start again any time.",
        tone: "info",
      });
      return;
    }

    if (session === "success") {
      pushToast({
        title: "Pro trial activating…",
        body: "Stripe is confirming your subscription. This usually takes a few seconds.",
        tone: "success",
      });

      // Poll until tier shows as Pro (webhook race) or attempt budget exhausted.
      let attempt = 0;
      let cancelled = false;
      const poll = async () => {
        if (cancelled) return;
        attempt += 1;
        try {
          const fresh = await billingApi.status(companyId);
          setStatus(fresh);
          if (PRO_TIERS.includes(fresh.tier)) {
            pushToast({
              title: "Pro trial active",
              body: `${fresh.tier === "pro_trial" ? "Your 14-day trial has started." : "Your subscription is active."}`,
              tone: "success",
            });
            return;
          }
        } catch {
          // Network blip; the next poll handles it.
        }
        if (attempt >= WEBHOOK_RACE_POLL_MAX_ATTEMPTS) {
          pushToast({
            title: "Still confirming with Stripe",
            body: "Refresh in a moment if your plan doesn't update.",
            tone: "info",
          });
          return;
        }
        setTimeout(poll, WEBHOOK_RACE_POLL_INTERVAL_MS);
      };
      setTimeout(poll, WEBHOOK_RACE_POLL_INTERVAL_MS);

      return () => {
        cancelled = true;
      };
    }
  }, [companyId, location.pathname, location.search, navigate, pushToast]);

  if (!status) return <div className="p-8">Loading…</div>;

  const isPro = PRO_TIERS.includes(status.tier);

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
