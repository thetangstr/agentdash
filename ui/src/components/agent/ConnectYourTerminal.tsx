import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { agentsApi } from "../../api/agents";
import { healthApi } from "../../api/health";
import { queryKeys } from "../../lib/queryKeys";
import { copyToClipboard } from "../../lib/clipboard";
import {
  buildConnectCommand,
  buildWatchPrompt,
  describeCodeLife,
  resolveInstanceOrigin,
} from "../../lib/connect-terminal-copy";
import { Button } from "../ui/button";

/**
 * The one place a steward connects their own terminal to their own agent.
 *
 * This replaces two sections that were both on this page and disagreed with
 * each other: a bridge-token card that told people to write a file by hand and
 * install a session hook, and a harness card folded away at the bottom labelled
 * "for whoever operates it". The first documented a route that returns 403 for
 * every key the UI has ever minted; the second was the one that works, and it
 * was hidden behind a disclosure aimed at technicians.
 *
 * What is left is the flow that is real: press a button, get an eight-character
 * code, run one line. The code is short-lived and single-use, so unlike an
 * agent key it is safe to put in a command someone reads off a screen — which
 * is the whole reason it exists.
 */

/** What the harness preview shows. Static by design: see PreviewPane. */
type Harness = "claude" | "codex";

export function ConnectYourTerminal({
  agentId,
  agentName,
  companyId,
}: {
  agentId: string;
  agentName: string;
  companyId: string;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [harness, setHarness] = useState<Harness>("claude");

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60_000,
  });
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const origin = resolveInstanceOrigin(health?.publicBaseUrl, browserOrigin);

  const create = useMutation({
    mutationFn: () => agentsApi.createConnectCode(agentId, companyId),
    onSuccess: (created) => {
      setCode(created.code);
      setExpiresAt(new Date(created.expiresAt).getTime());
    },
  });

  // Tick only while a code is alive. A code that has quietly gone stale while
  // the page sat open must say so here, not in somebody's terminal.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const secondsLeft = expiresAt ? Math.round((expiresAt - now) / 1000) : 0;
  const life = describeCodeLife(secondsLeft);
  const command = code ? buildConnectCommand(origin, code) : null;
  const watchPrompt = buildWatchPrompt(agentName);

  /**
   * Three states, not two. A Copy that silently means "did nothing" is how an
   * on-prem clipboard failure went unnoticed before: over plain HTTP there is
   * no Clipboard API at all, and the whole point of the button is that you are
   * about to paste somewhere else.
   */
  const copy = async (what: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? what : `${what}:failed`);
    window.setTimeout(() => setCopied(null), 2200);
  };
  const copyLabel = (what: string, idle = "Copy") =>
    copied === what ? "Copied" : copied === `${what}:failed` ? "Copy failed" : idle;

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="connect-terminal-heading"
        className="rounded-lg border border-border bg-card"
      >
        <div className="border-b px-4 py-2.5">
          <h2 id="connect-terminal-heading" className="text-sm font-semibold">
            Work with {agentName} from your own terminal
          </h2>
        </div>

        <div className="px-4 py-4">
          {!code ? (
            <>
              <p className="text-sm text-muted-foreground">
                Create a code, then run one line on the machine you work on. {agentName} appears in
                Claude Code or Codex with its work and its mandate. No key changes hands, and the
                code stops working ten minutes from now.
              </p>
              <Button
                className="mt-3"
                size="sm"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create a connect code"}
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <span className="font-mono text-3xl font-semibold tracking-[0.12em] tabular-nums">
                  {code}
                </span>
                <span
                  className={
                    life.state === "expired"
                      ? "rounded-full border border-destructive px-2 py-0.5 font-mono text-xs text-destructive"
                      : life.state === "expiring"
                        ? "rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground"
                        : "rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-xs text-muted-foreground"
                  }
                  role={life.state === "expired" ? "alert" : undefined}
                >
                  {life.label}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {life.state === "expired"
                  ? "This code has expired. Create another — nothing was used up."
                  : "Read it aloud or type it: I, L, O and U are not in the alphabet, so they cannot be confused with 1 and 0."}
              </p>

              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold">Run this on the machine you work on</span>
                <Button size="sm" onClick={() => copy("command", command!)}>
                  {copyLabel("command", "Copy command")}
                </Button>
              </div>
              <pre className="mt-1.5 overflow-x-auto rounded-md border bg-muted/40 p-2.5 text-xs">
                <code>{command}</code>
              </pre>
              <p className="mt-1.5 text-xs text-muted-foreground">
                It finds Claude Code and Codex if they are installed, writes their own config, and
                changes nothing else. Undo any time with{" "}
                <code className="font-mono">npx agentdash-connect --remove</code>.
              </p>

              <Button
                className="mt-2"
                variant="ghost"
                size="sm"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create another code"}
              </Button>
            </>
          )}

          {create.error ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {create.error instanceof Error
                ? create.error.message
                : "Could not create a connect code."}{" "}
              Nothing was connected — try again.
            </p>
          ) : null}
        </div>

        <div className="border-t px-4 py-4">
          <p className="text-xs font-semibold">What you will see</p>
          <div className="mt-2 flex flex-wrap gap-2" role="tablist" aria-label="Harness preview">
            {(["claude", "codex"] as const).map((which) => (
              <button
                key={which}
                type="button"
                role="tab"
                aria-selected={harness === which}
                onClick={() => setHarness(which)}
                className={
                  harness === which
                    ? "rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-medium text-background"
                    : "rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground"
                }
              >
                {which === "claude" ? "Claude Code" : "Codex"}
              </button>
            ))}
          </div>
          <PreviewPane harness={harness} agentName={agentName} />
        </div>
      </section>

      {/* Connecting means you can ask. This means you get told. It carries the
          same weight as the section above because it is the half people miss. */}
      <section
        aria-labelledby="connect-watch-heading"
        className="rounded-lg border border-border bg-card"
      >
        <div className="border-b px-4 py-2.5">
          <h2 id="connect-watch-heading" className="text-sm font-semibold">
            Have {agentName} keep an eye out while you work
          </h2>
        </div>
        <div className="px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Optional, and the part most people miss. Paste this into a Claude Code chat and your
            tool checks on a timer, then stays quiet unless something needs you. The schedule
            belongs to your tool — AgentDash never runs a timer and never interrupts you.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold">Paste into a Claude Code chat</span>
            <Button size="sm" onClick={() => copy("prompt", watchPrompt)}>
              {copyLabel("prompt", "Copy prompt")}
            </Button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border bg-muted/40 p-2.5 text-xs leading-relaxed">
            <code>{watchPrompt}</code>
          </pre>
          <ul className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                The schedule lives in that conversation.
              </span>{" "}
              Start a fresh one and it is gone; left alone it lapses after about a week.
            </li>
            <li>
              <span className="font-medium text-foreground">
                It only runs while your tool is open and not busy
              </span>
              , and a half-hourly check can arrive up to fifteen minutes late.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Codex has no scheduling of its own.
              </span>{" "}
              Ask it when you want to know, or let your operating system run the check on a timer.
            </li>
            <li>
              <span className="font-medium text-foreground">Decisions are still yours, here.</span>{" "}
              The terminal is where you are told; approving and declining happen on this page.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}

