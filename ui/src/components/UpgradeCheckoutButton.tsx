import { useState } from "react";
import { billingApi } from "../api/billing";
import { ApiError } from "../api/client";
import { cn } from "../lib/utils";

type FailureKind = "admin" | "unconfigured" | "generic";

const FAILURE_TEXT: Record<FailureKind, string> = {
  admin: "Only a company owner or admin can upgrade — ask them to start the trial.",
  unconfigured: "Billing isn't set up yet for your workspace.",
  generic: "Could not open checkout — try again.",
};

/**
 * AgentDash (#790): the single upgrade CTA used by every Free-tier wall —
 * the cap-exceeded modal card, the run-quota error on a run, and anywhere
 * else a person is told the workspace needs Pro. Starts a Stripe checkout
 * session for the 14-day no-card Pro trial.
 */
export function UpgradeCheckoutButton({
  companyId,
  className,
}: {
  companyId: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);

  async function go() {
    setPending(true);
    setFailure(null);
    try {
      const r = await billingApi.startCheckout(companyId);
      window.location.href = r.url;
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.status === 403) setFailure("admin");
      else if (err instanceof ApiError && err.status === 503) setFailure("unconfigured");
      else setFailure("generic");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={cn(
          "bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200 disabled:opacity-60",
          className,
        )}
        onClick={go}
        disabled={pending}
      >
        {pending ? "Opening checkout…" : "Start 14-day Pro trial, no card"}
      </button>
      {failure ? <span className="text-xs text-red-600 dark:text-red-400">{FAILURE_TEXT[failure]}</span> : null}
    </span>
  );
}
