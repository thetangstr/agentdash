// AgentDash: sidebar IA — whether the sidebar's collapsed "More" group
// (Goals, Routines, Costs, Activity) is expanded, remembered per user per
// company exactly like the Team agents list. Collapsed is the default;
// storage failures (private mode, quota) fall back to it.
const STORAGE_PREFIX = "agentdash.sidebarMoreExpanded";
const ANONYMOUS_USER_ID = "anonymous";

export function getSidebarMoreStorageKey(
  companyId: string,
  userId: string | null | undefined,
): string {
  const trimmed = userId?.trim();
  return `${STORAGE_PREFIX}:${companyId}:${trimmed ? trimmed : ANONYMOUS_USER_ID}`;
}

export function readSidebarMoreExpanded(storageKey: string | null): boolean {
  if (!storageKey) return false;
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarMoreExpanded(storageKey: string | null, expanded: boolean) {
  if (!storageKey) return;
  try {
    if (expanded) localStorage.setItem(storageKey, "true");
    else localStorage.removeItem(storageKey);
  } catch {
    // Ignore localStorage failures.
  }
}
