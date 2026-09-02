// AgentDash (AGE-2): does a pushed directive actually reach this adapter's
// runtime? The push route reports this so a steward is never told "pushed"
// when the agent will never see it.
//
// Heartbeat attaches `context.paperclipAgentDirectives` to every run
// regardless of adapter; what differs is whether the adapter renders it.
// Every first-party adapter renders it into the prompt
// (`renderAgentDirectivesPrompt`, asserted per adapter in
// agentdash-mk-adapter-directive-coverage.test.ts), and the Hermes wrapper does
// since AGE-2. The http adapter forwards the whole run context as JSON, so the
// endpoint receives the directives but nothing renders them. The process
// adapter passes no context at all.

export type RuntimeDirectiveDelivery = {
  adapterType: string;
  /** True when the agent's runtime will see the directives on its next run. */
  delivered: boolean;
  /** How they arrive: rendered into the prompt, forwarded as JSON, or not at all. */
  via: "prompt" | "context" | null;
  detail: string;
};

const PROMPT_RENDERING_ADAPTERS: ReadonlySet<string> = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "openclaw_gateway",
  "hermes_local",
]);

const CONTEXT_FORWARDING_ADAPTERS: ReadonlySet<string> = new Set(["http"]);

export function describeRuntimeDirectiveDelivery(adapterType: string): RuntimeDirectiveDelivery {
  if (PROMPT_RENDERING_ADAPTERS.has(adapterType)) {
    return {
      adapterType,
      delivered: true,
      via: "prompt",
      detail: `${adapterType} renders the directives into the prompt of the agent's next run.`,
    };
  }
  if (CONTEXT_FORWARDING_ADAPTERS.has(adapterType)) {
    return {
      adapterType,
      delivered: true,
      via: "context",
      detail:
        `${adapterType} forwards the run context, including paperclipAgentDirectives, as JSON; ` +
        "the endpoint decides whether to show them to its model.",
    };
  }
  return {
    adapterType,
    delivered: false,
    via: null,
    detail:
      `The directives are stored, but ${adapterType} does not read paperclipAgentDirectives from the ` +
      "run context, so the agent's runtime will not see them. They take effect only once the agent " +
      "runs on an adapter that renders directives.",
  };
}
