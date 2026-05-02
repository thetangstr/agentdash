interface Deps {
  conversations: any;
  agents: { getById: (id: string) => Promise<any> };
  cosResolver: { findByCompany: (companyId: string) => Promise<any> };
  router: { classify: (a: any) => { chatWorthy: boolean; summary?: string; severity?: string } };
}

export function cosProactive(deps: Deps) {
  return {
    onActivity: async (event: { kind: string; agentId: string; companyId: string; payload?: any }) => {
      const c = deps.router.classify(event);
      if (!c.chatWorthy) return;
      const [conv, agent, cos] = await Promise.all([
        deps.conversations.findByCompany(event.companyId),
        deps.agents.getById(event.agentId),
        deps.cosResolver.findByCompany(event.companyId),
      ]);
      if (!conv || !cos || !agent) return;
      await deps.conversations.postMessage({
        conversationId: conv.id,
        authorKind: "agent",
        authorId: cos.id,
        body: `${agent.name}: ${c.summary}`,
        cardKind: "agent_status_v1",
        cardPayload: {
          agentId: agent.id,
          agentName: agent.name,
          summary: c.summary,
          severity: c.severity,
        },
      });
    },
  };
}
