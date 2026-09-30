// AgentDash: which immutable release this process was loaded from.
//
// The self-hosted updater (scripts/deploy/ota-apply.mjs) switches
// `~/.agentdash/releases/current` and restarts the server, then polls
// /api/health. "Health is ok" alone cannot tell the new release from the old
// process still answering (a restart command that did nothing, say), so health
// reports the commit of the release directory this code was loaded from and
// the updater waits for it to match.
//
// The commit comes from the release's completion marker
// (`.agentdash-release.json`, written by ota-release-layout.mjs after build and
// seal), found by walking up from this module's REAL path. The real path is
// fixed when the process starts, so a `current` symlink swapped afterwards
// cannot make an old process claim the new release. Outside a release layout
// (a git checkout, dev, tests) there is no marker and nothing is reported.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_MARKER_FILENAME = ".agentdash-release.json";
const MAX_LEVELS = 8;

export interface ServedRelease {
  tag: string | null;
  commit: string;
}

/** The completion marker nearest above `startDir`, or null when there is none. */
export function findReleaseMarker(startDir: string, maxLevels = MAX_LEVELS): ServedRelease | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level += 1) {
    let raw: string | null = null;
    try {
      raw = readFileSync(path.join(dir, RELEASE_MARKER_FILENAME), "utf8");
    } catch {
      raw = null; // No marker here; keep walking up.
    }
    if (raw !== null) {
      // A marker that is present but unusable is still the nearest one; do
      // not keep climbing into some other directory's marker.
      try {
        const marker = JSON.parse(raw) as unknown;
        if (!marker || typeof marker !== "object") return null;
        const { commit, tag, complete } = marker as { commit?: unknown; tag?: unknown; complete?: unknown };
        if (complete === true && typeof commit === "string" && /^[0-9a-f]{7,64}$/i.test(commit)) {
          return { commit, tag: typeof tag === "string" ? tag : null };
        }
        return null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

let cached: { value: ServedRelease | null } | null = null;

/** The release this process was loaded from, read once. */
export function servedRelease(): ServedRelease | null {
  if (cached) return cached.value;
  let value: ServedRelease | null = null;
  try {
    value = findReleaseMarker(path.dirname(realpathSync(fileURLToPath(import.meta.url))));
  } catch {
    value = null;
  }
  cached = { value };
  return value;
}
