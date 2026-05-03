import pc from "picocolors";

const AGENTDASH_ART = [
  " █████╗  ██████╗ ███████╗███╗   ██╗████████╗██████╗  █████╗ ███████╗██╗  ██╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║  ██║███████║███████╗███████║",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║  ██║██╔══██║╚════██║██╔══██║",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██████╔╝██║  ██║███████║██║  ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
] as const;

const TAGLINE = "A CoS-led, multi-human AI workspace";
const ATTRIBUTION = "Built on Paperclip's open-source agent harness · github.com/paperclipai/paperclip";

// Function name kept as-is for back-compat with the many existing callers
// (db-backup, doctor, worktree, onboard, setup). The branding inside is
// AgentDash; the credit line names Paperclip explicitly.
export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...AGENTDASH_ART.map((line) => pc.cyan(line)),
    pc.blue("  ──────────────────────────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    pc.dim(`  ${ATTRIBUTION}`),
    "",
  ];

  console.log(lines.join("\n"));
}
