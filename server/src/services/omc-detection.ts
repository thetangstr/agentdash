// AgentDash (AGE-50 Phase 4a): detect whether oh-my-claudecode is installed
// at the adapter host.
//
// OMC is the skill library that backs `/deep-interview` and other Socratic
// behaviors the Chief of Staff relies on. If it's missing, CoS features
// fall back to ad-hoc prompts — we warn at startup and surface the state
// through `cosReadinessService` so the UI can show a soft warning.
//
// OMC installs via Claude Code's plugin marketplace. We check the known
// install locations in order:
//   1. `~/.claude/plugins/marketplaces/omc/` — the primary marketplace dir
//   2. `~/.claude/plugins/cache/omc/` — the cache clone used at runtime
//   3. `~/.claude/plugins/oh-my-claudecode/` — legacy / alternate name
//   4. `$CLAUDE_PROJECT_DIR/.claude/plugins/marketplaces/omc/` — project-scoped
// If any exists, we report installed=true with the matching path.

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OmcDetection {
  installed: boolean;
  path: string | null;
  checkedPaths: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: OmcDetection | null = null;

export async function detectOmc(options: { refresh?: boolean } = {}): Promise<OmcDetection> {
  if (cached && !options.refresh) return cached;

  const home = homedir();
  const userPaths = [
    join(home, ".claude", "plugins", "marketplaces", "omc"),
    join(home, ".claude", "plugins", "cache", "omc"),
    join(home, ".claude", "plugins", "oh-my-claudecode"),
  ];
  const projectPath = process.env.CLAUDE_PROJECT_DIR
    ? join(process.env.CLAUDE_PROJECT_DIR, ".claude", "plugins", "marketplaces", "omc")
    : null;

  const checkedPaths = projectPath ? [...userPaths, projectPath] : userPaths;

  for (const p of checkedPaths) {
    if (await exists(p)) {
      cached = { installed: true, path: p, checkedPaths };
      return cached;
    }
  }

  cached = { installed: false, path: null, checkedPaths };
  return cached;
}

// Test hook: clear the memoized result so tests can re-probe with a new cwd.
export function __resetOmcDetectionCache() {
  cached = null;
}
