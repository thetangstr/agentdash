import type { Agent } from "./agent.js";

export interface AgentStewardship {
  id: string;
  companyId: string;
  agentId: string;
  userId: string;
  assignedByUserId: string | null;
  endedByUserId: string | null;
  transferReason: string | null;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentStewardshipWithAgent {
  stewardship: AgentStewardship;
  agent: Agent;
}

export interface AssignAgentStewardship {
  agentId: string;
  userId: string;
}

export interface TransferAgentStewardship {
  userId: string;
  transferReason?: string | null;
}
