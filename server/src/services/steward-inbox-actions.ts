import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, bridgeEndpoints, stewardInboxActionHandles } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { accessService } from "./access.js";
import { logActivity } from "./index.js";
import { issueService } from "./index.js";
import { type IssueAssignmentWakeupDeps, queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { stewardInboxService } from "./steward-inbox.js";

/**
 * AgentDash-MK: directing work and changing preferences from the inbox.
 *
 * The rule this is built around: **the endpoint credential is never a write
 * credential.** It reaches an explicit allowlist and is minted as an actor that
 * every ordinary authorization helper refuses. Deciding an approval from the
 * inbox is authorised by a handle good for one approval at one revision, spent
 * once. Assigning work and changing a preference use the identical shape, for
 * the identical reason.
 *
 * So every action is two steps:
 *
 *   1. **propose** — resolve names to agents, validate, and mint a single-use
 *      handle over the RESOLVED action. Nothing has happened yet.
 *   2. **confirm** — spend the handle, re-check the person's permission, and
 *      execute.
 *
 * The handle carries the resolved action rather than the sentence somebody
 * typed, so what is confirmed is exactly what was read back to them. Free text
 * is never re-interpreted at execution time.
 *
 * An unresolved or ambiguous name mints NO handle. A near-miss comes back as a
 * question instead, because a wrong name silently assigned to the wrong agent
 * is worse than asking.
 */

/** Long enough to read a confirmation, short enough to be worthless if it leaks. */
const HANDLE_TTL_MS = 15 * 60 * 1000;

/**
 * Bounds on one instruction.
 *
 * Not defensive padding: `confirm` spends the handle before it starts creating,
 * so a failure partway through a long list leaves some work assigned and no way
 * to retry the rest. Keeping a batch small keeps that blast radius small, and a
 * person naming eleven assignments in one breath is better served by being
 * asked to split it.
 */
const MAX_ITEMS_PER_INSTRUCTION = 10;
/**
 * `work` names the job and becomes the issue title; `description` carries the
 * brief. A `work` longer than a title is not refused — it is kept whole as the
 * description and a title is cut from its first line, because the person meant
 * every word of it and a rejection just makes them retype it on the board.
 */
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 20_000;

/** The only cadences offered. Two options is the whole preference surface. */
export const ALLOWED_CADENCE_MINUTES = [30, 60] as const;
export const DEFAULT_CADENCE_MINUTES = 60;

export type StewardInboxActionKind = "assign_work" | "set_cadence";

export interface AssignWorkRequest {
  kind: "assign_work";
  items: Array<{ agent: string; work: string; description?: string | null }>;
}

/**
 * Split one instruction into the issue's title and description.
 *
 * Exported for the unit tests; the rule is small enough that the tests are the
 * spec: an explicit description always wins, a short `work` is the title as-is,
 * and a long one is kept whole as the description under a title cut from it.
 */
export function splitWorkIntoTitleAndDescription(
  work: string,
  description?: string | null,
): { title: string; description: string | null } {
  const brief = description?.trim() || null;
  if (work.length <= MAX_TITLE_LENGTH) return { title: work, description: brief };

  const firstLine = work.split(/\r?\n/, 1)[0]!.trim();
  const title =
    firstLine.length <= MAX_TITLE_LENGTH
      ? firstLine
      : `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
  return { title, description: brief ? `${work}\n\n${brief}` : work };
}
export interface SetCadenceRequest {
  kind: "set_cadence";
  minutes: number;
}
export type ActionRequest = AssignWorkRequest | SetCadenceRequest;

/** A name that did not resolve, with anything it might plausibly have meant. */
export interface Ambiguity {
  given: string;
  didYouMean: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * How many single-character edits separate two names.
 *
 * Written out rather than pulled in: it is fifteen lines, and a dependency for
 * fifteen lines is a dependency to keep patched for ever.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Names close enough to be worth offering back.
 *
 * A prefix test is not enough. The case that matters most —
 * "Amelia" for "Emilia" — differs in the first character, so it has to be edit
 * distance. Capped at two edits, and only for names long enough that two edits
 * still means something, so this offers a near miss without ever inventing one.
 */
export function suggestNames(given: string, candidates: string[]): string[] {
  const g = normalize(given);
  if (g.length === 0) return [];
  const scored: Array<{ name: string; distance: number }> = [];
  for (const name of candidates) {
    const n = normalize(name);
    if (n.includes(g) || g.includes(n)) {
      scored.push({ name, distance: 0 });
      continue;
    }
    const distance = editDistance(g, n);
    const budget = Math.min(2, Math.floor(Math.max(g.length, n.length) / 3));
    if (distance <= Math.max(1, budget)) scored.push({ name, distance });
  }
  return scored
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((entry) => entry.name);
}

export function stewardInboxActionsService(
  db: Db,
  options: {
    /**
     * Wakes the assignee when work is assigned. Optional so the unit tests can
     * construct the service without a heartbeat; the bridge route always
     * passes one, because assigned work that does not start is the bug this
     * path had (MK, 2026-09: inbox assignments sat in backlog until someone
     * commented).
     */
    heartbeat?: IssueAssignmentWakeupDeps;
  } = {},
) {
  const inbox = stewardInboxService(db);
  const access = accessService(db);

  /**
   * The company's agents, name and role only.
   *
   * Narrow on purpose. Resolving "Casper" needs a name and an id; it does not
   * need adapter configuration, budgets, or policy, and an endpoint credential
   * has no business seeing them.
   */
  async function listAgents(endpointId: string) {
    const endpoint = await inbox.requireInboxEndpoint(endpointId);
    const rows = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, endpoint.companyId));
    return { agents: rows };
  }

  async function mintHandle(input: {
    companyId: string;
    endpointId: string;
    actorUserId: string;
    kind: StewardInboxActionKind;
    payload: Record<string, unknown>;
  }) {
    const token = randomBytes(32).toString("base64url");
    await db.insert(stewardInboxActionHandles).values({
      token,
      companyId: input.companyId,
      bridgeEndpointId: input.endpointId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      payload: input.payload,
      expiresAt: new Date(Date.now() + HANDLE_TTL_MS),
    });
    return token;
  }

  /**
   * Read back what was understood, and mint a handle for it.
   *
   * Returns no handle when anything is unresolved — the caller is expected to
   * put the question to the person rather than proceed.
   */
  async function propose(
    endpointId: string,
    request: ActionRequest,
  ): Promise<{
    ok: boolean;
    handle?: string;
    readback?: string[];
    ambiguities?: Ambiguity[];
    reason?: string;
  }> {
    const endpoint = await inbox.requireInboxEndpoint(endpointId);

    if (request.kind === "set_cadence") {
      if (!ALLOWED_CADENCE_MINUTES.includes(request.minutes as 30 | 60)) {
        return {
          ok: false,
          reason: `Checking can be every ${ALLOWED_CADENCE_MINUTES.join(" or ")} minutes.`,
        };
      }
      const handle = await mintHandle({
        companyId: endpoint.companyId,
        endpointId,
        actorUserId: endpoint.userId,
        kind: "set_cadence",
        payload: { minutes: request.minutes },
      });
      return {
        ok: true,
        handle,
        // Honest wording: nothing reads the stored interval yet, so the
        // readback must not claim the checking itself changed.
        readback: [
          `Store a preference to check for new items every ${request.minutes} minutes (takes effect once inbox scheduling is active)`,
        ],
      };
    }

    if (!Array.isArray(request.items) || request.items.length === 0) {
      return { ok: false, reason: "Nothing to assign." };
    }
    if (request.items.length > MAX_ITEMS_PER_INSTRUCTION) {
      return {
        ok: false,
        reason: `That is ${request.items.length} assignments at once; ask for at most ${MAX_ITEMS_PER_INSTRUCTION} at a time.`,
      };
    }

    const roster = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, endpoint.companyId));
    const names = roster.map((a) => a.name);

    const resolved: Array<{
      agentId: string;
      agentName: string;
      work: string;
      title: string;
      description: string | null;
    }> = [];
    const ambiguities: Ambiguity[] = [];

    for (const item of request.items) {
      const work = (item.work ?? "").trim();
      if (!work) return { ok: false, reason: `No work described for "${item.agent}".` };
      const { title, description } = splitWorkIntoTitleAndDescription(work, item.description);
      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        return {
          ok: false,
          reason: `The brief for "${item.agent}" is over ${MAX_DESCRIPTION_LENGTH.toLocaleString("en-US")} characters. Put the long material in a document and link it.`,
        };
      }
      const exact = roster.filter((a) => normalize(a.name) === normalize(item.agent));
      if (exact.length === 1) {
        resolved.push({ agentId: exact[0]!.id, agentName: exact[0]!.name, work, title, description });
        continue;
      }
      // Either nothing matched or more than one did; both are questions, not guesses.
      ambiguities.push({ given: item.agent, didYouMean: suggestNames(item.agent, names) });
    }

    if (ambiguities.length > 0) return { ok: false, ambiguities };

    const handle = await mintHandle({
      companyId: endpoint.companyId,
      endpointId,
      actorUserId: endpoint.userId,
      kind: "assign_work",
      payload: { items: resolved },
    });
    return {
      ok: true,
      handle,
      // Says that the work starts on confirm, so nobody is surprised by it.
      readback: resolved.map(
        (r) => `${r.agentName} — ${r.title}${r.description ? " (with a brief)" : ""} — starts as soon as you confirm`,
      ),
    };
  }

  /** Spend the handle. Conditional UPDATE, so two confirmations cannot both win. */
  async function consume(token: string, endpointId: string) {
    const now = new Date();
    return db
      .update(stewardInboxActionHandles)
      .set({ consumedAt: now })
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, endpointId),
          // Only this service's own kinds. The same table holds upload
          // handles (bridge-upload.ts); spending one here would burn it on
          // an action it was never minted for.
          inArray(stewardInboxActionHandles.kind, ["assign_work", "set_cadence"]),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, now),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Confirm and execute.
   *
   * Permission is re-checked here, not at propose time: a person whose
   * authority changed between reading the confirmation and giving it must be
   * refused, exactly as a decision handle is re-resolved against current
   * authority when it is redeemed.
   */
  async function confirm(
    endpointId: string,
    token: string,
  ): Promise<{ ok: boolean; kind?: StewardInboxActionKind; result?: unknown; reason?: string }> {
    const endpoint = await inbox.requireInboxEndpoint(endpointId);
    const record = await consume(token, endpointId);
    if (!record || record.companyId !== endpoint.companyId) {
      return { ok: false, reason: "That confirmation is no longer valid. Ask again." };
    }

    if (record.kind === "set_cadence") {
      const minutes = Number((record.payload as { minutes?: number }).minutes);
      if (!ALLOWED_CADENCE_MINUTES.includes(minutes as 30 | 60)) {
        return { ok: false, reason: "That checking interval is not available." };
      }
      await db
        .update(bridgeEndpoints)
        .set({ checkIntervalMinutes: minutes, updatedAt: new Date() })
        .where(eq(bridgeEndpoints.id, endpointId));
      await logActivity(db, {
        companyId: endpoint.companyId,
        actorType: "user",
        actorId: endpoint.userId,
        action: "inbox.cadence_changed",
        entityType: "bridge_endpoint",
        entityId: endpointId,
        details: { minutes },
      }).catch((err) => logger.warn({ err }, "inbox cadence activity not recorded"));
      return {
        ok: true,
        kind: "set_cadence",
        result: {
          minutes,
          storedOnly: true,
          note: "Preference stored. It takes effect once inbox scheduling is active — nothing reads the interval yet.",
        },
      };
    }

    // Assigning work is somebody else's time. It needs the permission that
    // governs assignment, checked against who this endpoint belongs to.
    const permitted = await access.canUser(endpoint.companyId, endpoint.userId, "tasks:assign");
    if (!permitted) {
      return { ok: false, reason: "You do not have permission to assign work." };
    }

    const items =
      (
        record.payload as {
          items?: Array<{
            agentId: string;
            agentName: string;
            work: string;
            // Absent on handles minted before titles and briefs were split.
            title?: string;
            description?: string | null;
          }>;
        }
      ).items ?? [];
    const created: Array<{ issueId: string; identifier: string | null; agentName: string }> = [];
    const failed: Array<{ agentName: string; work: string; reason: string }> = [];
    const issues = issueService(db);

    /**
     * Each item is attempted independently and any failure is REPORTED rather
     * than thrown.
     *
     * `issueService.create` does not accept a transaction, so a list cannot be
     * made atomic here, and the handle is already spent by the time this runs.
     * Throwing on the second of three would leave the first assigned, the
     * handle dead, and the person told only that something went wrong. Saying
     * exactly what landed and what did not is the honest outcome, and it is
     * what lets them ask again for the remainder.
     */
    for (const item of items) {
      try {
        // Typed, never cast: the compiler checks this literal, so a mis-keyed
        // createdByUserId fails the build instead of silently writing NULL.
        const split = item.title
          ? { title: item.title, description: item.description ?? null }
          : splitWorkIntoTitleAndDescription(item.work);
        // `todo`, not the create default of `backlog`: a person assigning work
        // to an agent means "do this now". Backlog is for parking, and parked
        // work wakes nobody.
        const issue = await issues.create(endpoint.companyId, {
          title: split.title,
          description: split.description,
          status: "todo",
          assigneeAgentId: item.agentId,
          createdByUserId: endpoint.userId,
        });
        created.push({
          issueId: issue.id,
          identifier: (issue as { identifier?: string | null }).identifier ?? null,
          agentName: item.agentName,
        });
        await logActivity(db, {
          companyId: endpoint.companyId,
          actorType: "user",
          actorId: endpoint.userId,
          action: "inbox.work_assigned",
          entityType: "issue",
          entityId: issue.id,
          agentId: item.agentId,
          details: { via: "inbox_connect", assignedTo: item.agentName },
        }).catch((err) => logger.warn({ err }, "inbox assignment activity not recorded"));
        if (options.heartbeat) {
          void queueIssueAssignmentWakeup({
            heartbeat: options.heartbeat,
            issue,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "inbox.assign_work",
            requestedByActorType: "user",
            requestedByActorId: endpoint.userId,
          });
        }
      } catch (err) {
        logger.error(
          { err, endpointId, agentId: item.agentId },
          "inbox assignment failed after the confirmation was spent",
        );
        failed.push({
          agentName: item.agentName,
          work: item.work,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (created.length === 0 && failed.length > 0) {
      return { ok: false, reason: "None of that could be assigned. Nothing changed." };
    }
    return {
      ok: true,
      kind: "assign_work",
      result: { assigned: created, ...(failed.length > 0 ? { failed } : {}) },
    };
  }

  return { listAgents, propose, confirm };
}
