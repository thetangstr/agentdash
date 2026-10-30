import { randomUUID } from "node:crypto";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environments,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { AgentOperatingProfileV1, AgentProfileRevisionDto } from "@paperclipai/shared";
import { agentStewardshipService } from "../../services/agent-stewardships.js";
import type { AgentProfileActor } from "../../services/agent-profiles.js";

/** AgentDash: APM gate 2 — shared seed for the operating-profile suites. */

export type TestDb = ReturnType<typeof createDb>;

export async function addUser(db: TestDb, companyId: string, membershipRole: string) {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({ id: userId, name: `User ${membershipRole}`, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
  return userId;
}

export async function addCompany(db: TestDb, label: string, productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
  return db
    .insert(companies)
    .values({ name: `${label} ${randomUUID()}`, issuePrefix: `PF${randomUUID().slice(0, 6).toUpperCase()}`, productProfile })
    .returning()
    .then((rows) => rows[0]!);
}

export async function addAgent(db: TestDb, companyId: string, values: Partial<typeof agents.$inferInsert> & { name: string }) {
  return db
    .insert(agents)
    .values({ companyId, role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: "echo" }, ...values })
    .returning()
    .then((rows) => rows[0]!);
}

/**
 * One company with: an owner (admin), a steward and its stewarded Analyst, an
 * autonomous agent with an accountable member, an outsider member, a Chief of
 * Staff agent (the performance manager), a local environment, and a routine
 * with a trigger assigned to the Analyst.
 */
export async function seedProfileCompany(db: TestDb, productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
  const company = await addCompany(db, "Profiles", productProfile);
  const ownerUserId = await addUser(db, company.id, "owner");
  const stewardUserId = await addUser(db, company.id, "member");
  const accountableUserId = await addUser(db, company.id, "member");
  const outsiderUserId = await addUser(db, company.id, "member");
  const chief = await addAgent(db, company.id, { name: "Chief", role: "chief_of_staff" });
  const analyst = await addAgent(db, company.id, {
    name: "Analyst",
    title: "Pipeline Analyst",
    reportsTo: chief.id,
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900 } },
  });
  const autonomous = await addAgent(db, company.id, { name: "Solo", autonomy: "autonomous", accountableUserId });
  if (productProfile === "agentdash_mk") {
    await agentStewardshipService(db).assign(company.id, { agentId: analyst.id, userId: stewardUserId, assignedByUserId: ownerUserId });
  }
  const environment = await db
    .insert(environments)
    .values({ companyId: company.id, name: "Local", driver: "local" })
    .returning()
    .then((rows) => rows[0]!);
  const routine = await db
    .insert(routines)
    .values({ companyId: company.id, title: "Weekly pipeline report", assigneeAgentId: analyst.id, status: "active" })
    .returning()
    .then((rows) => rows[0]!);
  const trigger = await db
    .insert(routineTriggers)
    .values({ companyId: company.id, routineId: routine.id, kind: "schedule", cronExpression: "0 9 * * 1", timezone: "UTC" })
    .returning()
    .then((rows) => rows[0]!);
  return { company, ownerUserId, stewardUserId, accountableUserId, outsiderUserId, chief, analyst, autonomous, environment, routine, trigger };
}

export function userActor(userId: string): AgentProfileActor {
  return { type: "user", userId, source: "session", isInstanceAdmin: false };
}

export function agentProfileActor(agentId: string): AgentProfileActor {
  return { type: "agent", agentId, runId: null };
}

/** A copy of a revision body with `mutate` applied. */
export function editBody(
  revision: Pick<AgentProfileRevisionDto, "body">,
  mutate: (body: AgentOperatingProfileV1) => void,
): AgentOperatingProfileV1 {
  const body = structuredClone(revision.body);
  mutate(body);
  return body;
}

export function boardActor(companyId: string, userId: string, membershipRole = "member") {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }],
  };
}

export function agentRequestActor(agent: { id: string; companyId: string }, extra: Record<string, unknown> = {}) {
  return { type: "agent", agentId: agent.id, companyId: agent.companyId, source: "agent_key", ...extra };
}
