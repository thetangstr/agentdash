// AgentDash: the viewer's run-transcript mode ("readable" or "raw"), persisted
// in localStorage so the choice follows them across the agent run panel, issue
// chat run blocks, LiveRunWidget and ActiveAgentsPanel. Every toggle on the
// page stays in sync through a shared listener set and the `storage` event.
import { useCallback, useSyncExternalStore } from "react";

export type TranscriptViewMode = "readable" | "raw";

export const TRANSCRIPT_MODE_STORAGE_KEY = "agentdash.runTranscript.mode";
export const DEFAULT_TRANSCRIPT_MODE: TranscriptViewMode = "readable";

const listeners = new Set<() => void>();
// In-memory fallback so the toggle still works when storage is unavailable.
let memoryMode: TranscriptViewMode | null = null;

function parseMode(value: unknown): TranscriptViewMode | null {
  if (value === "readable" || value === "raw") return value;
  // Older builds called the readable view "nice".
  if (value === "nice") return "readable";
  return null;
}

export function readTranscriptModePreference(): TranscriptViewMode {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = parseMode(window.localStorage.getItem(TRANSCRIPT_MODE_STORAGE_KEY));
      if (stored) return stored;
    }
  } catch {
    // Storage blocked (private window, sandboxed iframe): fall through.
  }
  return memoryMode ?? DEFAULT_TRANSCRIPT_MODE;
}

export function writeTranscriptModePreference(mode: TranscriptViewMode): void {
  memoryMode = mode;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, mode);
    }
  } catch {
    // Keep the in-memory value; the choice just won't survive a reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TRANSCRIPT_MODE_STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function getServerSnapshot(): TranscriptViewMode {
  return DEFAULT_TRANSCRIPT_MODE;
}

export function useTranscriptModePreference(): [TranscriptViewMode, (mode: TranscriptViewMode) => void] {
  const mode = useSyncExternalStore(subscribe, readTranscriptModePreference, getServerSnapshot);
  const setMode = useCallback((next: TranscriptViewMode) => writeTranscriptModePreference(next), []);
  return [mode, setMode];
}
