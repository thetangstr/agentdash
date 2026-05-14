// AgentDash: phase-aware Chief-of-Staff replier.
//
// Reads the per-conversation cos_onboarding_state, builds a prompt scoped to
// the current phase, asks the LLM to emit a fenced ```json trailer that
// captures (a) goals deltas + a phase decision in 'goals' phase or (b) the
// full plan payload in 'plan' phase. The trailer is parsed off the visible
// body before posting; phase transitions and goal patches are applied to
// cos_onboarding_state.
//
// Tolerates malformed/missing trailers: posts the body as-is and skips the
// transition; the next user turn re-runs the prompt.

import { logger } from "../middleware/logger.js";
import { isAgentPlanPayload, type AgentPlanProposalV1Payload } from "@paperclipai/shared";

interface CosStateRow {
  conversationId: string;
  phase: string;
  goals: { shortTerm?: string; longTerm?: string; constraints?: Record<string, unknown> };
  proposalMessageId: string | null;
  turnsInPhase: number;
  // AgentDash (Phase F): when set, the deep-interview engine has already
  // crystallized a spec for this conversation; cos-replier reads the spec
  // and skips Phase 1 (goals capture).
  deepInterviewSpecId?: string | null;
}

interface CosStateService {
  getOrCreate(conversationId: string): Promise<CosStateRow>;
  recordTurn(conversationId: string): Promise<unknown>;
  setGoals(
    conversationId: string,
    goalsPatch: { shortTerm?: string; longTerm?: string; constraints?: Record<string, unknown> },
  ): Promise<unknown>;
  advancePhase(
    conversationId: string,
    nextPhase: "goals" | "plan" | "materializing" | "ready",
    opts?: { proposalMessageId?: string | null },
  ): Promise<unknown>;
}

// AgentDash (Phase F): minimal spec view that the cos-replier reads from a
// deep_interview_specs row. Mirrors the columns the prompt builder needs.
export interface DeepInterviewSpecView {
  goal: string;
  constraints: unknown[];
  criteria: unknown[];
}

export interface DeepInterviewSpecsService {
  getById(specId: string): Promise<DeepInterviewSpecView | null>;
}

interface Deps {
  conversations: any; // conversationService
  llm: (input: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }) => Promise<string>;
  cosState?: CosStateService;
  // AgentDash (Phase F): deep-interview spec loader. When provided AND the
  // current conversation's cos_onboarding_state has a deepInterviewSpecId,
  // cos-replier builds a "spec-aware" plan-phase prompt instead of running
  // Phase 1 (goals capture).
  deepInterviewSpecs?: DeepInterviewSpecsService;
}

const STEADY_STATE_PROMPT = `You are the Chief of Staff in an AgentDash workspace. Be warm, concise, and specific. When a human asks about an agent's progress, answer based on the conversation history. If you don't have the data, say so plainly. No greetings, no preamble, no markdown headings.`;

function goalsPrompt(state: CosStateRow): string {
  return `You are the Chief of Staff for AgentDash. The user just signed up. Your job RIGHT NOW is to capture three things:

1. Their short-term goal (next 0-3 months).
2. Their long-term goal (6-12 months).
3. At least one concrete constraint they volunteer (team size, monthly budget, urgency, current tooling, headcount, existing infra, or anything else that sizes the plan).

You already have so far:
${JSON.stringify(state.goals, null, 2)}

Ask the ONE most useful clarifying question per turn — never generic "tell me more". Reflect what you heard back in your own words first ("So short-term you want X, long-term you want Y. Got it."), then ask the next sharpest question.

Once you have short-term + long-term + at least one constraint, transition to plan presentation by setting "phase_decision" to "advance_to_plan". Until then, keep it as "stay_in_goals".

Your reply MUST end with a fenced JSON block like:

\`\`\`json
{ "captured": { "shortTerm": "...", "longTerm": "...", "constraints": { "teamSize": 12 } }, "phase_decision": "stay_in_goals" | "advance_to_plan", "next_question": "..." }
\`\`\`

The "captured" object is a delta — only include keys you newly heard this turn. Omit a key when nothing new was said about it.

The visible chat body comes BEFORE the fenced block. Do not repeat the JSON in prose. No greetings. No markdown headings.`;
}

