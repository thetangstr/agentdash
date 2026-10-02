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
import { WORKFORCE_TEMPLATES, isAgentPlanPayload, type AgentPlanProposalV1Payload } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { DispatchMeter } from "./dispatch-llm.js";
import { DISPATCH_ERROR_CARD_KIND, postDispatchFailure } from "./cos-dispatch-failure.js";

const AGENT_PLAN_ADAPTER_TYPE_LIST = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
] as const;

// Prompt-facing rendering of the adapter list — byte-identical to the previous
// hand-written string: `"claude_local", "codex_local", ...`.
const AGENT_PLAN_ADAPTER_TYPES = AGENT_PLAN_ADAPTER_TYPE_LIST
  .map((adapterType) => `"${adapterType}"`)
  .join(", ");

// AgentDash: respect the configured default adapter when proposing agent teams.
// Falls back to hermes_local for backwards compatibility, but if the operator
// set AGENTDASH_DEFAULT_ADAPTER (e.g. claude_local for a customer install),
// proposed agents use that adapter type.
export function defaultAgentPlanAdapterType(): string {
  const configured = (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "").trim();
  if (
    configured &&
    (AGENT_PLAN_ADAPTER_TYPE_LIST as readonly string[]).includes(configured)
  ) {
    return configured;
  }
  return "hermes_local";
}

// AgentDash: shared catalog guidance for single, generated and revised proposals.
export const WORKFORCE_PROPOSAL_GUIDANCE = `Available workforce templates (version 1): ${WORKFORCE_TEMPLATES.map(template => `${template.id}: ${template.description}`).join("; ")}. Add optional workforceTemplateId to an agent only when the human explicitly selects that catalog role. Preserve existing selections when revising unrelated details. Ambiguous requests remain custom with the field omitted. A template describes work and grants no permissions; display role, authority and runtime remain independent. Creation starts learning; first-job acceptance requires artifact evidence and neutral review.`;

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
  // Compare-and-set: moves the phase only while it is still `fromPhase`.
  // Returns null when another reply already moved it.
  advancePhaseIf(
    conversationId: string,
    fromPhase: "goals" | "plan" | "materializing" | "ready",
    nextPhase: "goals" | "plan" | "materializing" | "ready",
  ): Promise<unknown | null>;
}

const PLAN_CARD_KIND = "agent_plan_proposal_v1";

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
  llm: (
    input: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    },
    meter?: DispatchMeter,
  ) => Promise<string>;
  // AgentDash (Cloud SKU, G3): when provided, the CoS reply is metered —
  // dispatchLLM writes a cost_events row for usage-based billing.
  db?: Db;
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

Once you have short-term + long-term + at least one constraint, transition to plan presentation by setting "phase_decision" to "advance_to_plan". Until then, keep it as "stay_in_goals". The plan is generated and shown right after a reply that advances, so never promise a plan ("let me pull together the plan") in a reply that stays in goals.

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

${WORKFORCE_PROPOSAL_GUIDANCE}

Propose a concrete agent team that hits this goal under the listed constraints and meets the success criteria. Use 2-5 agents. Each agent gets a role, a short human name, an adapterType (one of: ${AGENT_PLAN_ADAPTER_TYPES}), 2-4 responsibilities, and 1-3 KPIs. Prefer "${defaultAgentPlanAdapterType()}" for local/self-hosted deployments unless the user explicitly asks for another adapter.

In the visible body (before the JSON), give the user a short paragraph of rationale that references at least one constraint and one success criterion verbatim from the captured context, then a one-line tour of each agent. End with the question "Want me to set them up, or revise?"

Your reply MUST end with a fenced JSON block emitting an agent_plan_proposal_v1 payload:

