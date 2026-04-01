import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  companySkills,
  skillVersions,
  skillDependencies,
  approvals,
} from "@agentdash/db";
import { notFound, unprocessable } from "../errors.js";
import { deriveSkillSemanticFields } from "./company-skills.js";

// ── simple line-by-line diff ─────────────────────────────────────────
function computeLineDiff(
  oldText: string | null | undefined,
  newText: string,
): string | null {
  if (!oldText) return null;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === undefined) {
      diff.push(`+ ${newLine}`);
    } else if (newLine === undefined) {
      diff.push(`- ${oldLine}`);
    } else if (oldLine !== newLine) {
      diff.push(`- ${oldLine}`);
      diff.push(`+ ${newLine}`);
    }
  }
  return diff.length > 0 ? diff.join("\n") : null;
}

export function skillsRegistryService(db: Db) {
  // ── helpers ──────────────────────────────────────────────────────────

  async function getVersionById(versionId: string) {
    const row = await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, versionId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`Skill version ${versionId} not found`);
    return row;
  }

  async function assertStatusTransition(
    versionId: string,
    expectedStatus: string,
    targetStatus: string,
  ) {
    const version = await getVersionById(versionId);
    if (version.status !== expectedStatus) {
      throw unprocessable(
        `Cannot transition from '${version.status}' to '${targetStatus}'; expected status '${expectedStatus}'`,
      );
    }
    return version;
  }

  /**
   * BFS cycle detection for skill dependencies.
   * Returns true if adding skillId -> dependsOnSkillId would create a cycle.
   */
  async function detectDependencyCycle(
    companyId: string,
    skillId: string,
    dependsOnSkillId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    const queue: string[] = [dependsOnSkillId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === skillId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const edges = await db
        .select({ dependsOnSkillId: skillDependencies.dependsOnSkillId })
        .from(skillDependencies)
        .where(
          and(
            eq(skillDependencies.companyId, companyId),
            eq(skillDependencies.skillId, current),
          ),
        );

      for (const edge of edges) {
        if (!visited.has(edge.dependsOnSkillId)) {
          queue.push(edge.dependsOnSkillId);
        }
      }
    }

    return false;
  }

  // ── public API ───────────────────────────────────────────────────────

  return {
    /**
     * Create a new version for a skill. Increments the parent skill's
     * latestVersionNumber and computes a line-by-line diff from the
     * previous version's markdown (null for the first version).
     */
    createVersion: async (
      companyId: string,
      skillId: string,
      data: {
        markdown: string;
        fileInventory?: Array<Record<string, unknown>>;
        changeSummary?: string;
        semver?: string;
        createdByAgentId?: string;
        createdByUserId?: string;
      },
    ) => {
      const semantics = deriveSkillSemanticFields({});
      const parsedSemantics = typeof data.markdown === "string"
        ? deriveSkillSemanticFields(parseMarkdownFrontmatter(data.markdown))
        : semantics;
      // Increment latestVersionNumber on parent skill
      const [updatedSkill] = await db
        .update(companySkills)
        .set({
          latestVersionNumber: sql`${companySkills.latestVersionNumber} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(companySkills.id, skillId),
            eq(companySkills.companyId, companyId),
          ),
        )
        .returning({ latestVersionNumber: companySkills.latestVersionNumber });

      if (!updatedSkill) throw notFound(`Skill ${skillId} not found in company`);

      const newVersionNumber = updatedSkill.latestVersionNumber;

      // Compute diff from previous version's markdown
      let diffFromPrevious: string | null = null;
      if (newVersionNumber > 1) {
        const prevVersion = await db
          .select({ markdown: skillVersions.markdown })
          .from(skillVersions)
          .where(
            and(
              eq(skillVersions.skillId, skillId),
              eq(skillVersions.versionNumber, newVersionNumber - 1),
            ),
          )
          .then((rows) => rows[0] ?? null);

        diffFromPrevious = computeLineDiff(prevVersion?.markdown, data.markdown);
      }

      // Insert the new version
      const version = await db
        .insert(skillVersions)
        .values({
          companyId,
          skillId,
          versionNumber: newVersionNumber,
          markdown: data.markdown,
          whenToUse: parsedSemantics.whenToUse,
          allowedTools: parsedSemantics.allowedTools,
          activationPaths: parsedSemantics.activationPaths,
          executionContext: parsedSemantics.executionContext,
          targetAgentType: parsedSemantics.targetAgentType,
          effort: parsedSemantics.effort,
          userInvocable: parsedSemantics.userInvocable,
          hooks: parsedSemantics.hooks,
          fileInventory: data.fileInventory ?? [],
          changeSummary: data.changeSummary ?? null,
          semver: data.semver ?? null,
          diffFromPrevious,
          status: "draft",
          createdByAgentId: data.createdByAgentId ?? null,
          createdByUserId: data.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      return version;
    },

    /**
     * List all versions for a skill ordered by versionNumber desc.
     */
    listVersions: async (companyId: string, skillId: string) => {
      return db
        .select()
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.companyId, companyId),
            eq(skillVersions.skillId, skillId),
          ),
        )
        .orderBy(desc(skillVersions.versionNumber));
    },

    /**
     * Get a specific version by skillId and versionNumber, or throw notFound.
     */
    getVersion: async (skillId: string, versionNumber: number) => {
      const row = await db
        .select()
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, skillId),
            eq(skillVersions.versionNumber, versionNumber),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!row) throw notFound(`Skill version ${versionNumber} not found for skill ${skillId}`);
      return row;
    },

    /**
     * Transition a version from 'draft' to 'in_review' and create an
     * approvals record with type 'skill_review'.
     */
    submitForReview: async (versionId: string) => {
      const version = await assertStatusTransition(versionId, "draft", "in_review");

      const now = new Date();
      const [updated] = await db
        .update(skillVersions)
        .set({ status: "in_review" })
        .where(eq(skillVersions.id, versionId))
        .returning();

      await db.insert(approvals).values({
        companyId: version.companyId,
        type: "skill_review",
        status: "pending",
        payload: {
          skillVersionId: versionId,
          versionNumber: version.versionNumber,
          skillId: version.skillId,
        },
        createdAt: now,
        updatedAt: now,
      });

      return updated;
    },

    /**
     * Set a version's status to 'approved' with reviewer info.
     */
    approveVersion: async (versionId: string, reviewedByUserId: string) => {
      await assertStatusTransition(versionId, "in_review", "approved");

      const [updated] = await db
        .update(skillVersions)
        .set({
          status: "approved",
          reviewedByUserId,
          reviewedAt: new Date(),
        })
        .where(eq(skillVersions.id, versionId))
        .returning();

      return updated;
    },

    /**
     * Set a version's status to 'rejected'.
     */
    rejectVersion: async (versionId: string, reviewedByUserId: string) => {
      await assertStatusTransition(versionId, "in_review", "rejected");

      const [updated] = await db
        .update(skillVersions)
        .set({
          status: "rejected",
          reviewedByUserId,
          reviewedAt: new Date(),
        })
        .where(eq(skillVersions.id, versionId))
        .returning();

      return updated;
    },

    /**
     * Publish a version: set status to 'published', update the parent
     * companySkills row's publishedVersionId and markdown.
     */
    publishVersion: async (versionId: string) => {
      const version = await getVersionById(versionId);
      if (version.status !== "approved") {
        throw unprocessable(
          `Cannot publish version with status '${version.status}'; must be 'approved'`,
        );
      }

      const now = new Date();

      const [updated] = await db
        .update(skillVersions)
        .set({ status: "published", publishedAt: now })
        .where(eq(skillVersions.id, versionId))
        .returning();

      // Update parent skill
      await db
        .update(companySkills)
        .set({
          publishedVersionId: versionId,
          markdown: version.markdown,
          whenToUse: version.whenToUse,
          allowedTools: version.allowedTools as string[] | undefined,
          activationPaths: version.activationPaths as string[] | undefined,
          executionContext: version.executionContext,
          targetAgentType: version.targetAgentType,
          effort: version.effort,
          userInvocable: version.userInvocable,
          hooks: (version.hooks as Record<string, unknown> | null | undefined) ?? null,
          updatedAt: now,
        })
        .where(eq(companySkills.id, version.skillId));

      return updated;
    },

    /**
     * Set a version's status to 'deprecated'.
     */
    deprecateVersion: async (versionId: string) => {
      const version = await getVersionById(versionId);
      if (version.status !== "published") {
        throw unprocessable(
          `Cannot deprecate version with status '${version.status}'; must be 'published'`,
        );
      }

      const [updated] = await db
        .update(skillVersions)
        .set({ status: "deprecated", deprecatedAt: new Date() })
        .where(eq(skillVersions.id, versionId))
        .returning();

      return updated;
    },

    /**
     * Replace all dependencies for a skill. Performs circular dependency
     * check (BFS) before inserting.
     */
    setDependencies: async (
      companyId: string,
      skillId: string,
      deps: Array<{
        dependsOnSkillId: string;
        versionConstraint?: string;
        isRequired?: boolean;
      }>,
    ) => {
      // Check for self-dependencies
      for (const dep of deps) {
        if (dep.dependsOnSkillId === skillId) {
          throw unprocessable("A skill cannot depend on itself");
        }
      }

      // Check for circular dependencies
      for (const dep of deps) {
        const hasCycle = await detectDependencyCycle(
          companyId,
          skillId,
          dep.dependsOnSkillId,
        );
        if (hasCycle) {
          throw unprocessable(
            `Adding dependency on skill ${dep.dependsOnSkillId} would create a cycle`,
          );
        }
      }

      // Delete existing dependencies for this skill
      await db
        .delete(skillDependencies)
        .where(
          and(
            eq(skillDependencies.companyId, companyId),
            eq(skillDependencies.skillId, skillId),
          ),
        );

      if (deps.length === 0) return [];

      // Insert new dependencies
      const created = await db
        .insert(skillDependencies)
        .values(
          deps.map((dep) => ({
            companyId,
            skillId,
            dependsOnSkillId: dep.dependsOnSkillId,
            versionConstraint: dep.versionConstraint ?? null,
            isRequired: dep.isRequired ?? true,
          })),
        )
        .returning();

      return created;
    },

    /**
     * Get all dependencies for a skill.
     */
    getDependencies: async (companyId: string, skillId: string) => {
      return db
        .select()
        .from(skillDependencies)
        .where(
          and(
            eq(skillDependencies.companyId, companyId),
            eq(skillDependencies.skillId, skillId),
          ),
        );
    },

    /**
     * BFS: resolve the full dependency tree for a skill (max depth 10).
     * Returns a flat array of all required skill IDs.
     */
    resolveDependencyTree: async (companyId: string, skillId: string) => {
      const allSkillIds = new Set<string>();
      const queue: Array<{ id: string; depth: number }> = [{ id: skillId, depth: 0 }];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);

        if (current.depth >= 10) continue;

        const deps = await db
          .select({ dependsOnSkillId: skillDependencies.dependsOnSkillId })
          .from(skillDependencies)
          .where(
            and(
              eq(skillDependencies.companyId, companyId),
              eq(skillDependencies.skillId, current.id),
            ),
          );

        for (const dep of deps) {
          allSkillIds.add(dep.dependsOnSkillId);
          if (!visited.has(dep.dependsOnSkillId)) {
            queue.push({ id: dep.dependsOnSkillId, depth: current.depth + 1 });
          }
        }
      }

      return Array.from(allSkillIds);
    },
  };
}

function parseMarkdownFrontmatter(markdown: string): Record<string, unknown> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return {};
  const block = normalized.slice(4, closing);
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}
