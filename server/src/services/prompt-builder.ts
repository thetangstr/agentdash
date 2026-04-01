import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  agents,
  companies,
  issues,
  goals,
  agentOkrs,
  agentKeyResults,
  issueDependencies,
} from "@agentdash/db";
import type { SelectedSkillForRun } from "./skill-selection.js";

interface BuildCoordinationPromptInput {
  agentId: string;
  companyId: string;
  issueId?: string;
  runId: string;
  selectedSkills?: SelectedSkillForRun[]; // AgentDash: skill selection
  planBody?: string | null; // AgentDash: plan document
  planApprovalStatus?: string | null; // AgentDash: plan approval
}

interface CoordinationPromptResult {
  fullText: string;
  metadata: {
    agentId: string;
    issueId: string | null;
    builtAt: string;
  };
}

export function promptBuilderService(db: Db) {
  // ── helpers ──────────────────────────────────────────────────────────

  async function loadAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadCompany(companyId: string) {
    return db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadAgentOkrs(agentId: string) {
    const okrRows = await db
      .select()
      .from(agentOkrs)
      .where(and(eq(agentOkrs.agentId, agentId), eq(agentOkrs.status, "active")));

    if (okrRows.length === 0) return [];

    const okrIds = okrRows.map((o) => o.id);
    const krRows = await db
      .select()
      .from(agentKeyResults)
      .where(inArray(agentKeyResults.okrId, okrIds));

    return okrRows.map((okr) => ({
      ...okr,
      keyResults: krRows.filter((kr) => kr.okrId === okr.id),
    }));
  }

  async function loadIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadSubtasks(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.parentId, issueId));
  }

  async function loadBlockers(issueId: string) {
    const deps = await db
      .select({
        depId: issueDependencies.id,
        blockedByIssueId: issueDependencies.blockedByIssueId,
      })
      .from(issueDependencies)
      .where(eq(issueDependencies.issueId, issueId));

    if (deps.length === 0) return [];

    const blockerIds = deps.map((d) => d.blockedByIssueId);
    const blockerIssues = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, blockerIds));

    return blockerIssues;
  }

  async function loadDependents(issueId: string) {
    const deps = await db
      .select({
        depId: issueDependencies.id,
        depIssueId: issueDependencies.issueId,
      })
      .from(issueDependencies)
      .where(eq(issueDependencies.blockedByIssueId, issueId));

    if (deps.length === 0) return [];

    const dependentIds = deps.map((d) => d.depIssueId);
    const dependentIssues = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, dependentIds));

    return dependentIssues;
  }

  async function loadChainOfCommand(agentId: string) {
    const chain: Array<typeof agents.$inferSelect> = [];
    let currentId: string | null = agentId;

    for (let i = 0; i < 5; i++) {
      if (!currentId) break;

      const agent = await loadAgent(currentId);
      if (!agent || !agent.reportsTo) break;

      const manager = await loadAgent(agent.reportsTo);
      if (!manager) break;

      chain.unshift(manager);
      currentId = manager.reportsTo;
    }

    return chain;
  }

  async function loadPeers(companyId: string, reportsTo: string | null) {
    if (!reportsTo) return [];

    return db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.reportsTo, reportsTo),
        ),
      );
  }

  // ── section builders ────────────────────────────────────────────────

  function buildIdentitySection(
    agent: typeof agents.$inferSelect,
    manager: typeof agents.$inferSelect | null,
    okrs: Awaited<ReturnType<typeof loadAgentOkrs>>,
  ): string {
    const metadata = agent.metadata as Record<string, unknown> | null;
    const authorityLevel = metadata?.authorityLevel ?? "executor";
    const titleDisplay = agent.title || agent.role;

    const lines: string[] = [
      "## Identity",
      `You are **${agent.name}** (role: ${agent.role}, title: ${titleDisplay}).`,
    ];

    if (manager) {
      lines.push(`You report to **${manager.name}** (${manager.role}).`);
    }

    lines.push(`Authority level: ${authorityLevel}.`);

    if (okrs.length > 0) {
      lines.push("");
      lines.push("### Current OKRs");
      for (const okr of okrs) {
        lines.push(`- **Objective:** ${okr.objective}`);
        for (const kr of okr.keyResults) {
          lines.push(`  - ${kr.metric}: ${kr.currentValue}/${kr.targetValue} ${kr.unit}`);
        }
      }
    }

    return lines.join("\n");
  }

  function buildOrganizationSection(
    company: typeof companies.$inferSelect,
    chain: Array<typeof agents.$inferSelect>,
    agent: typeof agents.$inferSelect,
    peers: Array<typeof agents.$inferSelect>,
  ): string {
    const lines: string[] = [
      "## Organization",
      `Company: ${company.name}`,
    ];

    if (chain.length > 0) {
      const chainNames = [...chain.map((a) => a.name), agent.name];
      lines.push(`Chain of command: ${chainNames.join(" -> ")}`);
    }

    const filteredPeers = peers.filter((p) => p.id !== agent.id);
    if (filteredPeers.length > 0) {
      const peerDescriptions = filteredPeers.map((p) => `${p.name} (${p.role})`);
      lines.push(`Peers: ${peerDescriptions.join(", ")}`);
    }

    return lines.join("\n");
  }

  function buildTaskSection(
    issue: typeof issues.$inferSelect,
    subtasks: Array<typeof issues.$inferSelect>,
    blockers: Array<typeof issues.$inferSelect>,
    dependents: Array<typeof issues.$inferSelect>,
  ): string {
    const identifier = issue.identifier || issue.id;
    const lines: string[] = [
      "## Current Task",
      `**[${identifier}] ${issue.title}**`,
      `Status: ${issue.status} | Priority: ${issue.priority} | Project: ${issue.projectId || "none"}`,
    ];

    if (issue.description) {
      const truncated =
        issue.description.length > 500
          ? issue.description.slice(0, 500) + "..."
          : issue.description;
      lines.push("");
      lines.push(truncated);
    }

    if (subtasks.length > 0) {
      lines.push("");
      lines.push("Subtasks:");
      for (const sub of subtasks) {
        const subId = sub.identifier || sub.id;
        lines.push(`- [${subId}] ${sub.title} (${sub.status})`);
      }
    }

    if (blockers.length > 0) {
      lines.push("");
      lines.push("Blocked by:");
      for (const blocker of blockers) {
        const blockerId = blocker.identifier || blocker.id;
        lines.push(`- [${blockerId}] ${blocker.title} (${blocker.status})`);
      }
    }

    if (dependents.length > 0) {
      lines.push("");
      lines.push("Completing this task will unblock:");
      for (const dep of dependents) {
        const depId = dep.identifier || dep.id;
        lines.push(`- [${depId}] ${dep.title}`);
      }
    }

    return lines.join("\n");
  }

  // AgentDash: plan and skills prompt sections
  function buildPlanSection(planBody: string | null | undefined, planApprovalStatus: string | null | undefined) {
    if (!planBody && !planApprovalStatus) return "";
    const lines: string[] = ["## Issue Plan"];
    if (planApprovalStatus) {
      lines.push(`Plan approval status: ${planApprovalStatus}`);
    }
    if (planBody) {
      const truncated = planBody.length > 800 ? `${planBody.slice(0, 800)}...` : planBody;
      lines.push("");
      lines.push(truncated);
    }
    return lines.join("\n");
  }

  function buildRelevantSkillsSection(selectedSkills: SelectedSkillForRun[]) {
    if (selectedSkills.length === 0) return "";
    const lines: string[] = ["## Relevant Skills"];
    for (const selected of selectedSkills) {
      const label = selected.required ? "required" : "optional";
      lines.push(`- ${selected.skill.name} (${label})`);
      if (selected.skill.description) {
        lines.push(`  Description: ${selected.skill.description}`);
      }
      if (selected.skill.whenToUse) {
        lines.push(`  When to use: ${selected.skill.whenToUse}`);
      }
      lines.push(`  Why included: ${selected.selectionReason}`);
      if (selected.skill.allowedTools.length > 0) {
        lines.push(`  Allowed tools: ${selected.skill.allowedTools.join(", ")}`);
      }
    }
    return lines.join("\n");
  }

  function buildProtocolSection(): string {
    return [
      "## Coordination Protocol",
      "1. Check for assigned tasks before starting new work.",
      "2. Update task status as you progress (in_progress, in_review, done).",
      "3. When blocked, set status to 'blocked' and comment explaining the blocker.",
      "4. Completing a task automatically unblocks dependent tasks.",
      "5. Report progress via issue comments.",
      "6. Respect budget limits — your work will be paused if budget is exceeded.",
    ].join("\n");
  }

  // ── main method ─────────────────────────────────────────────────────

  async function buildCoordinationPrompt(
    input: BuildCoordinationPromptInput,
  ): Promise<CoordinationPromptResult> {
    const { agentId, companyId, issueId, runId } = input;

    // Load core data in parallel
    const [agent, company, okrs] = await Promise.all([
      loadAgent(agentId),
      loadCompany(companyId),
      loadAgentOkrs(agentId),
    ]);

    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    if (!company) {
      throw new Error(`Company ${companyId} not found`);
    }

    // Load manager (if reportsTo is set)
    const manager = agent.reportsTo ? await loadAgent(agent.reportsTo) : null;

    // Load chain of command and peers in parallel
    const [chain, peers] = await Promise.all([
      loadChainOfCommand(agentId),
      loadPeers(companyId, agent.reportsTo),
    ]);

    // Build core sections
    const sections: string[] = [
      buildIdentitySection(agent, manager, okrs),
      buildOrganizationSection(company, chain, agent, peers),
    ];

    // Load issue data if issueId is provided
    if (issueId) {
      const issue = await loadIssue(issueId);
      if (issue) {
        const [subtasks, blockers, dependents] = await Promise.all([
          loadSubtasks(issueId),
          loadBlockers(issueId),
          loadDependents(issueId),
        ]);
        sections.push(buildTaskSection(issue, subtasks, blockers, dependents));
      }
    }

    const planSection = buildPlanSection(input.planBody, input.planApprovalStatus);
    if (planSection) {
      sections.push(planSection);
    }

    const skillsSection = buildRelevantSkillsSection(input.selectedSkills ?? []);
    if (skillsSection) {
      sections.push(skillsSection);
    }

    // Always include the protocol section
    sections.push(buildProtocolSection());

    const fullText = sections.join("\n\n");

    return {
      fullText,
      metadata: {
        agentId,
        issueId: issueId ?? null,
        builtAt: new Date().toISOString(),
      },
    };
  }

  // ── public API ──────────────────────────────────────────────────────

  return {
    buildCoordinationPrompt,
    loadAgent,
    loadCompany,
    loadAgentOkrs,
    loadIssue,
    loadSubtasks,
    loadBlockers,
    loadDependents,
    loadChainOfCommand,
    loadPeers,
    buildIdentitySection,
    buildOrganizationSection,
    buildTaskSection,
    buildProtocolSection,
  };
}
