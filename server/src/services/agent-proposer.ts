import { workforceTemplateIdSchema, type AgentProposal, type InterviewTurn } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

interface Deps {
  llm: (transcript: InterviewTurn[]) => Promise<AgentProposal>;
}

export function agentProposer(deps: Deps) {
  return {
    propose: async (transcript: InterviewTurn[]): Promise<AgentProposal> => {
      if (transcript.length === 0) {
        throw new Error("Cannot propose an agent from an empty transcript");
      }
      const proposal = await deps.llm(transcript);
      if (proposal.workforceTemplateId !== undefined && !workforceTemplateIdSchema.safeParse(proposal.workforceTemplateId).success) {
        throw badRequest("Unknown workforce template");
      }
      return proposal;
    },
  };
}
