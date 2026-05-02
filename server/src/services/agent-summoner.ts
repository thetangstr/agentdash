interface Deps {
  conversations: any;
  agents: { getById: (id: string) => Promise<any> };
  adapterFor: (adapterType: string) => any;
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
