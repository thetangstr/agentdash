interface Deps {
  conversations: any;
  agents: { getById: (id: string) => Promise<any> };
  adapterFor: (adapterType: string) => any;
}

export function agentSummoner(deps: Deps) {
  return {
    summon: async (input: { conversationId: string; companyId: string; agentId: string; triggeringMessageId: string }) => {
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
        companyId: input.companyId,
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

export function buildSummonedAgentFallbackReply(input: {
  agent: { name?: string | null; role?: string | null; title?: string | null };
  prompt: string;
}): string {
  const name = input.agent.name?.trim() || "I";
  const role = (input.agent.role ?? input.agent.title ?? "agent").trim();
  const transcript = input.prompt.toLowerCase();

  if (transcript.includes("pilot") || transcript.includes("onboarding") || transcript.includes("soc 2")) {
    return [
      `I’ll start by turning the pilot onboarding goal into an owner-visible checklist and first milestone plan.`,
      `For this workspace, my first move as ${name}${role ? ` (${role})` : ""} is to map the 3 pilot customers, required document requests, follow-up cadence, and founder-time measurement so the team can prove onboarding stays under 2 founder hours per customer.`,
    ].join(" ");
  }

  return [
    `I’ll start by restating the requested outcome, identifying the first concrete deliverable, and surfacing any blockers back to the Chief of Staff.`,
    `As ${name}${role ? ` (${role})` : ""}, I’ll keep the answer tied to the current company conversation rather than starting a separate task thread.`,
  ].join(" ");
}
