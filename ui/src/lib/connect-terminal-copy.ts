/**
 * The words and the one command behind "work with your agent from your terminal".
 *
 * Pulled out of the component because each of these is a decision with a reason
 * behind it, and a reason worth keeping is worth a test.
 */

/**
 * The address that gets baked into a config file on somebody else's laptop.
 *
 * `window.location.origin` is merely whichever URL happened to be in the
 * browser when Copy was pressed. Copy from a LAN address and that address is
 * written into `~/.codex/config.toml` on a colleague's machine, where it works
 * in this office and silently stops working anywhere else — and fixing it means
 * finding a file on someone else's computer. The operator's configured public
 * URL wins when there is one.
 */
export function resolveInstanceOrigin(
  publicBaseUrl: string | null | undefined,
  browserOrigin: string,
): string {
  const configured = (publicBaseUrl ?? "").trim();
  return configured || browserOrigin;
}

/** The whole setup, in one line, with the code already in it. */
export function buildConnectCommand(origin: string, code: string): string {
  return `npx agentdash-connect --url ${origin} ${code}`;
}

export type CodeLife =
  | { state: "live"; label: string }
  | { state: "expiring"; label: string }
  | { state: "expired"; label: string };

/**
 * A code that quietly went stale while the page sat open is worse than no code:
 * it sends someone to a terminal to be told "not valid". Say so on screen
 * first, and start warning before it happens rather than at the moment it does.
 */
export function describeCodeLife(secondsLeft: number): CodeLife {
  if (secondsLeft <= 0) return { state: "expired", label: "expired" };
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  const label = `works once · expires in ${minutes}m ${seconds}s`;
  return secondsLeft <= 120 ? { state: "expiring", label } : { state: "live", label };
}

/**
 * The prompt that turns "I can ask my agent" into "my agent tells me".
 *
 * Deliberately built on the MCP tools a connect code actually grants, not on
 * the steward-inbox routes: those need a `bridge:inbox` endpoint credential,
 * which an agent key is not, so a prompt pointed at them would fail for every
 * person who followed it.
 *
 * Two instructions in here are load-bearing. "Say nothing at all" — because a
 * check that reports its own emptiness every half hour trains people to ignore
 * it. "Do not act on any of it" — because the whole point of a steward is that
 * the decision is theirs.
 */
export function buildWatchPrompt(agentName: string): string {
  return [
    `Every 30 minutes, for as long as this session is open, check AgentDash.`,
    ``,
    `Use the agentdash tools to look for two things: approvals waiting on my`,
    `decision, and issues assigned to ${agentName} that are blocked.`,
    ``,
    `If there is nothing, say nothing at all — an empty check is normal and I`,
    `do not want to be told about it.`,
    ``,
    `If there is something, tell me who is asking, what for, and how long it`,
    `has been waiting. Do not act on any of it. I decide.`,
  ].join("\n");
}
