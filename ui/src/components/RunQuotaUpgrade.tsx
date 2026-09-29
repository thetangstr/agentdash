import type { HeartbeatRun } from "@paperclipai/shared";
import { UpgradeCheckoutButton } from "./UpgradeCheckoutButton";

/**
 * AgentDash (#790): the run-quota wall. The server cancels a queued run with
 * errorCode "quota_exceeded" when a Free workspace exhausts its monthly runs;
 * when a person opens that run they get the upgrade action, not just the
 * error text.
 */
export function RunQuotaUpgrade({ run }: { run: Pick<HeartbeatRun, "errorCode" | "companyId"> }) {
  if (run.errorCode !== "quota_exceeded") return null;
  return <UpgradeCheckoutButton companyId={run.companyId} className="px-3 py-1.5 text-xs" />;
}
