import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

const HEALTH_POLL_INTERVAL_MS = 30_000;

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

export function useServerHealth(): ServerHealth {
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const unreachableConsecutiveRef = useRef(0);

  const { data: isReachable, isFetching } = useQuery({
    queryKey: ["serverHealth"],
    queryFn: checkHealth,
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: false,
    staleTime: HEALTH_POLL_INTERVAL_MS - 1_000,
  });

  // Track consecutive unreachable results to avoid flapping on transient failures
  const reachability: ServerReachability =
    isFetching || unreachableConsecutiveRef.current > 0
      ? "checking"
      : isReachable
        ? "reachable"
        : "unreachable";

  // Update consecutive counter
  const wasChecking = useRef(false);
  if (wasChecking.current && !isFetching) {
    if (isReachable) {
      unreachableConsecutiveRef.current = 0;
    } else {
      unreachableConsecutiveRef.current++;
    }
  }
  wasChecking.current = isFetching;

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
    lastCheck: isReachable !== undefined ? new Date() : null,
    isOnline,
  };
}
