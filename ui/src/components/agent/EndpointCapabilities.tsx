/**
 * What a connected machine may do, in words, and the one gap that matters
 * for the person's own Claude: without `bridge:work` it cannot review their
 * agents' work or send anything back. Machines connected before review
 * existed got it by migration when they already had the inbox; any other
 * machine gets it only by reconnecting with a fresh code.
 */
export const BRIDGE_WORK = "bridge:work";

const CAPABILITY_WORDS: Record<string, string> = {
  "bridge:read": "questions",
  "bridge:act": "tasks",
  "bridge:inbox": "inbox",
  [BRIDGE_WORK]: "review",
};

export function describeEndpointCapabilities(capabilities: readonly string[]) {
  const known = Object.keys(CAPABILITY_WORDS);
  const words = [
    ...known.filter((capability) => capabilities.includes(capability)).map((capability) => CAPABILITY_WORDS[capability]!),
    ...capabilities.filter((capability) => !known.includes(capability)),
  ];
  return { words, reviewMissing: !capabilities.includes(BRIDGE_WORK) };
}

export function EndpointCapabilities({ capabilities }: { capabilities: readonly string[] }) {
  const { words, reviewMissing } = describeEndpointCapabilities(capabilities);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="endpoint-capabilities">
      <span className="font-mono text-xs text-muted-foreground" title={capabilities.join(", ")}>
        {words.length > 0 ? words.join(" · ") : "no access"}
      </span>
      {reviewMissing ? (
        <span className="text-xs text-amber-700 dark:text-amber-300" data-testid="endpoint-review-missing">
          review not enabled; reconnect
        </span>
      ) : null}
    </span>
  );
}
