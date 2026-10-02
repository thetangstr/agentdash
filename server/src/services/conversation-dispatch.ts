import { parseMentions, type AgentDirEntry } from "@paperclipai/shared";

interface Deps {
  conversations: any;
  agents: { listForCompany: (companyId: string) => Promise<any[]>; getById: (id: string) => Promise<any> };
  summoner: { summon: (input: { conversationId: string; agentId: string; triggeringMessageId: string }) => Promise<any> };
  replier: {
    reply: (input: {
      conversationId: string;
      cosAgentId: string;
      companyId?: string;
      triggerMessageId?: string;
      // AgentDash (scan 3, lane G): the board user whose message this answers,
      // with the agents they may see.
      requestedBy?: {
        userId: string;
        source?: string | null;
        isInstanceAdmin?: boolean;
        visibleAgentIds: ReadonlySet<string> | null;
      } | null;
    }) => Promise<any>;
  };
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
      // AgentDash (scan 3, lane G): how the author is signed in, so the CoS can
      // act with exactly their authority when it hands out a task.
      authorSource?: string | null;
      authorIsInstanceAdmin?: boolean;
      // The agents the author may see (null: all), resolved for their own
      // request. Called only when the CoS answers.
      authorVisibleAgentIds?: () => Promise<ReadonlySet<string> | null>;
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
      // Fail closed: a person whose visibility cannot be resolved sees no agents.
      let visibleAgentIds: ReadonlySet<string> | null = new Set<string>();
      if (input.authorVisibleAgentIds) {
        try {
          visibleAgentIds = await input.authorVisibleAgentIds();
        } catch {
          visibleAgentIds = new Set<string>();
        }
      }
      return deps.replier.reply({
        conversationId: input.conversationId,
        cosAgentId: cos.id,
        companyId: input.companyId,
        triggerMessageId: input.messageId,
        requestedBy: {
          userId: input.authorUserId,
          source: input.authorSource ?? null,
          isInstanceAdmin: input.authorIsInstanceAdmin === true,
          visibleAgentIds,
        },
      });
    },
  };
}
