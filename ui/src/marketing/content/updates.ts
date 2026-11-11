import { publishedReleases } from "./releases";
import { GITHUB_URL } from "./site";

/** Release facts are limited to these dated notes; no rollout claim is implied. */
export const LAUNCH_WEEK = {
  path: "/whats-new/launch-week",
  date: "2026-10-07",
  title: "Find your team. Keep your place.",
  summary: "Teams back in the sidebar, conversations that follow new output until you scroll up, and more responsive run logs. The October 7 update makes it easier to stay with the work, with a focused pass on access boundaries.",
  versions: ["v2026.1007.0", "v2026.1007.1"],
} as const;

// AgentDash: the public, sanitized release-notes pages (content/releases.ts), not the raw files.
export const UPDATE_SOURCES = [
  { label: "v2026.1007.0 release notes", href: "/releases/v2026.1007.0" },
  { label: "v2026.1007.1 release notes", href: "/releases/v2026.1007.1" },
] as const;

// AgentDash: this customer update advances the existing profile/scorecard foundation.
export const AGENT_PERFORMANCE_UPDATE = {
  path: "/whats-new/agent-performance",
  date: "2026-11-05",
  title: "Better evidence for evaluating agent performance.",
  summary: "Owner-guided criteria, responsibilities beside real tasks, and checks of saved output. What changed, how to use it, and what still remains unknown.",
  versions: ["v2026.1104.0", "v2026.1105.0"],
} as const;
export const AGENT_PERFORMANCE_SOURCES = [
  { label: "v2026.1105.0 packaging correction", href: `${GITHUB_URL}/releases/tag/v2026.1105.0` },
  { label: "v2026.1104.0 evaluation feature notes", href: `${GITHUB_URL}/releases/tag/v2026.1104.0` },
  { label: "v2026.1102.1 scorecard feed and compatibility", href: `${GITHUB_URL}/releases/tag/v2026.1102.1` },
  { label: "v2026.1031.0 profiles, performance and upgrade guide", href: `${GITHUB_URL}/releases/tag/v2026.1031.0` },
] as const;

// AgentDash: admin powers. Shown only once its release is published (see
// isUpdatePublished): the site builds from main, which carries this entry
// before the release is cut.
export const ADMIN_POWERS_UPDATE = {
  path: "/whats-new/admin-powers",
  date: "2026-11-10",
  title: "Change many things at once, and see exactly what happened.",
  summary: "Bulk changes with a preview and honest per-record results, an audit page with a CSV export, ceiling templates, and batch changes from an admin's own Claude, off by default.",
  versions: ["v2026.1110.0"],
} as const;
export const ADMIN_POWERS_SOURCES = [
  { label: "Admin guide: change many things at once", href: "/docs/guides/board-operator/change-many-things-at-once" },
  { label: "v2026.1110.0 release notes", href: "/releases/v2026.1110.0" },
] as const;

/** An update is shown once every release it describes has a published GitHub Release. */
export function isUpdatePublished(update: { versions: readonly string[] }, published: readonly string[] = publishedReleases().versions): boolean {
  return update.versions.every((version) => published.includes(version));
}
