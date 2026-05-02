import { billingApi } from "../api/billing";

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
  async function go() {
    const r = await billingApi.startCheckout(companyId);
    window.location.href = r.url;
  }
  return (
    <div className="border-2 border-accent-400 rounded-lg p-6 bg-accent-50 shadow-sm">
      <div className="mb-3 text-text-primary">{message}</div>
      <button
        className="bg-accent-500 text-text-inverse px-4 py-2 rounded-md text-sm font-medium hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-200"
        onClick={go}
      >
        Start Pro trial →
      </button>
    </div>
  );
}
