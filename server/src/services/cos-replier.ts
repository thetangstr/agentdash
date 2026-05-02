interface Deps {
  conversations: any; // conversationService
  llm: (input: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> }) => Promise<string>;
}

const COS_SYSTEM_PROMPT = `You are the Chief of Staff in an AgentDash workspace. Be warm, concise, and specific. When a human asks about an agent's progress, answer based on the conversation history. If you don't have the data, say so plainly. No greetings, no preamble, no markdown headings.`;

export function cosReplier(deps: Deps) {
  return {
    reply: async (input: { conversationId: string; cosAgentId: string }) => {
      const recent = await deps.conversations.paginate(input.conversationId, { limit: 20 });
      const messages = recent.slice().reverse().map((m: any) => ({
        role: m.role === "agent" ? "assistant" : "user", // schema column is "role" (user|agent)
        content: m.content,
      }));
      const text = await deps.llm({ system: COS_SYSTEM_PROMPT, messages });
      return deps.conversations.postMessage({
        conversationId: input.conversationId,
        authorKind: "agent",
        authorId: input.cosAgentId,
        body: text,
      });
    },
  };
}
