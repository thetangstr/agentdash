import { and, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueDependencies, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

interface AddDependencyOpts {
  dependencyType?: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export function taskDependencyService(db: Db) {
  // ── helpers ──────────────────────────────────────────────────────────

  async function assertIssueExists(companyId: string, issueId: string) {
    const row = await db
      .select({ id: issues.id, companyId: issues.companyId, status: issues.status, projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`Issue ${issueId} not found in company`);
    return row;
  }

  // ── public API ───────────────────────────────────────────────────────

  return {
    /**
     * Add a dependency: `issueId` is blocked by `blockedByIssueId`.
     */
    addDependency: async (
      companyId: string,
      issueId: string,
      blockedByIssueId: string,
      opts?: AddDependencyOpts,
    ) => {
      if (issueId === blockedByIssueId) {
        throw unprocessable("An issue cannot depend on itself");
      }

      // Validate both issues exist in the same company
      await Promise.all([
        assertIssueExists(companyId, issueId),
        assertIssueExists(companyId, blockedByIssueId),
      ]);

      // Cycle detection
      const hasCycle = await detectCycle(companyId, issueId, blockedByIssueId);
      if (hasCycle) {
        throw unprocessable("Adding this dependency would create a cycle");
      }

      const row = await db
        .insert(issueDependencies)
        .values({
          companyId,
          issueId,
          blockedByIssueId,
          dependencyType: opts?.dependencyType ?? "blocks",
          createdByAgentId: opts?.createdByAgentId ?? null,
          createdByUserId: opts?.createdByUserId ?? null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);

      // If conflict (already exists), fetch the existing row
      if (!row) {
        return db
          .select()
          .from(issueDependencies)
          .where(
            and(
              eq(issueDependencies.companyId, companyId),
              eq(issueDependencies.issueId, issueId),
              eq(issueDependencies.blockedByIssueId, blockedByIssueId),
            ),
          )
          .then((rows) => rows[0] ?? null);
      }

      return row;
    },

    /**
     * Remove a dependency link. Returns true if a row was deleted.
     */
    removeDependency: async (
      companyId: string,
      issueId: string,
      blockedByIssueId: string,
    ): Promise<boolean> => {
      const deleted = await db
        .delete(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            eq(issueDependencies.issueId, issueId),
            eq(issueDependencies.blockedByIssueId, blockedByIssueId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    /**
     * Get all dependencies where `issueId` is the blocked issue
     * (i.e. all its blockers).
     */
    getBlockers: async (companyId: string, issueId: string) => {
      return db
        .select()
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            eq(issueDependencies.issueId, issueId),
          ),
        );
    },

    /**
     * Get all dependencies where `issueId` is the blocker
     * (i.e. all issues that depend on it).
     */
    getDependents: async (companyId: string, issueId: string) => {
      return db
        .select()
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            eq(issueDependencies.blockedByIssueId, issueId),
          ),
        );
    },

    /**
     * BFS cycle detection: would adding issueId ← blockedByIssueId create a
     * cycle? Walk from `blockedByIssueId` following its own blockedBy edges
     * to see if we can reach `issueId`.
     */
    detectCycle: (companyId: string, issueId: string, blockedByIssueId: string) =>
      detectCycle(companyId, issueId, blockedByIssueId),

    /**
     * When an issue is completed, check every issue it was blocking.
     * For each, if ALL remaining blockers are done/cancelled, and the issue
     * is currently 'blocked', transition it to 'todo'.
     * Returns the IDs of issues that were unblocked.
     */
    processCompletionUnblock: async (
      companyId: string,
      completedIssueId: string,
    ): Promise<string[]> => {
      // Find all issues blocked by the completed one
      const dependents = await db
        .select({ issueId: issueDependencies.issueId })
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            eq(issueDependencies.blockedByIssueId, completedIssueId),
          ),
        );

      if (dependents.length === 0) return [];

      const unblockedIds: string[] = [];

      for (const dep of dependents) {
        // Get all blockers for this dependent issue (excluding the just-completed one)
        const remainingBlockers = await db
          .select({
            blockedByIssueId: issueDependencies.blockedByIssueId,
            blockerStatus: issues.status,
          })
          .from(issueDependencies)
          .innerJoin(issues, eq(issueDependencies.blockedByIssueId, issues.id))
          .where(
            and(
              eq(issueDependencies.companyId, companyId),
              eq(issueDependencies.issueId, dep.issueId),
              not(eq(issueDependencies.blockedByIssueId, completedIssueId)),
            ),
          );

        // Check if any remaining blocker is still active (not done/cancelled)
        const hasActiveBlocker = remainingBlockers.some(
          (b) => b.blockerStatus !== "done" && b.blockerStatus !== "cancelled",
        );

        if (!hasActiveBlocker) {
          // All blockers resolved — transition to 'todo' if currently 'blocked'
          const updated = await db
            .update(issues)
            .set({ status: "todo", updatedAt: new Date() })
            .where(
              and(
                eq(issues.id, dep.issueId),
                eq(issues.companyId, companyId),
                eq(issues.status, "blocked"),
              ),
            )
            .returning({ id: issues.id });

          if (updated.length > 0) {
            unblockedIds.push(dep.issueId);
          }
        }
      }

      return unblockedIds;
    },

    /**
     * Get the full dependency DAG for all issues in a project.
     */
    getFullDag: async (companyId: string, projectId: string) => {
      const projectIssueIds = db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.projectId, projectId),
          ),
        );

      return db
        .select()
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            inArray(issueDependencies.issueId, projectIssueIds),
          ),
        );
    },

    /**
     * Get issues in a project that are 'todo' or 'backlog' with no active
     * (non-done, non-cancelled) blockers — i.e. ready to start.
     */
    getReadyToStart: async (companyId: string, projectId: string) => {
      // Find issues that have at least one active blocker
      const issuesWithActiveBlockers = db
        .select({ issueId: issueDependencies.issueId })
        .from(issueDependencies)
        .innerJoin(issues, eq(issueDependencies.blockedByIssueId, issues.id))
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            not(inArray(issues.status, ["done", "cancelled"])),
          ),
        );

      return db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.projectId, projectId),
            inArray(issues.status, ["todo", "backlog"]),
            not(inArray(issues.id, issuesWithActiveBlockers)),
          ),
        );
    },
  };

  // ── internal helpers ─────────────────────────────────────────────────

  /**
   * BFS from `blockedByIssueId` following blockedBy edges.
   * Returns true if `issueId` is reachable (i.e. a cycle would form).
   */
  async function detectCycle(
    companyId: string,
    issueId: string,
    blockedByIssueId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    const queue: string[] = [blockedByIssueId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === issueId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      // Follow the "blockedBy" edges: for the current node, find what blocks it
      const edges = await db
        .select({ blockedByIssueId: issueDependencies.blockedByIssueId })
        .from(issueDependencies)
        .where(
          and(
            eq(issueDependencies.companyId, companyId),
            eq(issueDependencies.issueId, current),
          ),
        );

      for (const edge of edges) {
        if (!visited.has(edge.blockedByIssueId)) {
          queue.push(edge.blockedByIssueId);
        }
      }
    }

    return false;
  }
}
