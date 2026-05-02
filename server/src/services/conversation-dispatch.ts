import { parseMentions, type AgentDirEntry } from "@paperclipai/shared";

interface Deps {
  conversations: any;
  agents: { listForCompany: (companyId: string) => Promise<any[]>; getById: (id: string) => Promise<any> };
  summoner: { summon: (input: { conversationId: string; agentId: string; triggeringMessageId: string }) => Promise<any> };
  replier: { reply: (input: { conversationId: string; cosAgentId: string }) => Promise<any> };
  cosResolver: { findByCompany: (companyId: string) => Promise<any> };
}

export function conversationDispatch(deps: Deps) {
  return {
    onMessage: async (input: {
      messageId: string;
      conversationId: string;
      companyId: string;
      authorUserId: string;
      body: string;
    }) => {
      const agents = await deps.agents.listForCompany(input.companyId);
      const dir: AgentDirEntry[] = agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role ?? a.title ?? "agent",
      }));
      const mentions = parseMentions(input.body, dir);
      const resolved = mentions.find((m) => m.agentId);
      if (resolved && resolved.agentId) {
        return deps.summoner.summon({
          conversationId: input.conversationId,
          agentId: resolved.agentId,
          triggeringMessageId: input.messageId,
        });
      }
      // No actionable mention — CoS replies.
      const cos = await deps.cosResolver.findByCompany(input.companyId);
      if (!cos) return; // no CoS yet
      return deps.replier.reply({
        conversationId: input.conversationId,
        cosAgentId: cos.id,
      });
    },
  };
}
