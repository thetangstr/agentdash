import { useServerHealth } from "@/hooks/useServerHealth";

export function ServerUnreachableOverlay() {
  const { reachability, isOnline } = useServerHealth();

  if (reachability === "reachable") return null;

  const isBrowserOffline = !isOnline;
  const message = isBrowserOffline
    ? "You're offline — check your internet connection."
    : "Unable to reach the server — it may be temporarily unavailable.";

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6 max-w-sm text-center px-6">
        {/* Animated reconnecting spinner */}
        <div className="relative size-12">
          <div className="absolute inset-0 rounded-full border-4 border-muted" />
          <div className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          {reachability === "unreachable" && (
            <div className="absolute inset-2 rounded-full bg-red-500/10 flex items-center justify-center">
              <span className="size-2 rounded-full bg-red-500 animate-pulse" />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            {isBrowserOffline ? "You're Offline" : "Connection Lost"}
          </h2>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
          >
            Reload page
          </button>
          {reachability === "unreachable" && (
            <button
              onClick={() => {
                // Force refetch all queries to trigger a retry
                window.location.reload();
              }}
              className="px-4 py-2 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors text-sm"
            >
              Retry
            </button>
          )}
        </div>

        {reachability === "unreachable" && (
          <p className="text-xs text-muted-foreground">
            If this persists, the server may be restarting. Try again in a moment.
          </p>
        )}
      </div>
    </div>
  );
}
