// AgentDash-MK: harness → agent directives (Slice 1 of the pairing architecture).
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentDirectives, agents } from "@paperclipai/db";
import type { AgentDirective, AgentDirectiveRuntimeContext } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logActivity } from "./activity-log.js";

type AgentDirectiveRow = typeof agentDirectives.$inferSelect;

export interface PushDirectivesInput {
  directives: string;
  pushedByUserId: string;
}

function toApi(row: AgentDirectiveRow): AgentDirective {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    version: row.version,
    directives: row.directives,
    pushedByUserId: row.pushedByUserId,
    pushedAt: row.pushedAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}

/**
 * Free-text operating instructions pushed by a steward's local harness.
 *
 * This service has no authorization logic and no read of any policy. It is
 * storage plus the append-only invariant, deliberately: the moment a directives
 * service starts consulting ceilings, someone will be tempted to have a ceiling
 * consult directives, and Rule B ("directives cannot grant capability") stops
 * being structural. Who may push is decided in the route, from the stewardship.
 */
export function agentDirectivesService(db: Db) {
  async function requireCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /** The version currently in force, or null when the harness never pushed. */
  async function active(companyId: string, agentId: string): Promise<AgentDirective | null> {
    const row = await db
      .select()
      .from(agentDirectives)
      .where(
        and(
          eq(agentDirectives.companyId, companyId),
          eq(agentDirectives.agentId, agentId),
          isNull(agentDirectives.supersededAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row ? toApi(row) : null;
  }

  /**
   * The projection the agent runtime injects into a run's context.
   *
   * Kept separate from {@link active} so the runtime path never carries row ids
   * or company ids into a prompt, and so the shape the model sees is one small
   * object a reader can check at a glance.
   */
  async function activeForRuntime(
    companyId: string,
    agentId: string,
  ): Promise<AgentDirectiveRuntimeContext | null> {
    const row = await active(companyId, agentId);
    if (!row) return null;
    return {
      version: row.version,
      directives: row.directives,
      pushedAt: row.pushedAt,
      pushedByUserId: row.pushedByUserId,
    };
  }

  /** Every version, newest first. Superseded rows keep their own provenance. */
  async function history(companyId: string, agentId: string): Promise<AgentDirective[]> {
    const rows = await db
      .select()
      .from(agentDirectives)
      .where(
        and(eq(agentDirectives.companyId, companyId), eq(agentDirectives.agentId, agentId)),
      )
      .orderBy(desc(agentDirectives.version));
    return rows.map(toApi);
  }

  /**
   * Seal the active version and insert the next one.
   *
   * Append-only, in one transaction. The prior row is sealed rather than
   * rewritten so "what was this agent told, and by whom, at the time it acted"
   * stays answerable; a mutated row would answer only "what is it told now".
   *
   * The partial unique index on (company, agent) WHERE superseded_at IS NULL is
   * the real guard against two harnesses pushing at once — the transaction
   * narrows the window, the index closes it.
   */
  async function push(
    companyId: string,
    agentId: string,
    input: PushDirectivesInput,
  ): Promise<AgentDirective> {
    await requireCompanyAgent(companyId, agentId);
    const directives = input.directives.trim();
    const now = new Date();

    try {
      const inserted = await db.transaction(async (tx) => {
        // `for update` on the current active row serializes concurrent pushes
        // against each other rather than letting both compute version N+1.
        await tx.execute(sql`
          select ${agentDirectives.id}
          from ${agentDirectives}
          where ${agentDirectives.companyId} = ${companyId}
            and ${agentDirectives.agentId} = ${agentId}
            and ${agentDirectives.supersededAt} is null
          for update
        `);

        const latest = await tx
          .select({ version: agentDirectives.version })
          .from(agentDirectives)
          .where(
            and(eq(agentDirectives.companyId, companyId), eq(agentDirectives.agentId, agentId)),
          )
          .orderBy(desc(agentDirectives.version))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        await tx
          .update(agentDirectives)
          .set({ supersededAt: now })
          .where(
            and(
              eq(agentDirectives.companyId, companyId),
              eq(agentDirectives.agentId, agentId),
              isNull(agentDirectives.supersededAt),
            ),
          );

        const row = await tx
          .insert(agentDirectives)
          .values({
            companyId,
            agentId,
            version: (latest?.version ?? 0) + 1,
            directives,
            pushedByUserId: input.pushedByUserId,
            pushedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: input.pushedByUserId,
          action: "agent.directives_pushed",
          entityType: "agent_directive",
          entityId: row.id,
          agentId,
          details: {
            version: row.version,
            // The text itself is not logged: it is already durable in the row
            // this entry points at, and directives can be long. Length is
            // enough to spot a truncated or empty push after the fact.
            directiveChars: directives.length,
          },
        });

        return row;
      });

      return toApi(inserted);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("Directives changed concurrently; re-read and push again");
      }
      throw error;
    }
  }

  return { active, activeForRuntime, history, push };
}
