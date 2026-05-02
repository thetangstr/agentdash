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
    <div className="card border-2 border-blue-500 rounded p-4 bg-blue-50">
      <div className="mb-2">{message}</div>
      <button className="bg-blue-600 text-white px-3 py-1 rounded" onClick={go}>
        Start Pro trial →
      </button>
    </div>
  );
}
