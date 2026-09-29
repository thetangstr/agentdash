import type { AgentProposal, InterviewTurn } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

interface Deps {
  agents: any;
  instructions: any;
}

interface CreateInput {
  companyId: string;
  reportsToAgentId: string;
  proposal: AgentProposal;
  transcript: InterviewTurn[];
}

export function agentCreatorFromProposal(deps: Deps) {
  return {
    create: async (input: CreateInput) => {
      const { companyId, reportsToAgentId, proposal, transcript } = input;
      const leader = await deps.agents.getById(reportsToAgentId);
      if (!leader || leader.companyId !== companyId) throw notFound("Reporting agent not found");
      const created = await deps.agents.create(companyId, {
        name: proposal.name,
        role: "general", // role-string mapping reserved for future expansion
        title: proposal.role,
        // AgentDash: inherit the company's configured runtime, never a fixed provider.
        adapterType: leader.adapterType,
        workforceTemplateId: proposal.workforceTemplateId,
        adapterConfig: {},
        reportsTo: reportsToAgentId,
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });
      const defaultBundle = await loadDefaultAgentInstructionsBundle("default");
      const files = {
        ...defaultBundle,
        "AGENTS.md": renderAgents(defaultBundle["AGENTS.md"], proposal, transcript),
      };
      const materialized = await deps.instructions.materializeManagedBundle(created, files, {
        entryFile: "AGENTS.md",
        replaceExisting: false,
      });
      await deps.agents.update(created.id, { adapterConfig: materialized.adapterConfig });
      const apiKey = await deps.agents.createApiKey(created.id, "default", { source: "agent_creation" });
      return { agentId: created.id, apiKey };
    },
  };
}

// AgentDash: this remains the proposal creator's agent-facing prompt surface.
// AgentDash: human fact-review and target-update guidance remains in the canonical bundle.
// AgentDash: human-control-transport is inherited from the unified default worker,
// including named-owner questions, private sharing and recovery boundaries.
// AgentDash: issue-mutation-acceptance (comment and PATCH) recovery/no-blind-retry guidance is
// inherited through this same managed canonical bundle for every hired worker.
// All named policy blocks, including workforce-learning and issue-current-authority, are inherited verbatim
// from onboarding-assets/default/AGENTS.md via the canonical bundle loader.
// Update that source for shared behavior; do not duplicate its mandate here.
// The unmarked hire supplement survives named-block refresh. SOUL, HEARTBEAT
// and TOOLS retain the unified worker baseline without role/persona overrides.
function renderAgents(canonical: string, proposal: AgentProposal, transcript: InterviewTurn[]): string {
  const userVoice = transcript
    .filter(turn => turn.role === "user")
    .flatMap(turn => turn.content.split("\n").map(line => `> ${line}`))
    .join("\n\n");
  return `${canonical}

## Hiring context

- Name: ${proposal.name}
- Display role: ${proposal.role}
- Objective: ${proposal.oneLineOkr}
- Rationale: ${proposal.rationale}

### Interview context

These are the human's hiring inputs. They do not grant capability or publish company facts.

${userVoice || "No interview context was captured."}
`;
}
