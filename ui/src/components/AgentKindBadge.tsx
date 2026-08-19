import type { Agent } from "@paperclipai/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * What kind of agent this is, said out loud on every screen that lists agents.
 *
 * Two kinds now exist and they are managed in opposite ways: a stewarded agent
 * belongs to one person who runs it from their own terminal, and an autonomous
 * agent has nobody at a terminal at all. Before this, both rendered identically
 * — a name and a status — and the only visible difference was a steward field
 * that was empty for an autonomous agent and *also* empty for a personal agent
 * whose pairing was never finished. A person looking at the list could not tell
 * "this is meant to run alone" from "somebody forgot to finish this".
 *
 * Three states, because that ambiguity is exactly what has to go away:
 * autonomous, stewarded, and stewarded-but-unpaired — the last of which is the
 * one that needs somebody to act.
 */
export type AgentKind = "autonomous" | "stewarded" | "unpaired";

export function agentKind(agent: Pick<Agent, "autonomy" | "accountable">): AgentKind {
  if ((agent.autonomy ?? "stewarded") === "autonomous") return "autonomous";
  return agent.accountable?.via === "steward" ? "stewarded" : "unpaired";
}

/** The person answerable for this agent, labelled name → email → id. */
export function accountableLabel(agent: Pick<Agent, "accountable">): string | null {
  const accountable = agent.accountable;
  if (!accountable) return null;
  return accountable.name?.trim() || accountable.email?.trim() || accountable.userId;
}

/**
 * One sentence per kind, used in the tooltip and again in the side panel.
 *
 * Deliberately the same text in both places. The badge is where someone first
 * meets the distinction and the panel is where they go to understand it; two
 * different explanations of the same word is how a product teaches two
 * different meanings.
 */
export function agentKindExplanation(agent: Pick<Agent, "autonomy" | "accountable">): string {
  const who = accountableLabel(agent);
  switch (agentKind(agent)) {
    case "autonomous":
      return who
        ? `Works on its own — no person runs it, and it has no connect code or key. ${who} is accountable for what it does.`
        : "Works on its own — no person runs it, and it has no connect code or key.";
    case "stewarded":
      return `${who ?? "One person"} runs this agent from their own terminal, and answers for what it does. One person, one agent.`;
    case "unpaired":
      return "Meant to be run by one person, but nobody is paired with it yet: no My Agent page, no connect code, and escalations from it reach no one. Assign a steward, or make it autonomous.";
  }
}

const LABELS: Record<AgentKind, string> = {
  autonomous: "Autonomous",
  stewarded: "Stewarded",
  unpaired: "Needs a steward",
};

const STYLES: Record<AgentKind, string> = {
  // Distinct from the muted "Not scheduled" pill and from the destructive
  // states: autonomous is a deliberate configuration, not a warning.
  autonomous: "border-primary/40 text-primary",
  stewarded: "border-border text-muted-foreground",
  // The one that is somebody's to fix, so it is the one that draws the eye.
  unpaired: "border-amber-500/50 text-amber-600 dark:text-amber-400",
};

/**
 * The badge itself.
 *
 * Rendered for every kind rather than only for autonomous agents. Marking just
 * the exception means an unmarked row is ambiguous — "personal" and "we have not
 * loaded this yet" look the same — and the pairing is the thing this product is
 * built around, so it is worth naming where people actually look.
 */
export function AgentKindBadge({
  agent,
  className,
}: {
  agent: Pick<Agent, "autonomy" | "accountable">;
  className?: string;
}) {
  const kind = agentKind(agent);
  return (
    // Its own provider so the badge can be dropped into any list or panel
    // without that screen having to know it contains a tooltip. Radix throws
    // "`Tooltip` must be used within `TooltipProvider`" otherwise, and the page
    // that would break is whichever one somebody adds this to next. Nesting
    // inside the app-level provider is supported and costs a context read.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`agent-kind-${kind}`}
            className={cn(
              "cursor-default whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              STYLES[kind],
              className,
            )}
          >
            {LABELS[kind]}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-xs">
          {agentKindExplanation(agent)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
