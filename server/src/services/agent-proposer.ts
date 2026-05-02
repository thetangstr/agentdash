import type { AgentProposal, InterviewTurn } from "@paperclipai/shared";

interface Deps {
  llm: (transcript: InterviewTurn[]) => Promise<AgentProposal>;
}

export function agentProposer(deps: Deps) {
  return {
    propose: async (transcript: InterviewTurn[]): Promise<AgentProposal> => {
      if (transcript.length === 0) {
        throw new Error("Cannot propose an agent from an empty transcript");
      }
      return deps.llm(transcript);
    },
  };
}
