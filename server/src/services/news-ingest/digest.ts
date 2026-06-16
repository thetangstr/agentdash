// server/src/services/news-ingest/digest.ts
export interface DigestRow { agentId: string; agentName: string; title: string; beat: string; }
export interface Digest { agentId: string; agentName: string; title: string; body: string; count: number; }

export function buildDigests(rows: DigestRow[], cos: { atlasAgentId: string; atlasName: string }): Digest[] {
  const byAgent = new Map<string, DigestRow[]>();
  for (const r of rows) {
    const list = byAgent.get(r.agentId) ?? [];
    list.push(r);
    byAgent.set(r.agentId, list);
  }
  const digests: Digest[] = [];
  for (const [agentId, list] of byAgent) {
    digests.push({
      agentId,
      agentName: list[0].agentName,
      title: `${list[0].agentName} — daily desk digest (${list.length} events)`,
      body: list.map((r) => `- ${r.title}`).join("\n"),
      count: list.length,
    });
  }
  digests.push({
    agentId: cos.atlasAgentId,
    agentName: cos.atlasName,
    title: `Atlas Wire — daily wire digest (${rows.length} events)`,
    body: digests.map((d) => `- ${d.agentName}: ${d.count}`).join("\n"),
    count: rows.length,
  });
  return digests;
}