/**
 * A still of the harness, not a performance.
 *
 * The design review used a typing animation, which reads well once and is a
 * tax on every visit after that: motion the reader cannot pause, information
 * that arrives later than the eye does, and a `prefers-reduced-motion` branch
 * that has to be maintained forever. A steward opening this page for the tenth
 * time wants to see the shape of the thing immediately. So: the finished
 * screen, rendered, with everything legible at once.
 */
function PreviewPane({ harness, agentName }: { harness: Harness; agentName: string }) {
  const isClaude = harness === "claude";
  return (
    <div className="mt-3">
      <div className="overflow-hidden rounded-lg border border-border bg-zinc-950">
        <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/5 px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="ml-2 font-mono text-[11px] text-zinc-500">
            {isClaude ? "Claude Code" : "Codex"} — ~/projects
          </span>
        </div>

        <div className="flex flex-col gap-2.5 px-4 py-3 font-mono text-[12px] leading-relaxed text-zinc-300">
          {isClaude ? (
            <>
              <div className="rounded border border-white/10 px-2.5 py-1.5 text-zinc-500">
                <div className="text-zinc-300">
                  <span className="text-fuchsia-300">✻</span> Welcome to Claude Code
                </div>
                <div>cwd: ~/projects</div>
              </div>
              <div className="flex gap-2 text-white">
                <span className="text-indigo-300">&gt;</span>
                <span>/mcp</span>
              </div>
              <div className="overflow-hidden rounded border border-white/10">
                <div className="border-b border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-zinc-500">
                  MCP Server Status
                </div>
                <div className="flex items-center gap-3 px-2.5 py-1.5">
                  <span className="min-w-[6rem] text-zinc-300">agentdash</span>
                  <span className="text-emerald-300">✔ connected</span>
                  <span className="ml-auto text-zinc-500">81 tools</span>
                </div>
              </div>
              <div className="flex gap-2 text-white">
                <span className="text-indigo-300">&gt;</span>
                <span>who am I here, and what is waiting on me?</span>
              </div>
              <div>
                <div className="flex gap-2">
                  <span className="text-emerald-300">⏺</span>
                  <span>agentdash - whoami</span>
                </div>
                <div className="pl-5 text-zinc-500">
                  ⎿ {agentName} · Chief of Staff · steward: you
                </div>
              </div>
              <div className="whitespace-pre-wrap">
                <span className="text-amber-300">One thing is waiting on you.</span> Which campus
                the September walkthrough covers first — it is holding up the schedule (MKT-431,
                asked 40m ago).
              </div>
            </>
          ) : (
            <>
              <div className="rounded border border-white/10 px-2.5 py-1.5 text-zinc-500">
                <div className="text-zinc-300">
                  <span className="text-indigo-300">&gt;_</span> OpenAI Codex
                </div>
                <div>model: gpt-5-codex · cwd: ~/projects</div>
              </div>
              <div className="overflow-hidden rounded border border-white/10">
                <div className="border-b border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-zinc-500">
                  MCP
                </div>
                <div className="flex items-center gap-3 px-2.5 py-1.5">
                  <span className="min-w-[6rem] text-zinc-300">agentdash</span>
                  <span className="text-emerald-300">connected</span>
                </div>
              </div>
              <div className="flex gap-2 text-white">
                <span className="text-indigo-300">›</span>
                <span>what is assigned to me in AgentDash?</span>
              </div>
              <div>
                <div className="flex gap-2">
                  <span className="text-emerald-300">•</span>
                  <span>Calling agentdash.list_issues</span>
                </div>
                <div className="pl-5 text-zinc-500">└ 3 issues</div>
              </div>
              <div className="whitespace-pre-wrap text-zinc-400">
                <span className="text-amber-300">MKT-431</span> Prepare the September walkthrough
                schedule — <span className="text-amber-300">waiting on you</span>
              </div>
            </>
          )}
        </div>

        {/* The composer is what makes this read as the app rather than a log. */}
        <div className="mx-3 mb-1 flex items-center gap-2 rounded border border-white/20 px-2.5 py-1.5 font-mono text-[12px] text-zinc-500">
          <span className="text-indigo-300">{isClaude ? ">" : "›"}</span>
          <span>Ask anything</span>
        </div>
        <div className="flex px-4 pb-2 font-mono text-[10px] text-zinc-600">
          <span>{isClaude ? "? for shortcuts" : "Ctrl+C to quit"}</span>
          <span className="ml-auto">
            agentdash <span className="text-emerald-400">connected</span>
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {isClaude
          ? "A recreation of the Claude Code interface."
          : "A recreation of the Codex interface. Codex reads its key from the environment, so it needs a new terminal after connecting — Claude Code does not."}
      </p>
    </div>
  );
}
