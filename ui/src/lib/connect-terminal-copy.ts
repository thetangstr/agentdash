/**
 * The words and the one command behind "work with your agent from your terminal".
 *
 * Pulled out of the component because each of these is a decision with a reason
 * behind it, and a reason worth keeping is worth a test.
 */

/**
 * Which address the pasted command should point at.
 *
 * The published address, and only the published address. `PAPERCLIP_PUBLIC_URL`
 * is the one address the operator has declared is the way in; the browser
 * origin is merely the door this particular reader happened to come through,
 * and on this instance that is routinely the tailnet host — an address nobody
 * else can reach and that a managed Mac will not trust.
 *
 * This replaces a two-option picker. The picker was honest about the ambiguity
 * and it made every reader resolve it, every time, with the default landing on
 * whichever door they arrived by. Where the two addresses agreed it showed
 * nothing, so the people who saw a choice were exactly the people least able to
 * judge it. An operator who wants a different address in the command changes
 * the one env var that declares it, in one place, for everyone.
 *
 * The cost is real and worth stating: a reader on a VPN or tailnet, for whom
 * the published address does not resolve, no longer has a one-click escape on
 * the page. That is why the card says which address the command carries, and
 * why `PAPERCLIP_PUBLIC_URL` must be an address reachable by the people you
 * expect to run this — see doc/handoffs/2026-08-19-machine-handoff.md.
 *
 * The browser origin survives in one case only: nothing published at all, where
 * a wrong-but-present address beats an empty `--url`.
 */
export type OriginChoice = {
  url: string;
  kind: "published" | "current";
  /** What a person needs to know to pick, in their words rather than ours. */
  label: string;
};

/** Trailing slashes and case differ without meaning anything. */
function sameOrigin(a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function resolveOriginChoices(
  publicBaseUrl: string | null | undefined,
  browserOrigin: string,
): OriginChoice[] {
  const published = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  const current = (browserOrigin ?? "").trim().replace(/\/+$/, "");

  if (published) {
    return [{ url: published, kind: "published", label: "The address this instance publishes" }];
  }
  return current ? [{ url: current, kind: "current", label: "The address you are using now" }] : [];
}

/**
 * Whether the command points somewhere other than the door this reader came
 * through. Not a choice any more — just the one fact that makes an unreachable
 * command explicable instead of mysterious.
 */
export function pointsElsewhere(
  publicBaseUrl: string | null | undefined,
  browserOrigin: string,
): boolean {
  const published = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  const current = (browserOrigin ?? "").trim().replace(/\/+$/, "");
  if (!published || !current) return false;
  return !sameOrigin(published, current);
}

/** The address to use. There is only one; this is kept as the named accessor. */
export function resolveInstanceOrigin(
  publicBaseUrl: string | null | undefined,
  browserOrigin: string,
): string {
  return resolveOriginChoices(publicBaseUrl, browserOrigin)[0]?.url ?? browserOrigin;
}

/**
 * The whole setup, in one line, with the code already in it.
 *
 * `@latest` is load-bearing: a bare package name lets npx serve whatever its
 * cache holds, and a cached pre-0.2 CLI silently skips the inbox half of the
 * pairing. The first Windows steward would have hit exactly that.
 */
export function buildConnectCommand(origin: string, code: string): string {
  return `npx -y agentdash-connect@latest --url ${origin} ${code}`;
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
