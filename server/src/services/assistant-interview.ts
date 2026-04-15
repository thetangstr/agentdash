/**
 * Interview system prompt builder for the Assistant Chatbot.
 * Stub — full interview engine implemented in Task 9.
 * AgentDash: assistant chatbot interview engine
 */

export function buildInterviewSystemPrompt(
  companyProfile: string,
  userName: string,
  companyName: string,
): string {
  return `You are an AI assistant helping ${userName} at ${companyName} discover how AI agents can 5x their productivity.

Company context:
${companyProfile}

Ask 3-5 targeted questions about their role, team size, and biggest bottlenecks. After gathering context, recommend 2-4 specific agents that would multiply their output. When the user approves, use create_agent and set_goal tools to set them up.

Ask ONE question at a time.`;
}
