import fs from "node:fs/promises";
import type { Db } from "@agentdash/db";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  chief_of_staff: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

export interface AgentLike {
  id?: string;
  role: string;
}

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

// AgentDash: Overloaded loader.
// - `loadDefaultAgentInstructionsBundle("chief_of_staff")` returns the bundle by role (legacy call site).
// - `loadDefaultAgentInstructionsBundle(db, agent)` resolves the role from the agent record and returns
//   the bundle. `db` is accepted for future expansion (e.g. per-agent overrides) but unused today.
export async function loadDefaultAgentInstructionsBundle(
  role: DefaultAgentBundleRole,
): Promise<Record<string, string>>;
export async function loadDefaultAgentInstructionsBundle(
  db: Db,
  agent: AgentLike,
): Promise<Record<string, string>>;
export async function loadDefaultAgentInstructionsBundle(
  roleOrDb: DefaultAgentBundleRole | Db,
  agent?: AgentLike,
): Promise<Record<string, string>> {
  let role: DefaultAgentBundleRole;
  if (typeof roleOrDb === "string") {
    role = roleOrDb;
  } else {
    if (!agent) {
      throw new Error("loadDefaultAgentInstructionsBundle(db, agent) requires an agent argument");
    }
    role = resolveDefaultAgentInstructionsBundleRole(agent.role);
  }
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "chief_of_staff" ? "chief_of_staff" : "default";
}

// AgentDash: Flatten a loaded instruction bundle into a single system-prompt string.
// Files are emitted in canonical order (SOUL, AGENTS, HEARTBEAT, TOOLS) each prefixed by a header
// so the model sees explicit section boundaries.
const BUNDLE_ORDER = ["SOUL.md", "AGENTS.md", "HEARTBEAT.md", "TOOLS.md"] as const;

export function formatInstructionsBundleAsSystemPrompt(bundle: Record<string, string>): string {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const fileName of BUNDLE_ORDER) {
    const content = bundle[fileName];
    if (typeof content === "string" && content.trim().length > 0) {
      sections.push(`# ${fileName}\n\n${content.trim()}`);
      seen.add(fileName);
    }
  }
  for (const [fileName, content] of Object.entries(bundle)) {
    if (seen.has(fileName)) continue;
    if (typeof content === "string" && content.trim().length > 0) {
      sections.push(`# ${fileName}\n\n${content.trim()}`);
    }
  }
  return sections.join("\n\n");
}
