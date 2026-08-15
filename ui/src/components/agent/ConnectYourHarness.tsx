import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { agentsApi } from "../../api/agents";
import { healthApi } from "../../api/health";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";
import { copyToClipboard } from "../../lib/clipboard";

/**
 * Connecting a person's own coding agent to their AgentDash agent.
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
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null);

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

  /**
   * The code is the path people are given; the raw key below it is the
   * fallback.
   *
   * Handing someone a `pcp_<48hex>` key means handing them a long-lived
   * credential that is identical on every machine it reaches, so it gets
   * pasted into chat, cannot be revoked for one laptop, and nobody can say
   * afterwards which machines hold it. A code expires in ten minutes, works
   * once, and what it produces is a key named for the machine that redeemed
   * it.
   */
  const connectCode = useMutation({
    mutationFn: () => agentsApi.createConnectCode(agentId, companyId),
    onSuccess: (created) => {
      setCode(created.code);
      setCodeExpiresAt(new Date(created.expiresAt).getTime());
    },
  });

  // A code that has quietly expired while the page sat open is worse than no
  // code: it sends someone to a terminal to be told "not valid". Tick so the
  // screen can say so first.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!codeExpiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [codeExpiresAt]);

  const secondsLeft = codeExpiresAt ? Math.max(0, Math.round((codeExpiresAt - now) / 1000)) : 0;
  const codeExpired = Boolean(codeExpiresAt) && secondsLeft <= 0;
  const connectCommand = `npx agentdash-connect --url ${origin} ${code ?? "CODE"}`;

  const key = token ?? "<paste your agent key here>";

  /**
   * One short statement: the endpoint and the key. Nothing else exists to
   * configure.
   *
   * The instance now serves MCP over streamable HTTP at /api/mcp, and the
   * bearer key alone identifies which agent this is — the server resolves
   * agent and company from it and greets the harness with that agent's own
   * playbook as its instructions. The earlier npx-tarball-plus-four-env-vars
   * form survives for anything that cannot speak HTTP MCP, but this is the
   * path people are given.
   */
  const connectPrompt = [
    `I use AgentDash. Connect to my agent "${agentName}" over MCP:`,
    ``,
    `  Endpoint: ${origin}/api/mcp   (transport: streamable HTTP)`,
    `  Header:   Authorization: Bearer ${key}`,
    ``,
    `Add it as an MCP server named "agentdash" using your tool's own mechanism`,
    `and reconnect. Then tell me who I am and what is assigned to me — the`,
    `server will brief you as ${agentName}. Do not start any of that work until`,
    `I ask.`,
  ].join("\n");

  /**
   * Say when copying failed.
   *
   * This swallowed the error and reset the label, so on an on-prem instance
   * over plain HTTP — where there is no Clipboard API at all — the button
   * looked like it had worked and the clipboard was empty. Silence is the
   * worst possible answer here: the whole point of the button is that you are
   * about to paste something somewhere else.
   */
  const copy = async (what: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? what : `${what}:failed`);
    window.setTimeout(() => setCopied(null), 2200);
  };

  /**
   * Three states, not two. "Copy" that silently means "did nothing" is how the
   * on-prem clipboard bug went unnoticed.
   */
  const copyLabel = (what: string, idle = "Copy") =>
    copied === what ? "Copied" : copied === `${what}:failed` ? "Copy failed" : idle;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Work with {agentName} from your own terminal</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Whatever coding agent you already use — Claude Code, Codex, something else — can connect to{" "}
        {agentName}. Create a short code, send it to whoever needs it, and they run one command on
        their own machine. {agentName} then shows up there with its own work, its mandate, and the
        ability to answer colleagues waiting on it.
      </p>

      <div className="mt-3">
        {!code ? (
          <>
            <p className="text-xs text-muted-foreground">
              No key changes hands, and the code stops working ten minutes from now.
            </p>
            <Button
              className="mt-2"
              size="sm"
              disabled={connectCode.isPending}
              onClick={() => connectCode.mutate()}
            >
              {connectCode.isPending ? "Creating…" : "Create a connect code"}
            </Button>
            {connectCode.error ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {connectCode.error instanceof Error
                  ? connectCode.error.message
                  : "Could not create a connect code"}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="mt-1.5 flex items-center gap-3">
              <code className="font-mono text-2xl font-semibold tracking-[0.2em]">{code}</code>
              <Button variant="outline" size="sm" onClick={() => copy("code", code)}>
                {copyLabel("code")}
              </Button>
            </div>
            <p className={`mt-1 text-xs ${codeExpired ? "text-destructive" : "text-muted-foreground"}`}>
              {codeExpired
                ? "This code has expired. Create another."
                : `Works once, and expires in ${Math.floor(secondsLeft / 60)}m ${String(secondsLeft % 60).padStart(2, "0")}s.`}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium">They run this:</span>
              <Button variant="outline" size="sm" onClick={() => copy("command", connectCommand)}>
                {copyLabel("command", "Copy command")}
              </Button>
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-background p-2.5 text-xs">
              <code>{connectCommand}</code>
            </pre>
            <Button
              className="mt-2"
              variant="ghost"
              size="sm"
              disabled={connectCode.isPending}
              onClick={() => connectCode.mutate()}
            >
              {connectCode.isPending ? "Creating…" : "Create another"}
            </Button>
          </>
        )}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Or hand over a key directly
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          For a tool that cannot run <code className="font-mono">npx</code>. A key does not expire
          and is the same on every machine it reaches, so prefer a code where you can.
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
        /*
         * Show the key itself.
         *
         * This said "Copy the key now — it is shown once and never again" and
         * then never showed a key: the token existed only inside the two
         * command blocks further down. Someone following the instruction
         * literally looked for something to copy and found nothing, on the one
         * screen that decides whether a person can use their agent at all.
         */
        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold">{agentName}&rsquo;s key</h3>
            <Button variant="outline" size="sm" onClick={() => copy("key", token)}>
              {copyLabel("key", "Copy key")}
            </Button>
          </div>
          <code className="mt-1.5 block overflow-x-auto whitespace-nowrap font-mono text-xs">
            {token}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium">Copy it now.</span> It is shown once and never again. If
            you lose it, create another — old keys keep working until you delete them. It is
            already filled into both snippets below, so copying either of those is enough.
          </p>
        </div>
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
          <h3 className="text-xs font-semibold">
            Paste this into Claude Code, Codex, or whatever you use
          </h3>
          <Button variant="outline" size="sm" onClick={() => copy("prompt", connectPrompt)}>
            {copyLabel("prompt", "Copy prompt")}
          </Button>
        </div>
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>{connectPrompt}</code>
        </pre>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        It should come back as {agentName} and tell you what {agentName} has been assigned. If it
        starts talking about setting up a company instead, it connected as nobody in particular —
        check the <code className="font-mono">PAPERCLIP_AGENT_ID</code> line survived the paste.
      </p>
      </details>
    </section>
  );
}
