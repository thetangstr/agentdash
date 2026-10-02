// AgentDash (GH #786, UX-5): the hosted first run.
//
//   claim → model key → connect GitHub → first issue → Home
//
// Progress is derived from server state, never from the browser, so a founder
// who leaves mid-flow resumes at the first incomplete step:
//   - model:       required on a hosted box; done when the Hermes provider is configured
//   - repo:        done when the company has a GitHub connection (GH #782)
//   - first_issue: done when an issue with originKind "first_run" exists
//
// The first issue lands in the connected repo's project and is assigned to an
// engineer agent, hiring one (hermes_local on a hosted box, the default
// instructions bundle) when the company has none, within the Free agent cap.
// The CoS interview is not part of this flow; it stays at /cos as "Plan with
// your Chief of Staff".

import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, githubRepoConnections, issues, projects } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { companyService } from "./companies.js";
import { defaultAgentPlanAdapterType } from "./cos-replier.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { readHermesProviderStatus } from "./hermes-provider-setup.js";
import { issueService } from "./issues.js";
import { isHostedBox } from "./license.js";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  withCompanyTierCapacityGuard,
  type TierCapacityDeps,
} from "./tier-policy.js";

export const FIRST_RUN_ORIGIN_KIND = "first_run";

/**
 * When the hosted first run shipped (#804). A company created before this is
 * an established workspace: an upgrade must not start nagging it to "finish
 * setting up" unless it has no issues at all.
 */
export const FIRST_RUN_SHIPPED_AT = new Date("2026-09-27T00:00:00.000Z");
export const FIRST_RUN_STEPS = ["model", "repo", "first_issue", "done"] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** Three starting points shown as chips on the "What should we build first?" step. */
export const FIRST_ISSUE_SUGGESTIONS = [
  "Add a build status badge and a short Getting started section to the README",
  "Add tests for the module with the least test coverage",
  "Find and fix one small bug, and explain the fix in the pull request",
] as const;

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const INACTIVE_AGENT_STATUSES = ["terminated", "pending_approval"];

export interface FirstRunStatus {
  /** False for an agentdash_mk workspace: its onboarding is unchanged. /setup works whenever this is true. */
  applies: boolean;
  /**
   * Whether Home shows the first-run nudges ("Finish setting up", then
   * "Connect Muse"): a hosted box only, and only for a company created after
   * the first run shipped or one with no issues yet. Established companies
   * and self-hosted installs never see them; /setup stays reachable directly.
   */
  showHomeNudge: boolean;
  nextStep: FirstRunStep;
  model: { required: boolean; done: boolean };
  repo: {
    done: boolean;
    repo: string | null;
    projectId: string | null;
    /**
     * AgentDash: the company has shipped work (a done issue) with no repo
     * connected, so it works without code and Home stops offering GitHub.
     */
    shippedWithoutRepo: boolean;
  };
  firstIssue: {
    done: boolean;
    issueId: string | null;
    identifier: string | null;
    title: string | null;
    status: string | null;
    assigneeAgentId: string | null;
    assigneeName: string | null;
  };
  suggestions: readonly string[];
}

export interface FirstRunDeps {
  isHostedBox?: () => boolean;
  hermesProviderConfigured?: () => Promise<boolean>;
}

export class FirstRunCapError extends Error {
  constructor(readonly payload: ReturnType<typeof freeTierCapExceededPayload>) {
    super(payload.message);
  }
}

function tierDeps(dbOrTx: Db): TierCapacityDeps {
  const companiesSvc = companyService(dbOrTx);
  const access = accessService(dbOrTx);
  const agentsSvc = agentService(dbOrTx);
  return {
    getCompany: async (id) => ({ planTier: (await companiesSvc.getById(id))?.planTier ?? "free" }),
    counts: {
      humans: async (id) => (await access.listActiveUserMemberships(id)).length,
      agents: async (id) => (await agentsSvc.list(id)).length,
    },
  };
}