// AgentDash (Phase F): plan-phase prompt fed by a crystallized deep-interview
// spec. The interview already captured goal/constraints/criteria via the
// Socratic engine, so the LLM jumps directly to plan presentation. The
// "ALREADY-CAPTURED" framing tells the model not to re-ask Phase 1 questions.
function planPromptFromSpec(spec: DeepInterviewSpecView): string {
  const constraintsJson = JSON.stringify(spec.constraints, null, 2);
  const criteriaJson = JSON.stringify(spec.criteria, null, 2);
  return `You are the Chief of Staff for AgentDash. The user already completed a deep-interview, so goals, constraints, and success criteria are ALREADY-CAPTURED. Do NOT re-ask Phase 1 (goals capture) questions; jump directly to Phase 2 (plan presentation).

ALREADY-CAPTURED CONTEXT
Goal: ${spec.goal}
Constraints: ${constraintsJson}
Success criteria: ${criteriaJson}

Propose a concrete agent team that hits this goal under the listed constraints and meets the success criteria. Use 2-5 agents. Each agent gets a role, a short human name, an adapterType (one of: "claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local"), 2-4 responsibilities, and 1-3 KPIs.

In the visible body (before the JSON), give the user a short paragraph of rationale that references at least one constraint and one success criterion verbatim from the captured context, then a one-line tour of each agent. End with the question "Want me to set them up, or revise?"

Your reply MUST end with a fenced JSON block emitting an agent_plan_proposal_v1 payload:

\`\`\`json
{
  "phase_decision": "stay_in_plan" | "advance_to_materializing",
  "plan": {
    "rationale": "...",
    "agents": [
      { "role": "engineering_lead", "name": "Ellie", "adapterType": "claude_local", "responsibilities": ["..."], "kpis": ["..."] }
    ],
    "alignmentToShortTerm": "...",
    "alignmentToLongTerm": "..."
  }
}
\`\`\`

Set phase_decision to "stay_in_plan" the first time you propose — the user confirms or revises before we materialize.

No greetings. No markdown headings outside the JSON block.`;
}

function planPrompt(state: CosStateRow): string {
  return `You are the Chief of Staff for AgentDash. Goals captured:
${JSON.stringify(state.goals, null, 2)}

Propose a concrete agent team that hits the short-term goal AND seeds the long-term one. Use 2-5 agents. Each agent gets a role, a short human name, an adapterType (one of: "claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local"), 2-4 responsibilities, and 1-3 KPIs.

In the visible body (before the JSON), give the user a short paragraph of rationale and a one-line tour of each agent. End with the question "Want me to set them up, or revise?"

Your reply MUST end with a fenced JSON block:

\`\`\`json
{
  "phase_decision": "stay_in_plan" | "advance_to_materializing",
  "plan": {
    "rationale": "...",
    "agents": [
      { "role": "engineering_lead", "name": "Ellie", "adapterType": "claude_local", "responsibilities": ["..."], "kpis": ["..."] }
    ],
    "alignmentToShortTerm": "...",
    "alignmentToLongTerm": "..."
  }
}
\`\`\`

Set phase_decision to "stay_in_plan" the first time you propose — the user confirms or revises before we materialize. Only advance when the user has clearly accepted.

No greetings. No markdown headings outside the JSON block.`;
}

interface ParsedTrailer {
  body: string;
  trailer: Record<string, unknown> | null;
}

const FENCED_JSON_RE = /```json\s*([\s\S]*?)```\s*$/i;

export function parseTrailer(raw: string): ParsedTrailer {
  const match = raw.match(FENCED_JSON_RE);
  if (!match) return { body: raw.trimEnd(), trailer: null };
  const body = raw.slice(0, match.index).trimEnd();
  try {
    const parsed = JSON.parse(match[1]!.trim()) as Record<string, unknown>;
    return { body, trailer: parsed };
  } catch {
    return { body: raw.trimEnd(), trailer: null };
  }
}

function isGoalsPatch(
  value: unknown,
): value is { shortTerm?: string; longTerm?: string; constraints?: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.shortTerm !== undefined && typeof v.shortTerm !== "string") return false;
  if (v.longTerm !== undefined && typeof v.longTerm !== "string") return false;
  if (v.constraints !== undefined && (typeof v.constraints !== "object" || v.constraints === null)) {
    return false;
  }
  return true;
}

