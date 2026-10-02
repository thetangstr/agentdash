// AgentDash (scan 3 lane L): a 429 is the server asking us to slow down, not
// a crash. Callers handle it (the billing-status query backs off), but any
// fire-and-forget call that forgets a .catch would otherwise surface it as an
// uncaught "ApiError: Rate limited" page error, which is how one session
// logged 122 of them. This turns an unhandled 429 rejection into one quiet
// warning instead. Every other unhandled rejection is left exactly as it was.
import { ApiError } from "../api/client";

export function isUnhandledRateLimit(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 429;
}

export function installRateLimitRejectionGuard(target: Window = window): () => void {
  let warned = false;
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isUnhandledRateLimit(event.reason)) return;
    event.preventDefault();
    if (!warned) {
      warned = true;
      console.warn("AgentDash: the server is rate limiting requests; they will resume shortly.");
    }
  };
  target.addEventListener("unhandledrejection", onRejection);
  return () => target.removeEventListener("unhandledrejection", onRejection);
}
