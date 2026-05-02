export type InterviewTurnRole = "user" | "assistant";

export interface InterviewTurn {
  role: InterviewTurnRole;
  content: string;
  ts: string;
}

export interface InterviewState {
  conversationId: string;
  turns: InterviewTurn[];
  fixedQuestionsAsked: number; // 0..3
  followUpsAsked: number;      // 0..4
  status: "in_progress" | "ready_to_propose" | "exceeded_max";
}

export const INTERVIEW_MAX_TURNS = 7;
export const FIXED_QUESTIONS = [
  "What's your business and who's it for?",
  "What's eating your time most this month?",
  "What does success look like 90 days from now?",
] as const;

export interface AgentProposal {
  name: string;
  role: string;
  oneLineOkr: string;
  rationale: string;
}
