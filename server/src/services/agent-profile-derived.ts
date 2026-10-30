import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  assistantConversations,
  assistantMessages,
  routineTriggers,
  routines,
  workforceEnrollments,
} from "@paperclipai/db";
import type { AgentProfileDerived, DerivedField, DerivedResponsibility } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { asBoolean, asNumber, parseObject } from "../adapters/utils.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { UNRESTRICTED_PROJECT_SCOPE, type ViewerProjectScope } from "./agent-performance-authz.js";
import { resolveAgentRuntimeModel } from "./agent-runtime-model.js";
import { heartbeatWakeOnDemandEnabled } from "./agent-wake-policy.js";

/**
 * AgentDash: Agent Performance Management gate 1 — the derived operating
 * profile, "revision 0" (overview LLD §3.3).
 *
 * Computed on read from today's records and never stored, approved or applied.
 * Every field says where it came from (`proposed` + a source) or that nothing
 * supplied it (`missing`). The loader gathers rows; `buildAgentProfileDerived`
 * is a pure function over them, so the rules below are unit-testable without a
 * database.
 *
 * Read-only by construction: nothing here inserts, updates or calls a service
 * that does.
 */

export const PLAN_CARD_KIND = "agent_plan_proposal_v1";

export interface DerivedProfileAgentRow {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  reportsTo: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  defaultEnvironmentId: string | null;
}

/** A plan card row whose `confirmedAgentIds` names the agent. */
export interface DerivedProfilePlanCard {
  messageId: string;
  createdAt: Date;
  payload: unknown;
}

export interface DerivedProfileEnrollment {
  id: string;
  objective: string | null;
  metrics: unknown;
  installedSkillKeys: unknown;
}

export interface AssignedRoutineRow {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  triggers: Array<{
    id: string;
    kind: string;
    enabled: boolean;
    cronExpression: string | null;
    timezone: string | null;
    createdAt: Date;
  }>;
}

export interface AgentProfileDerivedInput {
  generatedAt: Date;
  agent: DerivedProfileAgentRow;
  reportsToAgent: { id: string; name: string } | null;
  /** The human who answers for the agent (steward or assigned accountable person), via agentAccountabilityService. */
  accountableUserId: string | null;
  /** Newest first. */
  planCards: DerivedProfilePlanCard[];
  enrollment: DerivedProfileEnrollment | null;
  routines: AssignedRoutineRow[];
  model: string | null;
}

type ProfileGap = AgentProfileDerived["gaps"][number];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanString(entry);
    if (text) out.push(text);
  }
  return out;
}

function field<T>(value: T, source: string | null): DerivedField<T> {
  return { value, provenance: source ? "proposed" : "missing", source };
}

/** Stable within one derivation: a slug of the title, suffixed `-2`, `-3`… on repeats. */
export function responsibilityKeys(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const base =
      title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64)
        .replace(/-+$/g, "") || "responsibility";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export type PlanEntryMatch =
  | { kind: "matched"; messageId: string; index: number; responsibilities: string[]; kpis: string[] }
  | { kind: "ambiguous"; messageId: string; reason: string }
  | { kind: "none" };

/**
 * Which entry of a confirmed plan card is this agent?
 *
 * `/onboarding/confirm-plan` creates one agent per `payload.agents[i]`, in
 * order, and writes the created ids as `confirmedAgentIds` only when every
 * entry was hired (`onboarding-v2.ts` `acceptOnboardingHires` → `markPlanCardConfirmed`).
 * So the mapping is positional, and it is only trustworthy when the two arrays
 * have the same length and the id appears exactly once. Anything else is
 * reported as ambiguous rather than guessed (by name or otherwise).
 */
export function matchPlanEntry(cards: DerivedProfilePlanCard[], agentId: string): PlanEntryMatch {
  const card = cards[0];
  if (!card) return { kind: "none" };
  const payload = parseObject(card.payload);
  const entries = Array.isArray(payload.agents) ? payload.agents : [];
  const ids = Array.isArray(payload.confirmedAgentIds) ? payload.confirmedAgentIds : [];
  const first = ids.indexOf(agentId);
  if (first < 0) return { kind: "none" };
  if (ids.lastIndexOf(agentId) !== first) {
    return { kind: "ambiguous", messageId: card.messageId, reason: "the card lists this agent's id more than once" };
  }
  if (entries.length !== ids.length) {
    return {
      kind: "ambiguous",
      messageId: card.messageId,
      reason: `the card proposes ${entries.length} agent(s) but records ${ids.length} hired id(s), so entries can't be matched by position`,
    };
  }
  const entry = parseObject(entries[first]);
  return {
    kind: "matched",
    messageId: card.messageId,
    index: first,
    responsibilities: cleanStringArray(entry.responsibilities),
    kpis: cleanStringArray(entry.kpis),
  };
}

