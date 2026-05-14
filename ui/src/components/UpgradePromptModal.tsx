// Closes #224. Listens for the "agentdash:cap-exceeded" CustomEvent dispatched
// by ui/src/api/client.ts on 402 responses with code seat_cap_exceeded or
// agent_cap_exceeded, then renders <UpgradePromptCard> inside a Dialog.
//
// Mounted globally in Layout.tsx so any call site that hits a cap surfaces
// the upgrade CTA without having to wire its own try/catch + UI.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompany } from "../context/CompanyContext";
import { billingApi } from "../api/billing";
import { UpgradePromptCard } from "./UpgradePromptCard";

type CapReason = "seat_cap_exceeded" | "agent_cap_exceeded";

interface CapEventDetail {
  reason: CapReason;
  companyId: string | null;
}

export function UpgradePromptModal() {
  const { selectedCompany } = useCompany();
  const [reason, setReason] = useState<CapReason | null>(null);
  const [eventCompanyId, setEventCompanyId] = useState<string | null>(null);

  // Pull billing status so we can suppress if the user is somehow already
  // on Pro by the time this modal would show (race window after upgrade).
  const { data: status } = useQuery({
    queryKey: ["billing-status", eventCompanyId ?? selectedCompany?.id ?? "none"],
    queryFn: () => billingApi.status(eventCompanyId ?? selectedCompany!.id),
    enabled: reason !== null && Boolean(eventCompanyId ?? selectedCompany?.id),
  });

  useEffect(() => {
    function onCap(e: Event) {
      const detail = (e as CustomEvent<CapEventDetail>).detail;
      if (!detail || (detail.reason !== "seat_cap_exceeded" && detail.reason !== "agent_cap_exceeded")) {
        return;
      }
      setReason(detail.reason);
      setEventCompanyId(detail.companyId);
    }
    window.addEventListener("agentdash:cap-exceeded", onCap);
    return () => window.removeEventListener("agentdash:cap-exceeded", onCap);
  }, []);

  // If status loaded and the company is already on Pro, suppress (covers the
  // upgrade-just-landed race where the original 402 was stale). Use effect
  // (not inline set during render) to avoid React render-loop warnings.
  useEffect(() => {
    if (!reason) return;
    if (status && (status.tier === "pro_trial" || status.tier === "pro_active")) {
      setReason(null);
    }
  }, [reason, status]);

  if (!reason) return null;

  const companyId = eventCompanyId ?? selectedCompany?.id ?? null;
  if (!companyId) return null;

  return (
    <Dialog open={reason !== null} onOpenChange={(open) => !open && setReason(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to Pro</DialogTitle>
        </DialogHeader>
        <UpgradePromptCard reason={reason} companyId={companyId} />
      </DialogContent>
    </Dialog>
  );
}
