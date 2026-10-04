// AgentDash (c4-stops): a run is stopped, not cancelled — "cancelled" reads
// as a failure to an owner. Issues and goals keep their own "cancelled"
// status word; only run surfaces use this label.
export function runStatusLabel(status: string): string {
  if (status === "cancelled") return "stopped";
  return status.replace(/_/g, " ");
}
