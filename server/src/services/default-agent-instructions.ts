import fs from "node:fs/promises";

// One bundle for every agent, whatever its role.
//
// There used to be three archetypes (`default`, `ceo`, `chief_of_staff`),
// selected by role. The `ceo` and `chief_of_staff` ones were the same
// inherited Paperclip org-chart persona -- byte-identical SOUL.md/TOOLS.md,
// both AGENTS.md opening "You are the CEO", both replacing the Execution
// Contract with "You MUST delegate rather than doing it yourself" -- while
// their shared `<!-- AgentDash: SLUG -->` blocks were kept identical across
// all three copies by agent-instruction-refresh. Three directories, one real
// difference: the persona intro.
//
// That persona is wrong for this product. The model is a steward and their
// agent -- an agent that DOES the work -- not a company of executives that
// route work to each other. So there is one archetype, the steward's agent,
// and role no longer selects a mandate. Role still exists for routing (the
// `chief_of_staff` lookups that find the primary agent) and display; authority
// comes from permission grants, not from a title.
const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(_role: string): DefaultAgentBundleRole {
  return "default";
}
