import { UpgradeCheckoutButton } from "./UpgradeCheckoutButton";

export function UpgradePromptCard({
  reason,
  companyId,
}: {
  reason: "seat_cap_exceeded" | "agent_cap_exceeded";
  companyId: string;
}) {
  const message = reason === "seat_cap_exceeded"
    ? "Free workspaces are limited to 1 user."
    : "Free workspaces include only the Chief of Staff.";
  return (
    <div className="border-2 border-accent-400 rounded-lg p-6 bg-accent-50 shadow-sm">
      <div className="mb-3 text-text-primary">{message}</div>
      <UpgradeCheckoutButton companyId={companyId} />
    </div>
  );
}
