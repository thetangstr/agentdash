// AgentDash: UX-6 follow-up — whether the default-profile sidebar's Agents
// list under Team is expanded, remembered per user per company. Collapsed is
// the default; storage failures (private mode, quota) fall back to it.
const STORAGE_PREFIX = "agentdash.sidebarTeamAgentsExpanded";
const ANONYMOUS_USER_ID = "anonymous";

export function getSidebarTeamAgentsStorageKey(
  companyId: string,
  userId: string | null | undefined,
): string {
  const trimmed = userId?.trim();
  return `${STORAGE_PREFIX}:${companyId}:${trimmed ? trimmed : ANONYMOUS_USER_ID}`;
}

export function readSidebarTeamAgentsExpanded(storageKey: string | null): boolean {
  if (!storageKey) return false;
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarTeamAgentsExpanded(storageKey: string | null, expanded: boolean) {
  if (!storageKey) return;
  try {
    if (expanded) localStorage.setItem(storageKey, "true");
    else localStorage.removeItem(storageKey);
  } catch {
    // Ignore localStorage failures.
  }
}