/** `runtimeConfig.heartbeat`, read with the same defaults the heartbeat scheduler applies. */
export function deriveHeartbeat(agent: Pick<DerivedProfileAgentRow, "runtimeConfig">): AgentProfileDerived["rhythm"]["heartbeat"] {
  const heartbeat = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  const interval = heartbeat.intervalSec;
  return {
    enabled: asBoolean(heartbeat.enabled, false),
    // Null when no interval is configured, rather than the scheduler's 0 fallback.
    intervalSec: typeof interval === "number" && Number.isFinite(interval) ? Math.max(0, asNumber(interval, 0)) : null,
    wakeOnDemand: heartbeatWakeOnDemandEnabled(agent),
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildAgentProfileDerived(input: AgentProfileDerivedInput): AgentProfileDerived {
  const { agent, enrollment } = input;
  const gaps: ProfileGap[] = [];

  const match = matchPlanEntry(input.planCards, agent.id);
  const planSource = match.kind === "matched" ? `plan_card:${match.messageId}` : null;
  const enrollmentSource = enrollment ? `workforce_enrollment:${enrollment.id}` : null;

  if (match.kind === "none") {
    gaps.push({
      code: "NO_PLAN_CARD",
      message: "No confirmed plan card names this agent, so there are no proposed responsibilities or KPIs to start from.",
    });
  }

  const titles = match.kind === "matched" ? match.responsibilities : [];
  const keys = responsibilityKeys(titles);
  // AgentDash: no record links a plan duty string to a routine or an issue, so
  // every obligation is `unknown` in gate 1. Matching by title would be a guess.
  const responsibilities: DerivedResponsibility[] = titles.map((title, index) => ({
    key: keys[index]!,
    title,
    source: planSource!,
    obligation: { kind: "unknown" },
  }));
  if (match.kind === "ambiguous") {
    gaps.push({
      code: "AMBIGUOUS_PLAN_MAPPING",
      message: `A confirmed plan card (${match.messageId}) names this agent, but ${match.reason}. Its responsibilities and KPIs are not used.`,
    });
  }
  if (responsibilities.length === 0) {
    gaps.push({
      code: "NO_RESPONSIBILITIES",
      message:
        match.kind === "matched"
          ? "The confirmed plan card lists no responsibilities for this agent."
          : "No responsibilities are recorded for this agent.",
    });
  }
  if (responsibilities.length === 0 || responsibilities.some((r) => r.obligation.kind !== "routine")) {
    gaps.push({
      code: "NO_STRUCTURED_OBLIGATIONS",
      message: "No responsibility is bound to a routine, deliverable or goal, so what is owed can't be checked against it.",
    });
  }
  gaps.push(
    { code: "NO_CRITERIA", message: "No person has written criteria for what good work looks like for this agent." },
    { code: "NO_ACCESS_REQUEST", message: "No person has defined what this agent should be able to see, do and talk to." },
    { code: "NO_STYLE", message: "No communication style is recorded for this agent." },
  );

  const planKpis = match.kind === "matched" ? match.kpis : [];
  const enrollmentMetrics = cleanStringArray(enrollment?.metrics);
  const kpis =
    planKpis.length > 0
      ? field(planKpis, planSource)
      : enrollmentMetrics.length > 0
        ? field(enrollmentMetrics, enrollmentSource)
        : field<string[]>([], null);

  const desiredSkills = readPaperclipSkillSyncPreference(parseObject(agent.adapterConfig)).desiredSkills;
  const installedSkills = cleanStringArray(enrollment?.installedSkillKeys);
  const skills =
    desiredSkills.length > 0
      ? field(desiredSkills, "agent.adapterConfig.paperclipSkillSync.desiredSkills")
      : installedSkills.length > 0
        ? field(installedSkills, enrollmentSource)
        : field<string[]>([], null);

  const objective = cleanString(enrollment?.objective);
  const title = cleanString(agent.title);
  const summary = cleanString(agent.capabilities);

  return {
    kind: "agent_profile_derived",
    version: "agent-profile-derived/0",
    derived: true,
    companyId: agent.companyId,
    agentId: agent.id,
    generatedAt: input.generatedAt.toISOString(),
    identity: {
      name: field(agent.name, "agent.name"),
      title: field(title, title ? "agent.title" : null),
      role: field(agent.role, "agent.role"),
      summary: field(summary, summary ? "agent.capabilities" : null),
    },
    objective: field(objective, objective ? enrollmentSource : null),
    responsibilities,
    kpis,
    rhythm: {
      heartbeat: deriveHeartbeat(agent),
      routines: input.routines.map((routine) => ({
        routineId: routine.id,
        title: routine.title,
        status: routine.status,
        triggers: routine.triggers.map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          enabled: trigger.enabled,
        })),
      })),
      reportsTo: { agentId: agent.reportsTo, agentName: input.reportsToAgent?.name ?? null },
      accountableUserId: input.accountableUserId,
    },
    skills,
    runtime: { adapterType: agent.adapterType, model: input.model, environmentId: agent.defaultEnvironmentId },
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Loaders (reads only)
// ---------------------------------------------------------------------------

/**
 * Routines currently assigned to the agent, with their triggers.
 * `includeArchived` adds archived routines; `viewer` drops routines in
 * restricted projects the viewer can't read (their titles are content).
 */
export async function loadAssignedRoutines(
  db: Db,
  companyId: string,
  agentId: string,
  opts: { includeArchived?: boolean; viewer?: ViewerProjectScope } = {},
): Promise<AssignedRoutineRow[]> {
  const viewer = opts.viewer ?? UNRESTRICTED_PROJECT_SCOPE;
  const routineRows = await db
    .select({ id: routines.id, title: routines.title, status: routines.status, createdAt: routines.createdAt })
    .from(routines)
    .where(
      and(
        eq(routines.companyId, companyId),
        eq(routines.assigneeAgentId, agentId),
        opts.includeArchived ? undefined : ne(routines.status, "archived"),
        viewer.projectScoped(routines.projectId),
      ),
    )
    .orderBy(asc(routines.createdAt), asc(routines.id));
  if (routineRows.length === 0) return [];
  const triggerRows = await db
    .select({
      id: routineTriggers.id,
      routineId: routineTriggers.routineId,
      kind: routineTriggers.kind,
      enabled: routineTriggers.enabled,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      createdAt: routineTriggers.createdAt,
    })
    .from(routineTriggers)
    .where(
      and(
        eq(routineTriggers.companyId, companyId),
        inArray(
          routineTriggers.routineId,
          routineRows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
  return routineRows.map((routine) => ({
    ...routine,
    triggers: triggerRows
      .filter((trigger) => trigger.routineId === routine.id)
      .map(({ routineId: _routineId, ...trigger }) => trigger),
  }));
}

/**
 * Gather the rows for one agent's derived profile. Null when the agent is not
 * in this company (callers answer 404, as `agentVisibilityParam` does).
 * `viewer` applies the restricted-project rule to routine titles.
 */
export async function loadAgentProfileDerivedInput(
  db: Db,
  input: { companyId: string; agentId: string; now?: Date; viewer?: ViewerProjectScope },
): Promise<AgentProfileDerivedInput | null> {
  const { companyId, agentId } = input;
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      capabilities: agents.capabilities,
      reportsTo: agents.reportsTo,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      defaultEnvironmentId: agents.defaultEnvironmentId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;

  const [reportsToAgent, accountability, planCards, enrollment, assignedRoutines, runtime] = await Promise.all([
    agent.reportsTo
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, agent.reportsTo), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    agentAccountabilityService(db).resolveForAgent(companyId, agentId),
    // Plan cards whose confirmed ids include this agent, company-scoped through
    // the conversation. `@>` is false (not an error) for a non-array value.
    db
      .select({ messageId: assistantMessages.id, createdAt: assistantMessages.createdAt, payload: assistantMessages.cardPayload })
      .from(assistantMessages)
      .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
      .where(
        and(
          eq(assistantConversations.companyId, companyId),
          eq(assistantMessages.cardKind, PLAN_CARD_KIND),
          sql`(${assistantMessages.cardPayload} -> 'confirmedAgentIds') @> jsonb_build_array(${agentId}::text)`,
        ),
      )
      .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id)),
    db
      .select({
        id: workforceEnrollments.id,
        objective: workforceEnrollments.objective,
        metrics: workforceEnrollments.metrics,
        installedSkillKeys: workforceEnrollments.installedSkillKeys,
      })
      .from(workforceEnrollments)
      .where(and(eq(workforceEnrollments.agentId, agentId), eq(workforceEnrollments.companyId, companyId)))
      .then((rows) => rows[0] ?? null),
    loadAssignedRoutines(db, companyId, agentId, { viewer: input.viewer }),
    // Read-only: an explicit adapterConfig model, else the hermes profile/host
    // default for hermes agents, else an explicit unknown (AGE-1).
    resolveAgentRuntimeModel({
      adapterType: agent.adapterType,
      adapterConfig: parseObject(agent.adapterConfig),
      agentId: agent.id,
      runtimeConfig: parseObject(agent.runtimeConfig),
    }).catch(() => ({ model: null })),
  ]);

  return {
    generatedAt: input.now ?? new Date(),
    agent: {
      ...agent,
      adapterConfig: parseObject(agent.adapterConfig),
      runtimeConfig: parseObject(agent.runtimeConfig),
    },
    reportsToAgent,
    accountableUserId: accountability?.userId ?? null,
    planCards,
    enrollment,
    routines: assignedRoutines,
    model: runtime.model ?? null,
  };
}
