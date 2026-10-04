import { useServerHealth } from "@/hooks/useServerHealth";
import { useLiveSocketState } from "@/realtime/liveSocketState";
import { cn } from "../lib/utils";

export type ConnectionState = "connected" | "degraded" | "offline";

export function ConnectionStatus() {
  const { reachability, isOnline } = useServerHealth();
  const liveSocket = useLiveSocketState();

  // AgentDash: HTTP health can be green while the live socket is down — that
  // is exactly the "chat goes silent behind a Connected badge" canary miss.
  const socketDown = liveSocket === "down" || liveSocket === "connecting";

  const state: ConnectionState =
    !isOnline || reachability === "unreachable"
      ? "offline"
      : reachability === "checking" || socketDown
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
        ? liveSocket === "down"
          ? "Reconnecting…"
          : liveSocket === "connecting"
            ? "Connecting…"
            : "Checking…"
        : "Offline";

  return (
    <div className="flex items-center gap-1.5" title={label} data-testid="connection-status" role="status" aria-label={label}>
      <span className={`size-2 rounded-full ${color} shrink-0`} />
      {/* AgentDash (c3 copy): the word shows on phones too — a bare dot left
          a "Reconnecting…" state unreadable at the exact moment it mattered.
          Review-1015: but the steady "Connected" earned no ~90px of header —
          it stays screen-reader-only below md while the warnings stay out. */}
      <span className={cn("text-xs text-muted-foreground", state === "connected" && "max-md:sr-only")}>
        {label}
      </span>
    </div>
  );
}
