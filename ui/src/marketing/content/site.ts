/**
 * AgentDash marketing site: the single place for facts the public pages repeat.
 *
 * Everything here is meant to be checked against the product, not invented.
 * Contact routes to the domain that actually has mail (agentdash.cloud has
 * Google MX records; agentdash.com is parked). Change it here, not in pages.
 */

export const SITE_NAME = "AgentDash";

/** Mailbox for walkthrough requests and the hosted-cloud interest list. */
export const CONTACT_EMAIL = "edward@agentdash.cloud";

export const GITHUB_URL = "https://github.com/thetangstr/agentdash";
export const GITHUB_README_URL = `${GITHUB_URL}#readme`;
export const PAPERCLIP_URL = "https://github.com/paperclipai/paperclip";

/** One-line self-host bootstrap from the README. */
export const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap.sh | bash";

export function mailto(subject: string, body?: string): string {
  const params = new URLSearchParams({ subject });
  if (body) params.set("body", body);
  return `mailto:${CONTACT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}

export const CTA = {
  walkthrough: {
    label: "Book a walkthrough",
    href: mailto(
      "AgentDash walkthrough",
      "Hi, I'd like a walkthrough of AgentDash on our own work.\n\nCompany:\nWhat we'd want a Chief of Staff agent to own first:\n",
    ),
  },
  // AgentDash (SC-9, GH #770): self-serve signup exists now (/start, SC-7);
  // new workspaces open a few at a time behind a waitlist.
  startFree: {
    label: "Start free",
    href: "/start",
  },
  selfHost: {
    label: "Install it yourself",
    href: GITHUB_README_URL,
  },
  demo: {
    label: "Try the demo",
    href: "/demo",
  },
  // Hosted workspaces sign in on their own address; /find mails the link.
  signIn: {
    label: "Sign in",
    href: "/find",
  },
} as const;

/** Harness adapters that ship in packages/adapters. */
export const ADAPTERS = [
  "Claude Code",
  "Codex",
  "Cursor",
  "Gemini CLI",
  "Pi",
  "OpenCode",
  "OpenClaw",
  "acpx",
] as const;

/**
 * MCP tools a steward uses from Claude Code or Codex. Names mirror
 * packages/mcp-server/src/tools.ts; keep them exact so the site never
 * documents a tool that does not exist.
 */
export const STEWARD_TOOLS = {
  sync: "inbox_sync",
  propose: "inbox_propose",
  confirm: "inbox_confirm",
  decide: "inbox_decide",
  agents: "inbox_agents",
  whoami: "whoami",
  pause: "agentdash_pause_agent",
  resume: "agentdash_resume_agent",
  dashboard: "agentdash_get_dashboard",
} as const;

export const NAV_LINKS = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Demo", href: "/demo" },
  { label: "What’s new", href: "/whats-new" },
  { label: "MCP setup", href: "/mcp" },
  { label: "Docs", href: "/docs" },
  { label: "Consulting", href: "/consulting" },
  { label: "About", href: "/about" },
] as const;

/** Plain statement of where the product is, repeated wherever a CTA appears. */
export const READINESS_LINE =
  "Self-hosted and open source today. Hosted workspaces are opening a few at a time.";
