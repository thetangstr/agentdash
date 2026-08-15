import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { agentsApi } from "../../api/agents";
import { healthApi } from "../../api/health";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";

/**
 * Connecting a person's own Claude Code or Codex to their agent.
 *
 * The MCP server, the tools, and the per-agent keys have all existed for a
 * while, and a harness pointed at them works — `paperclipMe` with an agent key
 * returns that agent. What did not exist was any way for the person whose agent
 * it is to get there: minting a key is an API call, the runtime URL is not
 * written down anywhere they look, and the only install instructions in the repo
 * address the technician standing up the machine.
 *
 * Three details are load-bearing and each was learned the hard way:
 *
 *  - `PAPERCLIP_COMPANY_ID` is required, not optional. An agent key gets 403 on
 *    `GET /api/companies`, so a harness that has to discover its own workspace
 *    cannot, and every company-scoped tool then fails for a reason that reads
 *    like a permissions problem.
 *  - `PAPERCLIP_AGENT_ID` selects the agent's operating contract instead of the
 *    installer's. Without it the harness is told to sign a human up and
 *    provision a company — advice that is actively wrong for someone whose
 *    company already exists.
 *  - The client package is fetched from this instance, not from npm.
 *    `@agentdash/mcp-server` is unpublished, and an on-prem customer is exactly
 *    the person who should not need it to be — the box they got their key from
 *    is reachable from every machine that needs the client, air-gapped or not.
 *  - The URL must be the one the browser is using, not loopback. This page is
 *    served from the runtime, so `window.location.origin` is already the address
 *    that works from this machine; hard-coding 127.0.0.1 would produce a command
 *    that only works on the server itself.
 */
export function ConnectYourHarness({
  agentId,
  agentName,
  companyId,
}: {
  agentId: string;
  agentName: string;
  companyId: string;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /**
   * The address baked into the config someone pastes on their own laptop.
   *
   * Prefers the operator's configured public URL over `window.location.origin`,
   * because the origin is merely whichever URL happened to be in the browser
   * when Copy was pressed. Copy from a LAN address and that address is written
   * into `~/.codex/config.toml` on a colleague's machine, where it works in
   * this office and silently stops working in any other — and fixing it means
   * finding a file on someone else's laptop.
   *
   * Falls back to the origin when unset, which is correct for a single-network
   * install and matches the previous behaviour exactly.
   */
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60_000,
  });
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const origin = health?.publicBaseUrl?.trim() || browserOrigin;
  const originDiffersFromBrowser =
    Boolean(health?.publicBaseUrl) && origin !== browserOrigin;

  const mint = useMutation({
    mutationFn: () => agentsApi.createKey(agentId, `${agentName} — my machine`, companyId),
    onSuccess: (created) => setToken(created.token),
  });

  const key = token ?? "<your agent key>";

  const claudeCommand = [
    "claude mcp add agentdash",
    `  --env PAPERCLIP_API_URL=${origin}`,
    `  --env PAPERCLIP_API_KEY=${key}`,
    `  --env PAPERCLIP_COMPANY_ID=${companyId}`,
    `  --env PAPERCLIP_AGENT_ID=${agentId}`,
    `  -- npx -y ${origin}/downloads/agentdash-mcp-server.tgz`,
  ].join(" \\\n");

  const codexConfig = `[mcp_servers.agentdash]
command = "npx"
args = ["-y", "${origin}/downloads/agentdash-mcp-server.tgz"]

[mcp_servers.agentdash.env]
PAPERCLIP_API_URL = "${origin}"
PAPERCLIP_API_KEY = "${key}"
PAPERCLIP_COMPANY_ID = "${companyId}"
PAPERCLIP_AGENT_ID = "${agentId}"`;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2200);
    } catch {
      setCopied(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Work with {agentName} from your own terminal</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect the Claude Code or Codex you already use. {agentName} then shows up there with
        its own work, its mandate, and the ability to answer colleagues who are waiting on it.
      </p>

      {!token ? (
        <div className="mt-3">
          <Button size="sm" disabled={mint.isPending} onClick={() => mint.mutate()}>
            {mint.isPending ? "Creating…" : `Create ${agentName}'s key`}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            The key identifies {agentName} — never you. Anything done with it is recorded as the
            agent, which is what keeps the trail honest.
          </p>
          {mint.error ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {mint.error instanceof Error ? mint.error.message : "Could not create a key"}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <span className="font-medium">Copy the key now.</span> It is shown once and never again.
          If you lose it, create another — old keys keep working until you delete them.
        </p>
      )}

      {originDiffersFromBrowser ? (
        <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          These point at <code className="font-mono">{origin}</code>, not the address you are
          browsing. That is deliberate — it is the address this instance is reachable at from
          anywhere, so the config keeps working when the laptop moves network.
        </p>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Claude Code — run this once</h3>
          <Button variant="outline" size="sm" onClick={() => copy("claude", claudeCommand)}>
            {copied === "claude" ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>{claudeCommand}</code>
        </pre>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">
            Codex — add to <code className="text-[11px]">~/.codex/config.toml</code>
          </h3>
          <Button variant="outline" size="sm" onClick={() => copy("codex", codexConfig)}>
            {copied === "codex" ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>{codexConfig}</code>
        </pre>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Then ask it <span className="font-medium">"who am I and what is assigned to me?"</span> — it
        should answer as {agentName}. If it talks about setting up a company instead, the
        PAPERCLIP_AGENT_ID line is missing.
      </p>
    </section>
  );
}
