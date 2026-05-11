import { useServerHealth } from "@/hooks/useServerHealth";

export type ConnectionState = "connected" | "degraded" | "offline";

export function ConnectionStatus() {
  const { reachability, isOnline } = useServerHealth();

  const state: ConnectionState =
    !isOnline || reachability === "unreachable"
      ? "offline"
      : reachability === "checking"
        ? "degraded"
        : "connected";

  const color =
    state === "connected"
      ? "bg-green-500"
      : state === "degraded"
        ? "bg-yellow-500"
        : "bg-red-500";

  const label =
    state === "connected"
      ? "Connected"
      : state === "degraded"
        ? "Checking…"
        : "Offline";

  return (
    <div className="flex items-center gap-1.5" title={label}>
      <span className={`size-2 rounded-full ${color} shrink-0`} />
      <span className="text-xs text-muted-foreground hidden sm:inline">{label}</span>
    </div>
  );
}
