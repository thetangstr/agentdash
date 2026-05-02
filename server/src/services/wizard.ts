// AgentDash: wizard service — orchestrates agent creation via meta-prompt + template generation
import type { Db } from "@agentdash/db";
import { AGENT_ROLE_LABELS } from "@agentdash/shared";
import type { AgentRole, AgentTone, CreateAgentWizard } from "@agentdash/shared";
import { logger } from "../middleware/logger.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { routineService } from "./routines.js";

// AgentDash: frequency to cron expression mapping
const FREQUENCY_TO_CRON: Record<string, string> = {
  every_30m: "*/30 * * * *",
  hourly: "0 * * * *",
  daily: "0 9 * * *",
};

// AgentDash: tone descriptions for prompt and template generation
const TONE_DESCRIPTIONS: Record<AgentTone, string> = {
  professional: "formal, precise, and business-appropriate",
  friendly: "warm, approachable, and conversational",
  direct: "concise, no-nonsense, and action-oriented",
};

function getRoleLabel(role: string): string {
  if (role === "custom") return "Custom";
  return AGENT_ROLE_LABELS[role as AgentRole] ?? role;
}

// AgentDash: exported for testing
export function buildWizardMetaPrompt(input: {
  purpose: string;
  name: string;
  tone: AgentTone;
  role: string;
  customRole?: string;
  schedule?: { frequency: string; cronExpression?: string };
}): string {
  const roleLabel = input.role === "custom" && input.customRole ? input.customRole : getRoleLabel(input.role);
  const toneDesc = TONE_DESCRIPTIONS[input.tone] ?? input.tone;
  const scheduleNote = input.schedule
    ? `\n- Schedule: runs ${input.schedule.frequency} (${FREQUENCY_TO_CRON[input.schedule.frequency] ?? input.schedule.cronExpression ?? input.schedule.frequency})`
    : "";

  return `You are generating instructions for an AI agent named "${input.name}".

Agent details:
- Name: ${input.name}
- Role: ${roleLabel}
- Purpose: ${input.purpose}
- Communication tone: ${input.tone} (${toneDesc})${scheduleNote}

Generate three markdown instruction files for this agent:

## SOUL.md
The agent's identity, values, and principles. Include:
- Mission statement derived from the purpose
- Core principles (3-5 bullet points)
- Communication style guidelines based on the ${input.tone} tone
- Boundaries and constraints

## AGENTS.md
The agent's operational instructions. Include:
- Role description for ${roleLabel}
- Primary responsibilities derived from: ${input.purpose}
- Key skills and capabilities
- Collaboration guidelines

## HEARTBEAT.md
The agent's recurring task execution template. Include:
- On Each Heartbeat: step-by-step actions
- Monitoring and status checks
- Escalation criteria

Return the content for each file clearly separated.`;
}

function generateSoulMd(input: CreateAgentWizard): string {
  const toneDesc = TONE_DESCRIPTIONS[input.tone] ?? input.tone;
  const roleLabel = input.role === "custom" && input.customRole ? input.customRole : getRoleLabel(input.role);
  return `# SOUL.md — ${input.name}

## Mission
${input.purpose}

## Core Principles
- Act with integrity and transparency in all interactions
- Prioritize accuracy and completeness in every response
- Escalate issues that exceed defined authority or risk thresholds
- Continuously learn from feedback and outcomes
- Respect company policies and security boundaries

## Communication Style
Role: ${roleLabel}
Tone: ${input.tone} — ${toneDesc}

All communications should be ${toneDesc}. Adapt language to the audience while
maintaining consistency with the stated tone.

## Boundaries
- Do not take irreversible actions without explicit confirmation
- Do not access systems or data outside the defined scope
- Do not share confidential information with unauthorized parties
- Escalate ambiguous situations rather than guessing
`;
}

