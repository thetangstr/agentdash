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
  const [copied, setCopied] = useState<"prompt" | null>(null);

  const origin = baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const code = workspaceCode ?? "<your workspace code>";
  const brief =
    companyBrief ??
    `I run a consultancy. Set up my AgentDash workspace with a Chief of Staff for me
and one agent for each of my leads.`;

  const prompt = `Set up my AgentDash workspace.

My AgentDash runtime is at ${origin}
My API key is: <paste the key from your setup link>
My workspace code is: ${code}

${brief}

Create the workspace with productProfile "agentdash_mk" and that workspace code in
the SAME request — both together, or the workforce features will be missing. Then
confirm GET /api/companies/<id>/connector-send-executions?status=outcome_unknown
returns 200 and not 404; a 404 means it landed on the wrong profile.

Give every agent a mandate as an AGENTS.md instruction file saying who it is, what
it must not do, how it prioritises, and whose direction wins when two people
disagree.

Invite each teammate with auto-approve on — pairing a person with an agent is
refused unless they are already an active member — then pair each person with
their agent, one person to one agent.

Finally print each agent's own key next to its person, and the invite links.`;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied("prompt");
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
            <h2 className="text-sm font-semibold">2. Paste this into your coding agent</h2>
            <Button variant="outline" size="sm" onClick={copyPrompt}>
              {copied === "prompt" ? "Copied" : "Copy prompt"}
            </Button>
          </div>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
            <code>{prompt}</code>
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            It will create your agents, invite your teammates, pair each person with their
            agent, and hand you back a key per agent for their own desktop.
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
