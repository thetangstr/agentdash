// AgentDash: chat substrate typed card payload shapes

export interface ProposalPayload {
  name: string;
  role: string;
  oneLineOkr: string;
  rationale: string;
}

export interface InvitePromptPayload {
  companyId: string;
  conversationId: string;
}

export interface AgentStatusPayload {
  agentId: string;
  agentName: string;
  summary: string;
  severity: "info" | "warn" | "blocked";
}

export interface InterviewQuestionPayload {
  question: string;
  fixedIndex?: number;
}
