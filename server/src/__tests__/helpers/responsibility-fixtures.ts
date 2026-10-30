import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentProfileRevisions, agentProfiles } from "@paperclipai/db";
import { profileBodyHash, type AgentOperatingProfileV1 } from "@paperclipai/shared";

// AgentDash: Agent Performance Management gate 2 (P2.4) — operating profiles for
// the contract and responsibility-mapping tests. Rows are written directly: the
// application path (P2.2) is not under test here, only what reads its result.

type Responsibility = AgentOperatingProfileV1["responsibilities"][number];

export function responsibility(key: string, overrides: Partial<Responsibility> = {}): Responsibility {
  return {
    key,
    title: `Responsibility ${key}`,
    outcome: `The ${key} outcome`,
    stakeholders: [],
    obligation: { kind: "assigned" },
    deliverable: { what: "An answer on the issue", destination: "The issue" },
    escalation: { when: "Blocked for more than a day" },
    performance: {
      criteria: [{ id: "c1", text: "Delivered", check: { kind: "record", record: "deliverable.shipped" }, source: "human" }],
      coverage: ["deliverable_shipped"],
      outcomeLinks: [],
      expectedHumanSteps: [],
      judges: { automated: [] },
    },
    ...overrides,
  } as Responsibility;
}

export function profileBody(responsibilities: Responsibility[]): AgentOperatingProfileV1 {
  return {
    profileVersion: 1,
    identity: {
      name: "Reporter",
      title: "Analyst",
      summary: "Writes reports.",
      audience: "Leadership",
      style: { tone: "Plain", uncertaintyRule: "Say what is unknown" },
    },
    responsibilities,
    knowledge: [],
    skills: [],
    access: {},
    rhythm: { timezone: "UTC", reportTo: {} },
  } as AgentOperatingProfileV1;
}

/** A profile with one applied revision that is active. Returns the revision id. */
export async function seedActiveProfile(
  db: Db,
  input: { companyId: string; agentId: string; body: AgentOperatingProfileV1; revisionNumber?: number },
): Promise<{ profileId: string; revisionId: string }> {
  const existing = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, input.agentId))
    .then((rows) => rows[0] ?? null);
  const profileId =
    existing?.id ??
    (await db
      .insert(agentProfiles)
      .values({ companyId: input.companyId, agentId: input.agentId })
      .returning({ id: agentProfiles.id })
      .then((rows) => rows[0]!.id));
  const [revision] = await db
    .insert(agentProfileRevisions)
    .values({
      companyId: input.companyId,
      profileId,
      revisionNumber: input.revisionNumber ?? 1,
      state: "applied",
      body: input.body,
      bodyHash: profileBodyHash(input.body),
    })
    .returning({ id: agentProfileRevisions.id });
  await db.update(agentProfiles).set({ activeRevisionId: revision!.id }).where(eq(agentProfiles.id, profileId));
  return { profileId, revisionId: revision!.id };
}
