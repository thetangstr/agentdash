import { GITHUB_URL } from "./site";

/** Release facts are limited to these dated notes; no rollout claim is implied. */
export const LAUNCH_WEEK = {
  path: "/whats-new/launch-week",
  date: "2026-10-07",
  title: "Find your team. Keep your place.",
  summary: "Teams back in the sidebar, conversations that follow new output until you scroll up, and more responsive run logs. The October 7 update makes it easier to stay with the work, with a focused pass on access boundaries.",
  versions: ["v2026.1007.0", "v2026.1007.1"],
} as const;

export const UPDATE_SOURCES = [
  { label: "v2026.1007.0 release notes", href: `${GITHUB_URL}/blob/main/releases/v2026.1007.0.md` },
  { label: "v2026.1007.1 release notes", href: `${GITHUB_URL}/blob/main/releases/v2026.1007.1.md` },
] as const;
