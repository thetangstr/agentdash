// AgentDash: UX-6 follow-up — whether the sidebar's agent list under Team is
// expanded, remembered per user per company. Expanded is the default (the
// founder wants agents visible in the left bar); only an explicit collapse is
// stored, as "false". Older builds stored "true" for expanded and nothing for
// collapsed, so a stored "true" still reads as expanded and a missing key now
// reads as the new default. Storage failures fall back to expanded.
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
  if (!storageKey) return true;
  try {
    return localStorage.getItem(storageKey) !== "false";
  } catch {
    return true;
  }
}

export function writeSidebarTeamAgentsExpanded(storageKey: string | null, expanded: boolean) {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, expanded ? "true" : "false");
  } catch {
    // Ignore localStorage failures.
  }
}
