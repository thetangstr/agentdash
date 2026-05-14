import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

const HEALTH_POLL_INTERVAL_MS = 30_000;
// Number of consecutive failed polls before reachability flips to
// "unreachable" (and the overlay shows). One failure = "checking" only —
// avoids spurious overlays on transient blips.
const UNREACHABLE_THRESHOLD = 2;

export type ServerReachability = "reachable" | "unreachable" | "checking";

interface ServerHealth {
  reachability: ServerReachability;
  lastCheck: Date | null;
  isOnline: boolean; // browser navigator.onLine
}

async function checkHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch("/api/health", {
      signal: controller.signal,
      credentials: "include",
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

// Closes #229: PR #220 had three compounding bugs in this hook:
//
//   1. Refs were being mutated inside the render body, which double-fires
//      under StrictMode/concurrent rendering and corrupts the consecutive
//      counter. Replaced with useEffect + useState.
//   2. `reachability` flickered to "checking" on every 30s background
//      refetch because the check was keyed off `isFetching`. Switched to
//      `isPending` (initial load only) so steady-state polls don't flash
//      the yellow indicator.
//   3. `lastCheck` was `new Date()` recomputed every render → always "now".
//      Now sourced from react-query's `dataUpdatedAt` (the timestamp of
//      the most recently completed fetch).
export function useServerHealth(): ServerHealth {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [unreachableConsecutive, setUnreachableConsecutive] = useState(0);

  const {
    data: isReachable,
    isPending,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["serverHealth"],
    queryFn: checkHealth,
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: false,
    staleTime: HEALTH_POLL_INTERVAL_MS - 1_000,
  });

  // Track consecutive unreachable results — drives the "checking" badge
  // during the recovery window after a failure. Runs in an effect so we
  // never mutate state during render (StrictMode-safe).
  useEffect(() => {
    if (isReachable === undefined) return; // initial load, no result yet
    if (isReachable) {
      setUnreachableConsecutive((n) => (n === 0 ? n : 0));
    } else {
      setUnreachableConsecutive((n) => n + 1);
    }
    // dataUpdatedAt changes on every completed fetch, so this effect fires
    // exactly once per health-check result rather than per render.
  }, [isReachable, dataUpdatedAt]);

  // Sustained-failure detection: only flip to "unreachable" after
  // UNREACHABLE_THRESHOLD consecutive failed polls. One transient blip
  // shows as "checking" (yellow) but does NOT trigger the full-screen
  // overlay — that requires sustained failure.
  let reachability: ServerReachability;
  if (isPending) {
    reachability = "checking";
  } else if (isReachable && unreachableConsecutive === 0) {
    reachability = "reachable";
  } else if (unreachableConsecutive >= UNREACHABLE_THRESHOLD) {
    reachability = "unreachable";
  } else {
    reachability = "checking";
  }

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return {
    reachability,
    lastCheck: dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null,
    isOnline,
  };
}
