interface Deps {
  conversations: any;
  agents: { getById: (id: string) => Promise<any> };
  adapterFor: (adapterType: string) => any;
}

/** What `llmSummonAdapter` needs to read an agent's mandate. */
interface InstructionsReader {
  getBundle: (agent: any) => Promise<{ entryFile?: string | null }>;
  readFile: (agent: any, relativePath: string) => Promise<{ content?: string | null }>;
}

/**
 * Read the agent's mandate — the entry file of its instruction bundle.
 *
 * Returns null rather than throwing: `readFile` throws `notFound` for an agent
 * whose bundle was never written, which is the normal state for an agent created
 * before the mandate wizard existed. A missing mandate is a weaker reply, not a
 * failed one.
 */
async function readMandate(instructions: InstructionsReader, agent: any): Promise<string | null> {
  try {
    const bundle = await instructions.getBundle(agent);
    const entry = bundle.entryFile;
    if (!entry) return null;
    const file = await instructions.readFile(agent, entry);
    const content = file.content?.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

/**
 * The adapter that makes a summoned agent actually answer.
 *
 * What this replaces was an `execute` hardcoded at the route to return the
 * literal text "Stub agent" + " reply". Every @mention in the product returned it,
 * beside a `replier` that was already wired to a real model through the same
 * `dispatchLLM` — so the capability existed and the summoner simply bypassed it.
 *
 * Two things it does that the stub could not:
 *
 *  - **It speaks as the agent.** The mandate becomes the system prompt, so the
 *    file the owner produced in the wizard is what governs the reply. Without
 *    it, the summoner sent a bare transcript with no identity at all, and a
 *    reply that ignores its own mandate is worse than no reply — it looks like
 *    the limits were considered and overruled.
 *  - **It fails out loud.** A dispatch error propagates, and an empty completion
 *    throws. Returning placeholder text on failure is what made this defect
 *    survive: the chat looked like it worked.
 */
export function llmSummonAdapter(deps: {
  instructions: InstructionsReader;
  dispatch: (input: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }) => Promise<string>;
}) {
  return {
    execute: async ({ agent, prompt }: { agent: any; prompt: string }) => {
      const mandate = await readMandate(deps.instructions, agent);
      const system =
        mandate ??
        `You are ${agent?.name ?? "an agent"}, an agent at this company.` +
          ` Your role is ${agent?.role ?? "unspecified"}.` +
          ` You have no mandate on file yet, so stay strictly within what you were asked,` +
          ` and say plainly when something needs a person to decide.`;

      const output = await deps.dispatch({
        system,
        messages: [{ role: "user", content: prompt }],
      });

      if (!output?.trim()) {
        // Never substitute placeholder text. An empty completion is a fault to
        // surface, and a plausible-looking filler reply in a team chat is
        // indistinguishable from a real answer.
        throw new Error(
          `Agent ${agent?.id ?? "unknown"} produced an empty reply when summoned.`,
        );
      }

      return { output };
    },
  };
}

export function agentSummoner(deps: Deps) {
  return {
    summon: async (input: { conversationId: string; agentId: string; triggeringMessageId: string }) => {
      const recent = await deps.conversations.paginate(input.conversationId, { limit: 20 });
      const agent = await deps.agents.getById(input.agentId);
      if (!agent) throw new Error(`Agent ${input.agentId} not found`);
      const adapter = deps.adapterFor(agent.adapterType);
      const result = await adapter.execute({
        agent,
        prompt: buildSummonPrompt(recent),
      });
      return deps.conversations.postMessage({
        conversationId: input.conversationId,
        authorKind: "agent",
        authorId: agent.id,
        body: result.output,
      });
    },
  };
}

function buildSummonPrompt(recent: any[]): string {
  const transcript = recent.slice().reverse().map((m) =>
    `${m.role === "agent" ? "AGENT" : "USER"}: ${m.content}`
  ).join("\n");
  return `You were just @-mentioned in a team chat. Read the recent conversation, answer the question or task addressed to you, and stop. Do not start your reply with greetings.\n\nRecent conversation:\n${transcript}`;
}
