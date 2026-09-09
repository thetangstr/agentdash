/**
 * The words and the one command behind "work with your agent from your terminal".
 *
 * Pulled out of the component because each of these is a decision with a reason
 * behind it, and a reason worth keeping is worth a test.
 */

/**
 * Which address the pasted command should point at.
 *
 * There is no single right answer on this instance, and pretending otherwise is
 * what made the old behaviour wrong for somebody either way. Three doors exist
 * and none of them works for everyone:
 *
 *   http://mkmini.local:3102   plain HTTP on the office LAN — the only address a
 *                              client user on a managed Mac can open with no IT ask
 *   https://<host>:3112        real certificate, but only for someone on the tailnet
 *   https://mkmini.local:3112  a private root a managed Mac will not trust
 *
 * So `PAPERCLIP_PUBLIC_URL` is a compromise chosen for the majority, and the
 * page used to hand it to everyone — including the person who had demonstrably
 * just reached the server by a different address, since they were reading the
 * page through it.
 *
 * When the two agree there is nothing to decide and nothing is shown. When they
 * disagree, both are offered.
 *
 * The published address stays FIRST, and that ordering is the safety property.
 * The command is a thing people forward to a colleague, and a URL captured from
 * whichever door happened to be open gets written into `~/.codex/config.toml`
 * on somebody else's machine, where it works here and silently stops working
 * anywhere else. Defaulting to the shared address means the person who has to
 * override it is the one who can already see that they took a different door.
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

  if (!published) {
    return current ? [{ url: current, kind: "current", label: "The address you are using now" }] : [];
  }
  const publishedChoice: OriginChoice = {
    url: published,
    kind: "published",
    label: "The address this instance publishes",
  };
  if (!current || sameOrigin(published, current)) return [publishedChoice];

  return [
    publishedChoice,
    { url: current, kind: "current", label: "The address you are using now" },
  ];
}

/**
 * The address to use when nobody chooses. First choice wins; see the ordering
 * note above for why that is the published one.
 */
export function resolveInstanceOrigin(
  publicBaseUrl: string | null | undefined,
  browserOrigin: string,
): string {
  return resolveOriginChoices(publicBaseUrl, browserOrigin)[0]?.url ?? browserOrigin;
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
