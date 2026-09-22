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
 * The address you are USING comes first, and that is a reversal, made on field
 * evidence. The first ordering put the published address first, reasoning that
 * the command gets forwarded to colleagues — but the page's own copy says "run
 * this on the machine you work on", and the first remote steward to use it hit
 * exactly the failure the old default guaranteed: the published LAN name does
 * not resolve over a VPN, and he had to notice and switch by hand. Self-use is
 * the dominant case; the person you MIGHT forward to is the exception, so the
 * caution now lives on the published option's label instead of in the default.
 * A steward whose two addresses agree still sees no choice at all.
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
    { url: current, kind: "current", label: "The address you are using now" },
    publishedChoice,
  ];
}

/**
 * The address to use when nobody chooses. First choice wins; see the ordering
 * note above for why that is the one the reader is provably using.
 */
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
 * The one thing a person copies to connect: a prompt for Claude Code that
 * carries the code. Pasting a prompt is how most people already use the tool,
 * and it spares them finding a terminal, which is where the old one-liner lost
 * them.
 *
 * Every instruction here closes a gap someone actually fell into. The exact
 * command, because a bare `npx agentdash` is an unrelated npm package and a
 * bare `agentdash-connect` lets npx serve a stale cached copy. No retrying
 * with a different command, because a code works once and a "helpful" rerun
 * after a partial failure burns it. The restart, because MCP servers load only
 * when a session starts, so the new tools are invisible in the session that
 * installed them. Saying so beats the person concluding it did not work.
 *
 * The code is single-use and dead within ten minutes, so it is safe inside a
 * prompt in a way an agent key never would be; no key appears here.
 */
export function buildInstallPrompt(origin: string, code: string, agentName: string): string {
  return [
    `Connect this machine to my AgentDash agent, ${agentName}.`,
    ``,
    `Run this command exactly as written. It asks me nothing:`,
    ``,
    `    ${buildConnectCommand(origin, code)}`,
    ``,
    `Then tell me in one or two lines whether it worked, using the line of its`,
    `output that starts with "Connected." If it failed, show me its error and`,
    `stop — do not retry with a different command; the code works once and`,
    `expires ten minutes after it was made.`,
    ``,
    `If it worked, tell me to restart Claude Code, because new tools only load`,
    `when a session starts. After that I can ask "What's waiting on me in`,
    `AgentDash?" and approve or reject right in the chat.`,
  ].join("\n");
}

/**
 * A timer check that reads the person's own inbox. It used to point Claude at
 * the agent's tools, and for approvals that is the one path guaranteed to fail:
 * the agent key is refused on every decision route, by design, so the first
 * "approve that" after a check answered 403. The inbox tools carry the
 * person's own authority, and only act when the person says to.
 *
 * Two instructions in here are load-bearing. "Say nothing at all" — because a
 * check that reports its own emptiness every half hour trains people to ignore
 * it. "Do not act on any of it" — because the whole point of a steward is that
 * the decision is theirs.
 */
export function buildWatchPrompt(agentName: string): string {
  return [
    `Every 30 minutes, for as long as this session is open, check my AgentDash inbox.`,
    ``,
    `Use inbox_sync from the agentdash-inbox tools to look for two things:`,
    `approvals waiting on my decision, and anything of ${agentName}'s that is blocked.`,
    ``,
    `If there is nothing, say nothing at all — an empty check is normal and I`,
    `do not want to be told about it.`,
    ``,
    `If there is something, tell me who is asking, what for, and how long it`,
    `has been waiting. Do not act on any of it. I decide — and if I tell you to`,
    `approve or reject one, use inbox_decide for that item only.`,
  ].join("\n");
}