\`\`\`json
{
  "phase_decision": "stay_in_plan" | "advance_to_materializing",
  "plan": {
    "rationale": "...",
    "agents": [
      { "role": "engineering_lead", "name": "Ellie", "adapterType": "${defaultAgentPlanAdapterType()}", "responsibilities": ["..."], "kpis": ["..."] }
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

${WORKFORCE_PROPOSAL_GUIDANCE}

Propose a concrete agent team that hits the short-term goal AND seeds the long-term one. Use 2-5 agents. Each agent gets a role, a short human name, an adapterType (one of: ${AGENT_PLAN_ADAPTER_TYPES}), 2-4 responsibilities, and 1-3 KPIs. Prefer "${defaultAgentPlanAdapterType()}" for local/self-hosted deployments unless the user explicitly asks for another adapter.

In the visible body (before the JSON), give the user a short paragraph of rationale and a one-line tour of each agent. End with the question "Want me to set them up, or revise?"

Your reply MUST end with a fenced JSON block:

\`\`\`json
{
  "phase_decision": "stay_in_plan" | "advance_to_materializing",
  "plan": {
    "rationale": "...",
    "agents": [
      { "role": "engineering_lead", "name": "Ellie", "adapterType": "${defaultAgentPlanAdapterType()}", "responsibilities": ["..."], "kpis": ["..."] }
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

// AgentDash (first-session stall): a goals-phase reply that announces the
// plan ("Let me pull together the working plan") without flipping
// phase_decision used to leave the user waiting for a plan that only came
// after they nudged the CoS. The server treats such a reply as an advance once
// the interview has what the plan needs. The wording must be about producing a
// plan or proposal ("put together the plan", "draft a proposal"); a mention of
// the team ("Let me ask about your current team.") or a question about plans
// does not count.
const PLAN_ANNOUNCEMENT_RES = [
  /\b(?:put|puts|putting|pull|pulls|pulling)\s+together\b[^.?!\n]{0,30}\b(?:plan|proposal)s?\b/i,
  /\b(?:put|puts|putting|pull|pulls|pulling)\b[^.?!\n]{0,30}\b(?:plan|proposal)s?\b\s+together\b/i,
  /\b(?:draft|drafts|drafting|build|builds|building|draw up|drawing up|sketch|sketching|prepare|preparing|write up|writing up)\b[^.?!\n]{0,30}\b(?:plan|proposal)s?\b/i,
];

export function announcesPlan(body: string): boolean {
  // Only statements count: a sentence that ends in "?" is asking, not announcing.
  const statements = body.split(/(?<=[.!?\n])/).filter((sentence) => !sentence.trim().endsWith("?"));
  return statements.some((sentence) => PLAN_ANNOUNCEMENT_RES.some((re) => re.test(sentence)));
}

export function goalsReadyForPlan(goals: CosStateRow["goals"]): boolean {
  const constraints = goals.constraints ?? {};
  return Boolean(goals.shortTerm?.trim()) && Boolean(goals.longTerm?.trim()) && Object.keys(constraints).length > 0;
}

function mergeGoals(
  current: CosStateRow["goals"],
  patch: { shortTerm?: string; longTerm?: string; constraints?: Record<string, unknown> },
): CosStateRow["goals"] {
  return {
    ...current,
    ...(patch.shortTerm !== undefined ? { shortTerm: patch.shortTerm } : {}),
    ...(patch.longTerm !== undefined ? { longTerm: patch.longTerm } : {}),
    constraints: { ...(current.constraints ?? {}), ...(patch.constraints ?? {}) },
  };
}

export function cosReplier(deps: Deps) {
  const cosState = deps.cosState;
  const deepInterviewSpecs = deps.deepInterviewSpecs;

  return {
    reply: async (input: { conversationId: string; cosAgentId: string; companyId?: string; triggerMessageId?: string }) => {
      const recent = await deps.conversations.paginate(input.conversationId, { limit: 20 });
      const messages = recent
        .slice()
        .reverse()
        // A "CoS couldn't reply" card is UI state, not something the CoS said.
        .filter((m: any) => m.cardKind !== DISPATCH_ERROR_CARD_KIND)
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

      // AgentDash (Cloud SKU, G3): meter the call when we have db + companyId.
      const meter: DispatchMeter | undefined =
        deps.db && input.companyId
          ? { db: deps.db, companyId: input.companyId, agentId: input.cosAgentId }
          : undefined;
      const text = await deps.llm({ system, messages }, meter);
      const { body, trailer } = parseTrailer(text);
      const visibleBody = body.length > 0 ? body : text.trimEnd();

      // AgentDash (GH: CoS replies only after a reload): every post carries the
      // companyId so the conversation service publishes `message.created` and
      // the open chat shows the reply live.
      const post = (messageBody: string) =>
        deps.conversations.postMessage({
          conversationId: input.conversationId,
          authorKind: "agent",
          authorId: input.cosAgentId,
          body: messageBody,
          companyId: input.companyId,
        });

      // Posts the visible body that introduces the plan, then the plan card,
      // then records the card as the current proposal. The intro goes first so
      // the chat reads "here is the plan" above the card rather than below it
      // (they used to be created 2ms apart in the other order). Throws only
      // when the card itself could not be posted; an intro or recording
      // failure is logged and the card stands (confirm-plan reads the latest
      // card).
      // Set once a plan intro is up, so a failed card post that lands in the
      // outer catch below does not post the same text a second time.
      let planIntroPosted = false;
      const postPlan = async (plan: AgentPlanProposalV1Payload, planBody: string) => {
        let introMsg: unknown = null;
        try {
          introMsg = await post(planBody);
          planIntroPosted = true;
        } catch (err) {
          logger.warn(
            { err, conversationId: input.conversationId },
            "cos-replier: could not post the plan intro; posting the card anyway",
          );
        }
        const cardMsg = await deps.conversations.postMessage({
          conversationId: input.conversationId,
          authorKind: "agent",
          authorId: input.cosAgentId,
          body: "",
          cardKind: PLAN_CARD_KIND,
          cardPayload: plan as unknown as Record<string, unknown>,
          companyId: input.companyId,
        });
        try {
          await cosState?.advancePhase(input.conversationId, "plan", {
            proposalMessageId: cardMsg?.id ?? null,
          });
        } catch (err) {
          logger.warn(
            { err, conversationId: input.conversationId },
            "cos-replier: plan card posted but recording it as the proposal failed",
          );
        }
        return introMsg ?? cardMsg;
      };

      const planCardExists = async (): Promise<boolean> => {
        if (typeof deps.conversations.hasCard === "function") {
          return Boolean(await deps.conversations.hasCard(input.conversationId, PLAN_CARD_KIND));
        }
        return recent.some((m: any) => m.cardKind === PLAN_CARD_KIND);
      };

      // Apply state transitions BEFORE posting messages so subsequent turns see the new phase.
      if (cosState && state) {
        try {
          await cosState.recordTurn(input.conversationId);
          if (state.phase === "goals") {
            const captured = trailer?.captured;
            let goals = state.goals ?? {};
            if (isGoalsPatch(captured)) {
              await cosState.setGoals(input.conversationId, captured);
              goals = mergeGoals(goals, captured);
            }
            const advance =
              trailer?.phase_decision === "advance_to_plan" ||
              (goalsReadyForPlan(goals) && announcesPlan(visibleBody));
            if (advance) {
              // AgentDash (first-session stall): run the plan turn now, in
              // the same reply, so the plan card arrives without the user
              // having to nudge the CoS. Only the reply that moves the phase
              // from "goals" to "plan" runs it, and only when no plan card
              // exists yet, so two messages at once yield one card.
              const claimed = await cosState.advancePhaseIf(input.conversationId, "goals", "plan");
              if (!claimed) return await post(visibleBody);
              // Any exit without a plan card gives the phase back, so the next
              // message retries the transition cleanly.
              const release = async (reason: string, err?: unknown) => {
                logger.warn({ err, conversationId: input.conversationId }, `cos-replier: ${reason}`);
                try {
                  await cosState.advancePhaseIf(input.conversationId, "plan", "goals");
                } catch (releaseErr) {
                  logger.warn(
                    { err: releaseErr, conversationId: input.conversationId },
                    "cos-replier: could not return the phase to goals",
                  );
                }
              };
              let goalsMsg: unknown;
              try {
                goalsMsg = await post(visibleBody);
                if (await planCardExists()) {
                  // A plan is already on the table; keep the phase at "plan".
                  return goalsMsg;
                }
              } catch (err) {
                await release("could not post the goals reply", err);
                return null;
              }
              let planText: string;
              try {
                planText = await deps.llm(
                  {
                    system: planPrompt({ ...state, phase: "plan", goals }),
                    messages: [...messages, { role: "assistant", content: visibleBody }],
                  },
                  meter,
                );
                await cosState.recordTurn(input.conversationId);
              } catch (err) {
                await release("follow-up plan turn failed", err);
                // The goals reply is up but the plan never came: say so, with a
                // Retry, instead of leaving the chat quiet.
                if (input.triggerMessageId) {
                  await postDispatchFailure(deps.conversations, {
                    conversationId: input.conversationId,
                    companyId: input.companyId ?? "",
                    authorId: input.cosAgentId,
                    retryMessageId: input.triggerMessageId,
                    err,
                  }).catch((postErr) =>
                    logger.warn({ err: postErr, conversationId: input.conversationId }, "cos-replier: could not post the plan failure card"),
                  );
                }
                return goalsMsg;
              }
              const planReply = parseTrailer(planText);
              const planBody = planReply.body.length > 0 ? planReply.body : planText.trimEnd();
              if (isAgentPlanPayload(planReply.trailer?.plan)) {
                try {
                  return await postPlan(planReply.trailer!.plan, planBody);
                } catch (err) {
                  await release("could not post the plan card", err);
                  return goalsMsg;
                }
              }
              await release("follow-up plan turn returned no valid plan payload");
              if (planBody && planBody !== visibleBody) {
                try {
                  return await post(planBody);
                } catch (err) {
                  logger.warn({ err, conversationId: input.conversationId }, "cos-replier: could not post the plan reply");
                }
              }
              return goalsMsg;
            }
          } else if (state.phase === "plan" && trailer) {
            // Plan phase: post visible body + a second message carrying the card.
            if (isAgentPlanPayload(trailer.plan)) {
              // Awaited so a failed card post lands in the catch below; the
              // phase is already "plan", so the next message retries.
              return await postPlan(trailer.plan, visibleBody);
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
            planIntroPosted
              ? "cos-replier: plan card could not be posted after its intro; the next message retries"
              : "cos-replier: failed to apply phase transition; posting body anyway",
          );
          if (planIntroPosted) return null;
        }
      } else if (!trailer && state) {
        logger.warn(
          { conversationId: input.conversationId, phase: state.phase },
          "cos-replier: no JSON trailer in LLM reply; staying in current phase",
        );
      }

      return post(visibleBody);
    },
  };
}