export function cosReplier(deps: Deps) {
  const cosState = deps.cosState;
  const deepInterviewSpecs = deps.deepInterviewSpecs;

  return {
    reply: async (input: { conversationId: string; cosAgentId: string }) => {
      const recent = await deps.conversations.paginate(input.conversationId, { limit: 20 });
      const messages = recent
        .slice()
        .reverse()
        .map((m: any) => ({
          role: m.role === "agent" ? "assistant" : "user",
          content: m.content,
        })) as Array<{ role: "user" | "assistant"; content: string }>;

      // Phase-aware system prompt, falling back to steady-state when cosState is unavailable.
      let state: CosStateRow | null = null;
      let system = STEADY_STATE_PROMPT;
      if (cosState) {
        try {
          state = await cosState.getOrCreate(input.conversationId);
          // AgentDash (Phase F): if a deep-interview spec is linked to this
          // conversation, build the plan prompt from the spec and SKIP Phase 1
          // (goals capture). When no spec is set, fall back to legacy
          // phase-aware prompts so in-flight conversations and assess-flag-OFF
          // users keep working.
          let specView: DeepInterviewSpecView | null = null;
          if (state.deepInterviewSpecId && deepInterviewSpecs) {
            try {
              specView = await deepInterviewSpecs.getById(
                state.deepInterviewSpecId,
              );
            } catch (err) {
              logger.warn(
                {
                  err,
                  conversationId: input.conversationId,
                  specId: state.deepInterviewSpecId,
                },
                "cos-replier: deep-interview spec lookup failed; falling back to phase-aware prompt",
              );
            }
          }

          if (specView) {
            // Spec-driven path: always plan-presentation, regardless of the
            // (possibly-stale) phase column.
            system = planPromptFromSpec(specView);
            // Force the in-memory state phase to "plan" so the trailer
            // handler below takes the plan-card branch.
            state = { ...state, phase: "plan" };
          } else if (state.phase === "goals") {
            system = goalsPrompt(state);
          } else if (state.phase === "plan") {
            system = planPrompt(state);
          } else if (
            state.phase === "materializing" ||
            state.phase === "ready"
          ) {
            system = STEADY_STATE_PROMPT;
          }
        } catch (err) {
          logger.warn(
            { err, conversationId: input.conversationId },
            "cos-replier: cosState lookup failed, using steady-state prompt",
          );
        }
      }

      const text = await deps.llm({ system, messages });
      const { body, trailer } = parseTrailer(text);
      const visibleBody = body.length > 0 ? body : text.trimEnd();

      // Apply state transitions BEFORE posting messages so subsequent turns see the new phase.
      if (cosState && state) {
        try {
          await cosState.recordTurn(input.conversationId);
          if (state.phase === "goals" && trailer) {
            const captured = trailer.captured;
            if (isGoalsPatch(captured)) {
              await cosState.setGoals(input.conversationId, captured);
            }
            if (trailer.phase_decision === "advance_to_plan") {
              await cosState.advancePhase(input.conversationId, "plan");
            }
          } else if (state.phase === "plan" && trailer) {
            // Plan phase: post visible body + a second message carrying the card.
            if (isAgentPlanPayload(trailer.plan)) {
              const cardMsg = await deps.conversations.postMessage({
                conversationId: input.conversationId,
                authorKind: "agent",
                authorId: input.cosAgentId,
                body: "",
                cardKind: "agent_plan_proposal_v1",
                cardPayload: trailer.plan as unknown as Record<string, unknown>,
              });
              await cosState.advancePhase(input.conversationId, "plan", {
                proposalMessageId: cardMsg?.id ?? null,
              });
              return deps.conversations.postMessage({
                conversationId: input.conversationId,
                authorKind: "agent",
                authorId: input.cosAgentId,
                body: visibleBody,
              });
            }
            if (!trailer.plan) {
              logger.warn(
                { conversationId: input.conversationId },
                "cos-replier: plan-phase reply missing plan payload",
              );
            }
          }
        } catch (err) {
          logger.warn(
            { err, conversationId: input.conversationId },
            "cos-replier: failed to apply phase transition; posting body anyway",
          );
        }
      } else if (!trailer && state) {
        logger.warn(
          { conversationId: input.conversationId, phase: state.phase },
          "cos-replier: no JSON trailer in LLM reply; staying in current phase",
        );
      }

      return deps.conversations.postMessage({
        conversationId: input.conversationId,
        authorKind: "agent",
        authorId: input.cosAgentId,
        body: visibleBody,
      });
    },
  };
}
