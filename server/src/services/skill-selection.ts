import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents, executionWorkspaces, issues, projectWorkspaces } from "@agentdash/db";
import type { CompanySkill } from "@agentdash/shared";
import { notFound } from "../errors.js";
import { companySkillService } from "./company-skills.js";

export interface SelectedSkillForRun {
  skill: CompanySkill;
  required: boolean;
  pathMatch: boolean;
  targetAgentMatch: boolean;
  selectionReason: string;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundledSkill(skill: CompanySkill) {
  const metadata = skill.metadata;
  return Boolean(metadata && typeof metadata === "object" && metadata.sourceKind === "paperclip_bundled");
}

function normalizeMatchPath(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || null;
}

function activationPathMatches(activationPath: string, candidatePaths: string[]) {
  const normalizedActivation = normalizeMatchPath(activationPath);
  if (!normalizedActivation) return false;
  return candidatePaths.some((candidate) => {
    const normalizedCandidate = normalizeMatchPath(candidate);
    if (!normalizedCandidate) return false;
    if (normalizedCandidate === normalizedActivation) return true;
    if (normalizedCandidate.endsWith(`/${normalizedActivation}`)) return true;
    const relativePath = path.posix.relative(normalizedActivation, normalizedCandidate);
    return relativePath !== "" && !relativePath.startsWith("../") && relativePath !== "..";
  });
}

export function skillSelectionService(db: Db) {
  const companySkills = companySkillService(db);

  return {
    selectForRun: async (input: {
      companyId: string;
      agentId: string;
      issueId?: string | null;
      projectWorkspaceId?: string | null;
      executionWorkspaceId?: string | null;
      cwd?: string | null;
    }): Promise<SelectedSkillForRun[]> => {
      const [agent, skills, issueRow] = await Promise.all([
        db
          .select({ id: agents.id, adapterType: agents.adapterType, role: agents.role })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null),
        companySkills.listFull(input.companyId),
        input.issueId
          ? db
            .select({
              projectWorkspaceId: issues.projectWorkspaceId,
              executionWorkspaceId: issues.executionWorkspaceId,
            })
            .from(issues)
            .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
      ]);

      if (!agent) throw notFound("Agent not found");

      const projectWorkspaceId = input.projectWorkspaceId ?? issueRow?.projectWorkspaceId ?? null;
      const executionWorkspaceId = input.executionWorkspaceId ?? issueRow?.executionWorkspaceId ?? null;
      const [projectWorkspaceRow, executionWorkspaceRow] = await Promise.all([
        projectWorkspaceId
          ? db
            .select({ cwd: projectWorkspaces.cwd })
            .from(projectWorkspaces)
            .where(and(eq(projectWorkspaces.id, projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        executionWorkspaceId
          ? db
            .select({ cwd: executionWorkspaces.cwd })
            .from(executionWorkspaces)
            .where(and(eq(executionWorkspaces.id, executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
      ]);

      const candidatePaths = Array.from(
        new Set(
          [
            input.cwd,
            projectWorkspaceRow?.cwd ?? null,
            executionWorkspaceRow?.cwd ?? null,
          ]
            .map((value) => normalizeMatchPath(asString(value)))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const selections = skills
        .map((skill) => {
          const required = isBundledSkill(skill);
          const targetAgentType = asString(skill.targetAgentType);
          const targetAgentMatch =
            !targetAgentType ||
            targetAgentType === agent.adapterType ||
            targetAgentType === agent.role;
          const pathMatch =
            skill.activationPaths.length === 0
              ? false
              : skill.activationPaths.some((activationPath) => activationPathMatches(activationPath, candidatePaths));

          const eligible =
            required ||
            (targetAgentMatch && (skill.activationPaths.length === 0 || pathMatch));

          if (!eligible) return null;

          const selectionReason = required
            ? "Bundled Paperclip skill"
            : pathMatch
              ? "Matched run workspace path"
              : targetAgentType
                ? `Matched target agent type ${targetAgentType}`
                : "Available to this run by default";

          return {
            skill,
            required,
            pathMatch,
            targetAgentMatch,
            selectionReason,
          } satisfies SelectedSkillForRun;
        })
        .filter((value): value is SelectedSkillForRun => Boolean(value));

      selections.sort((left, right) => {
        if (left.required !== right.required) return left.required ? -1 : 1;
        if (left.pathMatch !== right.pathMatch) return left.pathMatch ? -1 : 1;
        if (left.targetAgentMatch !== right.targetAgentMatch) return left.targetAgentMatch ? -1 : 1;
        return left.skill.name.localeCompare(right.skill.name);
      });

      return selections;
    },
  };
}
