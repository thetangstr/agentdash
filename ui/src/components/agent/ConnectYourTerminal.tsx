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
  resolveOriginChoices,
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

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60_000,
  });
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  /**
   * This instance has no address that works for everyone: the published one is
   * plain HTTP on the office LAN (the only door a managed Mac can open with no
   * IT ask), while the tailnet door has a real certificate but only for people
   * on the tailnet. So when the address someone is reading this page through is
   * not the published one, both are offered rather than one being guessed.
   */
  const originChoices = resolveOriginChoices(health?.publicBaseUrl, browserOrigin);
  const [chosenOrigin, setChosenOrigin] = useState<string | null>(null);
  const origin = chosenOrigin ?? originChoices[0]?.url ?? browserOrigin;

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
  // A control with one option is just noise.
  const showOriginPicker = originChoices.length > 1;
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

              {showOriginPicker ? (
                <fieldset className="mt-2 rounded-md border border-dashed px-3 py-2">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">
                    Which address should it use?
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    You opened this page at a different address from the one this instance
                    publishes, and they do not both work from everywhere.
                  </p>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {originChoices.map((choice) => (
                      <label key={choice.url} className="flex items-start gap-2 text-xs">
                        <input
                          type="radio"
                          name="connect-origin"
                          className="mt-0.5"
                          checked={origin === choice.url}
                          onChange={() => setChosenOrigin(choice.url)}
                        />
                        <span>
                          <span className="font-medium text-foreground">{choice.label}</span>
                          {choice.kind === "published" ? (
                            <span className="text-muted-foreground">
                              {" "}
                              — use this if you might send the command to someone else.
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {" "}
                              — use this if you are pasting it on this machine.
                            </span>
                          )}
                          <span className="mt-0.5 block break-all font-mono text-muted-foreground">
                            {choice.url}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
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
            <span className="text-xs font-semibold">1. Paste this into a new Claude Code chat</span>
            <Button size="sm" onClick={() => copy("prompt", watchPrompt)}>
              {copyLabel("prompt", "Copy prompt")}
            </Button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border bg-muted/40 p-2.5 text-xs leading-relaxed">
            <code>{watchPrompt}</code>
          </pre>
          {/*
            Pinning is a step, not a footnote, and it deliberately sits outside
            the prompt above. The prompt cannot do it: pinning is something the
            person does to the conversation in their own tool, by right-clicking
            it. Left unsaid, the schedule quietly dies with the conversation —
            which is the one failure mode of this whole feature that looks like
            "the agent stopped telling me things" rather than like a mistake.
          */}
          <div className="mt-3 rounded-md border border-dashed px-3 py-2.5">
            <p className="text-xs font-semibold">2. Then pin that conversation</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Right-click the conversation and choose <span className="font-medium">Pin</span>. The
              schedule belongs to this one conversation, so pinning is what stops it getting lost
              behind everything else you open. There is nothing to paste for this step — the prompt
              above cannot pin itself.
            </p>
          </div>

          <ul className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                The schedule lives in that conversation.
              </span>{" "}
              Start a fresh one and it is gone; left alone it lapses after about a week, pinned or
              not.
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
