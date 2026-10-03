// AgentDash: the company WebSocket's lifecycle, published by
// LiveUpdatesProvider. The connection badge and chat hooks read this so a
// socket that is down while /api/health stays green still shows up as
// degraded — the canary failure where chat went silent behind a "Connected"
// badge.
import { useSyncExternalStore } from "react";

export type LiveSocketState = "idle" | "connecting" | "open" | "down";

let state: LiveSocketState = "idle";
const listeners = new Set<() => void>();

export function getLiveSocketState(): LiveSocketState {
  return state;
}

export function setLiveSocketState(next: LiveSocketState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeLiveSocketState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLiveSocketState(): LiveSocketState {
  return useSyncExternalStore(subscribeLiveSocketState, getLiveSocketState, () => "idle");
}