export function firstRunService(db: Db, deps: FirstRunDeps = {}) {
  const hosted = deps.isHostedBox ?? (() => isHostedBox());
  const providerConfigured =
    deps.hermesProviderConfigured ?? (async () => (await readHermesProviderStatus()).configured);

  async function firstRunIssue(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, FIRST_RUN_ORIGIN_KIND)))
      .orderBy(asc(issues.createdAt))
      .then((rows) => rows[0] ?? null);
  }

  async function firstConnection(companyId: string) {
    return db
      .select()
      .from(githubRepoConnections)
      .where(eq(githubRepoConnections.companyId, companyId))
      .orderBy(asc(githubRepoConnections.createdAt))
      .then((rows) => rows[0] ?? null);
  }

  async function status(companyId: string): Promise<FirstRunStatus> {
    const company = await db.select().from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    const required = hosted();
    const modelDone = !required || (await providerConfigured());
    const connection = await firstConnection(companyId);
    const issue = await firstRunIssue(companyId);
    const assignee = issue?.assigneeAgentId
      ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, issue.assigneeAgentId)).then((rows) => rows[0] ?? null)
      : null;
    const shippedWithoutRepo = connection
      ? false
      : Boolean(
          await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.status, "done")))
            .limit(1)
            .then((rows) => rows[0]),
        );
    const nextStep: FirstRunStep = !modelDone ? "model" : !connection ? "repo" : !issue ? "first_issue" : "done";
    const applies = company.productProfile !== "agentdash_mk";
    let showHomeNudge = false;
    if (applies && required) {
      const createdAfterShip = company.createdAt.getTime() >= FIRST_RUN_SHIPPED_AT.getTime();
      showHomeNudge =
        createdAfterShip ||
        !(await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, companyId))
          .limit(1)
          .then((rows) => rows[0]));
    }
    return {
      applies,
      showHomeNudge,
      nextStep,
      model: { required, done: modelDone },
      repo: {
        done: Boolean(connection),
        repo: connection ? `${connection.repoOwner}/${connection.repoName}` : null,
        projectId: connection?.projectId ?? null,
        shippedWithoutRepo,
      },
      firstIssue: {
        done: Boolean(issue),
        issueId: issue?.id ?? null,
        identifier: issue?.identifier ?? null,
        title: issue?.title ?? null,
        status: issue?.status ?? null,
        assigneeAgentId: issue?.assigneeAgentId ?? null,
        assigneeName: assignee?.name ?? null,
      },
      suggestions: FIRST_ISSUE_SUGGESTIONS,
    };
  }

  /** An active engineer to own the first issue, or null. Never the Chief of Staff. */
  async function findEngineer(dbOrTx: Db, companyId: string) {
    const rows = await dbOrTx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          inArray(agents.role, ["engineer"]),
          notInArray(agents.status, INACTIVE_AGENT_STATUSES),
        ),
      )
      .orderBy(asc(agents.createdAt));
    return rows[0] ?? null;
  }

  async function hireEngineer(dbOrTx: Db, companyId: string) {
    const agentsSvc = agentService(dbOrTx);
    const all = await agentsSvc.list(companyId);
    const cos = all.find((agent: { role: string }) => agent.role === "chief_of_staff") ?? null;
    const created = await agentsSvc.create(companyId, {
      name: "Engineer",
      role: "engineer",
      title: "Software Engineer",
      capabilities: "Works issues in the connected GitHub repository: a branch per issue, tests, and a pull request.",
      adapterType: defaultAgentPlanAdapterType(),
      adapterConfig: {},
      reportsTo: cos?.id ?? null,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
      metadata: { hiredBy: "first_run" },
    });
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    await agentInstructionsService().materializeManagedBundle(created, bundle, {
      entryFile: "AGENTS.md",
      replaceExisting: false,
    });
    return created;
  }

  return {
    status,

    /**
     * Create the first issue (idempotent: a second call returns the first),
     * in the connected repo's project, assigned to an engineer. Returns
     * whether an engineer was hired. Throws FirstRunCapError when the Free
     * cap leaves no room to hire one.
     */
    createFirstIssue: async (
      companyId: string,
      input: { title: unknown; description?: unknown },
      actorUserId: string | null,
    ) => {
      const existing = await firstRunIssue(companyId);
      if (existing) return { issue: existing, created: false, hiredAgentId: null as string | null };

      // On a hosted box the engineer runs on Hermes with the customer's model
      // key; without it the first run would start and fail (and count against
      // quota). Refuse until the model step is done (GH #786 review).
      if (hosted() && !(await providerConfigured())) {
        throw conflict("Add a model provider key first, so your engineer has a model to run on.");
      }

      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        throw badRequest("Say in one sentence what the team should build first.");
      }
      const text = input.title.trim().replace(/\s+/g, " ");
      const title = text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
      const extra = typeof input.description === "string" ? input.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";

      const connection = await firstConnection(companyId);
      if (!connection) throw conflict("Connect a GitHub repository first, so the team has somewhere to work.");
      const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, connection.projectId), eq(projects.companyId, companyId), isNull(projects.archivedAt)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw conflict("The connected repository's project is archived. Reconnect GitHub from a live project.");

      let engineer = await findEngineer(db, companyId);
      let hiredAgentId: string | null = null;
      if (!engineer) {
        const blocked = await exceededFreeTierCapacityAction(tierDeps(db), companyId, { agents: 1 });
        if (blocked) throw new FirstRunCapError(freeTierCapExceededPayload(blocked));
        let capPayload: ReturnType<typeof freeTierCapExceededPayload> | null = null;
        const result = await withCompanyTierCapacityGuard(
          db,
          companyId,
          { agents: 1 },
          tierDeps,
          (action) => {
            capPayload = freeTierCapExceededPayload(action);
          },
          async (tx) => {
            const found = await findEngineer(tx, companyId);
            if (found) return { agent: found, hired: false };
            return { agent: await hireEngineer(tx, companyId), hired: true };
          },
        );
        if (!result) throw new FirstRunCapError(capPayload ?? freeTierCapExceededPayload("hire"));
        engineer = result.agent as typeof engineer;
        if (result.hired) hiredAgentId = result.agent.id;
      }

      const description = [
        text.length > MAX_TITLE_LENGTH ? text : null,
        extra || null,
        `Work in ${connection.repoOwner}/${connection.repoName}: open a branch for this issue, make the change with tests where they fit, push it and open a pull request. Record the pull request on this issue as a work product. Do not merge.`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const issue = await issueService(db).create(companyId, {
        title,
        description,
        status: "todo",
        priority: "medium",
        projectId: project.id,
        assigneeAgentId: engineer!.id,
        originKind: FIRST_RUN_ORIGIN_KIND,
        originId: companyId,
        createdByUserId: actorUserId,
      } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
      return { issue, created: true, hiredAgentId };
    },
  };
}
