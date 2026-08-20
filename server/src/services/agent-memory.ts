// AgentDash: durable per-agent memory. The agent-authored twin of
// `agent-directives.ts`, and it borrows that module's structure on purpose.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemory, agents } from "@paperclipai/db";
import type {
  AgentMemory,
  AgentMemoryAuthorKind,
  AgentMemoryRuntimeContext,
} from "@paperclipai/shared";
import { AGENT_MEMORY_MAX_LENGTH } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logActivity } from "./activity-log.js";

type AgentMemoryRow = typeof agentMemory.$inferSelect;

export interface WriteMemoryInput {
  content: string;
  authorKind: AgentMemoryAuthorKind;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  /**
   * The version the writer believed was current. Omitted means "I have not read
   * it" and is allowed only when no memory exists yet — otherwise a caller that
   * never read could silently erase a version it never saw.
   */
  expectedVersion?: number | null;
}

function toApi(row: AgentMemoryRow): AgentMemory {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    version: row.version,
    content: row.content,
    authorKind: row.authorKind as AgentMemoryAuthorKind,
    authorAgentId: row.authorAgentId,
    authorUserId: row.authorUserId,
    writtenAt: row.writtenAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}

/**
 * Storage plus the append-only invariant, and nothing else.
 *
 * Like the directives service, this one deliberately holds no authorization
 * logic and reads no policy: the moment a memory service consults a ceiling,
 * someone will be tempted to have a ceiling consult memory, and "memory cannot
 * grant capability" stops being structural. Who may write is decided in the
 * route, from the stewardship and the actor.
 */
export function agentMemoryService(db: Db) {
  async function requireCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /** The version in force, or null when the agent has never written one. */
  async function active(companyId: string, agentId: string): Promise<AgentMemory | null> {
    const row = await db
      .select()
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.companyId, companyId),
          eq(agentMemory.agentId, agentId),
          isNull(agentMemory.supersededAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row ? toApi(row) : null;
  }

  /**
   * The projection injected into a run's context — no row id, no company id.
   * Narrow by construction so it stays hard to grow into a capability channel.
   */
  async function activeForRuntime(
    companyId: string,
    agentId: string,
  ): Promise<AgentMemoryRuntimeContext | null> {
    const row = await active(companyId, agentId);
    if (!row) return null;
    return {
      version: row.version,
      content: row.content,
      writtenAt: row.writtenAt,
      authorKind: row.authorKind,
    };
  }

  /** Every version, newest first. Superseded rows keep their own provenance. */
  async function history(companyId: string, agentId: string): Promise<AgentMemory[]> {
    const rows = await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.companyId, companyId), eq(agentMemory.agentId, agentId)))
      .orderBy(desc(agentMemory.version));
    return rows.map(toApi);
  }

  /**
   * Seal the active version and insert the next one, in one transaction.
   *
   * `expectedVersion` is what makes concurrent runs safe. Two wakes of the same
   * agent can overlap, and a whole-document write is destructive by nature: the
   * second writer would otherwise persist a document built from a snapshot the
   * first had already replaced, and the first agent's learning would vanish with
   * no error anywhere. Naming the version you read turns that into a 409 the
   * caller can re-read and merge.
   */
  async function write(
    companyId: string,
    agentId: string,
    input: WriteMemoryInput,
  ): Promise<AgentMemory> {
    await requireCompanyAgent(companyId, agentId);
    const content = input.content.trim();
    if (!content) {
      throw unprocessable("Memory content cannot be empty. To clear it, write a short note saying so.");
    }
    if (content.length > AGENT_MEMORY_MAX_LENGTH) {
      throw unprocessable(
        `Memory is ${content.length} characters and the limit is ${AGENT_MEMORY_MAX_LENGTH}. ` +
          "Revise rather than append: drop what no longer matters, merge what overlaps.",
        { code: "AGENT_MEMORY_TOO_LONG", length: content.length, limit: AGENT_MEMORY_MAX_LENGTH },
      );
    }
    const now = new Date();

    try {
      return await db.transaction(async (tx) => {
        // `for update` serializes concurrent writers against each other rather
        // than letting both compute version N+1.
        await tx.execute(sql`
          select ${agentMemory.id}
          from ${agentMemory}
          where ${agentMemory.companyId} = ${companyId}
            and ${agentMemory.agentId} = ${agentId}
            and ${agentMemory.supersededAt} is null
          for update
        `);

        const current = await tx
          .select()
          .from(agentMemory)
          .where(
            and(
              eq(agentMemory.companyId, companyId),
              eq(agentMemory.agentId, agentId),
              isNull(agentMemory.supersededAt),
            ),
          )
          .then((rows) => rows[0] ?? null);

        const currentVersion = current?.version ?? null;
        if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
          if (input.expectedVersion !== currentVersion) {
            throw conflict(
              `Memory has moved on: you wrote against version ${input.expectedVersion} but ` +
                `version ${currentVersion ?? "none"} is current. Re-read it and merge.`,
              { code: "AGENT_MEMORY_VERSION_CONFLICT", currentVersion },
            );
          }
        } else if (currentVersion !== null) {
          throw conflict(
            "Memory already exists; read it and write back with its version rather than replacing it blind.",
            { code: "AGENT_MEMORY_VERSION_REQUIRED", currentVersion },
          );
        }

        if (current) {
          await tx
            .update(agentMemory)
            .set({ supersededAt: now })
            .where(eq(agentMemory.id, current.id));
        }

        const inserted = await tx
          .insert(agentMemory)
          .values({
            companyId,
            agentId,
            version: (currentVersion ?? 0) + 1,
            content,
            authorKind: input.authorKind,
            authorAgentId: input.authorAgentId ?? null,
            authorUserId: input.authorUserId ?? null,
            writtenAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

        return toApi(inserted);
      });
    } catch (err) {
      // Two writers that both passed the version check race to insert; the
      // partial unique index rejects the loser. Same remedy as a stale version.
      if (isUniqueViolation(err)) {
        throw conflict(
          "Another writer updated this memory at the same time. Re-read it and merge.",
          { code: "AGENT_MEMORY_VERSION_CONFLICT" },
        );
      }
      throw err;
    }
  }

  /** Write, then record it on the activity log so the board can see it happened. */
  async function writeAndLog(
    companyId: string,
    agentId: string,
    input: WriteMemoryInput,
    actor: {
      actorType: "agent" | "plugin" | "system" | "user";
      actorId: string;
      agentId?: string | null;
      runId?: string | null;
    },
  ): Promise<AgentMemory> {
    const record = await write(companyId, agentId, input);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "agent.memory_written",
      entityType: "agent",
      entityId: agentId,
      details: {
        version: record.version,
        authorKind: record.authorKind,
        length: record.content.length,
      },
    }).catch(() => {
      // Never fail a memory write because the audit line could not be written.
    });
    return record;
  }

  return { active, activeForRuntime, history, write, writeAndLog };
}
