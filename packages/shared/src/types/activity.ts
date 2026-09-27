export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  /**
   * AgentDash (consolidation PR-C): "server" when a server route wrote the row
   * with the actor from the authenticated principal; "manual" when a board user
   * posted it by hand; null for rows written before the column existed.
   */
  origin?: "server" | "manual" | null;
  createdAt: Date;
}