function generateAgentsMd(input: CreateAgentWizard): string {
  const roleLabel = input.role === "custom" && input.customRole ? input.customRole : getRoleLabel(input.role);
  return `# AGENTS.md — ${input.name}

## Role
${roleLabel}

## Purpose
${input.purpose}

## Primary Responsibilities
- Execute tasks aligned with the stated purpose
- Monitor relevant signals and surface actionable insights
- Coordinate with other agents and humans as needed
- Maintain accurate records of actions taken

## Key Skills
- Task execution and follow-through
- Clear communication and status reporting
- Issue identification and escalation
- Structured data analysis and synthesis

## Collaboration
- Report blockers and decisions requiring human input
- Provide status updates on in-progress work
- Request clarification when requirements are ambiguous
`;
}

function generateHeartbeatMd(input: CreateAgentWizard): string {
  const scheduleNote = input.schedule
    ? `Runs on schedule: ${input.schedule.frequency}`
    : "Triggered on demand or by schedule";
  return `# HEARTBEAT.md — ${input.name}

## Overview
${scheduleNote}

## On Each Heartbeat

1. **Review context** — Check for new inputs, messages, or pending items
2. **Assess priorities** — Identify the highest-value actions given current state
3. **Execute tasks** — Carry out actions within defined scope and authority
4. **Record outcomes** — Log what was done, what was skipped, and why
5. **Escalate if needed** — Flag anything requiring human attention

## Monitoring
- Verify all critical systems and integrations are responsive
- Check for anomalies or unexpected conditions
- Confirm previous heartbeat tasks completed successfully

## Escalation Criteria
- Unexpected errors or system failures
- Tasks requiring authority beyond current permissions
- Ambiguous instructions with significant downstream impact
- Budget or capacity constraints approaching limits
`;
}

// AgentDash: wizard service factory
export function wizardService(db: Db) {
  const agentSvc = agentService(db);
  const instructionsSvc = agentInstructionsService();
  const routineSvc = routineService(db);

  return {
    createAgent: async (
      companyId: string,
      projectId: string,
      input: CreateAgentWizard,
      actorUserId: string,
    ) => {
      const roleForAgent = (input.role === "custom" ? "general" : input.role) as AgentRole;

      // Step 1: create the agent record
      const agent = await agentSvc.create(companyId, {
        name: input.name,
        role: roleForAgent,
        title: input.role === "custom" && input.customRole ? input.customRole : null,
        adapterType: "claude_local",
        adapterConfig: {},
      });

      // Step 2: build template markdown files from input
      const files: Record<string, string> = {
        "SOUL.md": generateSoulMd(input),
        "AGENTS.md": generateAgentsMd(input),
        "HEARTBEAT.md": generateHeartbeatMd(input),
      };

      // Step 3: materialize the managed instructions bundle
      const { adapterConfig } = await instructionsSvc.materializeManagedBundle(agent, files, {
        replaceExisting: true,
        entryFile: "AGENTS.md",
      });

      // Step 4: update agent with the new adapterConfig from materialization
      const updatedAgent = await agentSvc.update(agent.id, { adapterConfig });

      // GH #71: provision a default API key so external adapters can call
      // back to /api/* immediately. The token is returned once here and is
      // never re-exposed by GET /agents/:id/keys.
      const apiKey = await agentSvc.createApiKey(agent.id, "default");

      // Step 5: optionally create a routine if a schedule was provided
      let routineId: string | null = null;
      if (input.schedule) {
        const cronExpression =
          input.schedule.cronExpression ?? FREQUENCY_TO_CRON[input.schedule.frequency];
        if (!cronExpression) {
          logger.warn({ frequency: input.schedule.frequency }, "wizard: unknown frequency, skipping routine creation");
        } else {
          const routine = await routineSvc.create(
            companyId,
            {
              projectId,
              title: `${input.name} — scheduled run`,
              assigneeAgentId: agent.id,
              status: "active",
              priority: "medium",
              concurrencyPolicy: "coalesce_if_active",
              catchUpPolicy: "skip_missed",
              variables: [],
            },
            { userId: actorUserId },
          );
          routineId = routine?.id ?? null;
        }
      }

      return { agent: updatedAgent ?? agent, routineId, apiKey };
    },
  };
}
