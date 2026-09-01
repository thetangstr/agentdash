import { useState } from "react";

import { Button } from "./ui/button";

/**
 * What the owner sees the first time they sign in, before any workspace exists.
 *
 * The screen this replaces said "Create your first company" and offered one
 * button, which was wrong in three ways for an instance claimed from a setup
 * link: it never mentioned the API key the claim had just issued, the button
 * created an ORDINARY workspace (no `agentdash_mk` profile, so every workforce
 * surface 404s afterwards with nothing explaining why), and nothing hinted that
 * the intended path is to hand the key to a coding agent and describe the
 * company in prose.
 *
 * So: the key first, the prompt second, manual creation last.
 */
export function FirstRunStart({
  onCreateManually,
  companyBrief,
  baseUrl,
  workspaceCode,
}: {
  onCreateManually: () => void;
  /** Prose describing the company, pre-filled when we know it. */
  companyBrief?: string;
  baseUrl?: string;
  workspaceCode?: string;
}) {
  const [copied, setCopied] = useState<"connect" | "prompt" | null>(null);

  const origin = baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const code = workspaceCode ?? "<your workspace code>";
  const brief =
    companyBrief ??
    `I run a consultancy. Set up my workspace with a Chief of Staff that is my own
agent and also the company's, plus one agent for each of my leads.`;

  /**
   * The connect command, which is the only place the runtime address exists.
   *
   * Without this the first screen handed someone an API key and no way to use
   * it: the connect command lives on My Agent, which needs a workspace and a
   * stewardship, and on day one neither exists. So the person holding a key had
   * nowhere to put it.
   *
   * `npx` installs the client from this instance rather than npm — the box is
   * already reachable from every machine that needs it, which is also true when
   * there is no outbound network at all.
   */
  const connectCommand = [
    "claude mcp add agentdash \\",
    `  --env PAPERCLIP_API_URL=${origin} \\`,
    "  --env PAPERCLIP_API_KEY=<paste the key from your setup link> \\",
    `  -- npx -y ${origin}/downloads/agentdash-mcp-server.tgz`,
  ].join("\n");

  /**
   * What to say once connected.
   *
   * Deliberately short. This used to spell out endpoints, the profile/code
   * trap, mandates and pairing — all of which are product knowledge that now
   * travels in the MCP server's operating playbook, delivered to the harness on
   * connect. A prompt that repeats it is one the customer has to maintain, and
   * one that is wrong the moment an endpoint moves.
   */
  const prompt = `Set up my company in AgentDash and then run the first piece of work.

${brief}

My workspace code is ${code}.

Invite my leads so they can sign in and collect their own agent's key. Give every
agent a mandate — ask me what each one must never do.

Then set our first goal and actually run it, so I can watch how it works.

Ask me anything you need. Don't invent names, emails or numbers.`;

  const copy = async (what: "connect" | "prompt", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2200);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">You own this AgentDash instance</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing is set up yet. The quickest way in is to hand your API key to the coding
          agent you already use — Claude Code or Codex — and describe your company to it.
        </p>

        <div className="mt-5">
          <h2 className="text-sm font-semibold">1. Your API key</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            It came back with the setup link you just opened. It starts with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">pcp_board_</code>. Keep it
            somewhere safe — it is not shown again here.
          </p>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">2. Connect your coding agent — once</h2>
            <Button variant="outline" size="sm" onClick={() => copy("connect", connectCommand)}>
              {copied === "connect" ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Run this in your terminal, with your key pasted in, then restart Claude Code. It
            tells your agent where this instance is and how to work with it.
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
            <code>{connectCommand}</code>
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Using Codex instead? The same four values go in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">~/.codex/config.toml</code>.
          </p>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">3. Then just say what you want</h2>
            <Button variant="outline" size="sm" onClick={() => copy("prompt", prompt)}>
              {copied === "prompt" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
            <code>{prompt}</code>
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Short on purpose. Your agent learns how AgentDash works when it connects, so you
            describe your company rather than its API. It will ask you for anything it needs.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Rather do it by hand?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You can create an empty workspace and add agents yourself. Note this route does not
          apply a workspace code, so the workforce features stay off.
        </p>
        <div className="mt-3">
          <Button variant="outline" onClick={onCreateManually}>
            New Company
          </Button>
        </div>
      </div>
    </div>
  );
}
