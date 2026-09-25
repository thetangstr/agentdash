import { z } from "zod";
import { assistantKickoffRequestId } from "@paperclipai/shared";
import type { PaperclipApiClient } from "../client.js";
import type { AssistantContext } from "./context.js";
import type { ToolDefinition } from "../tools.js";
import {
  clip,
  DESTRUCTIVE_WORK_ANNOTATIONS,
  FREE_TEXT_LIMIT,
  makeAssistantTool,
  ok,
  refused,
  WORK_ANNOTATIONS,
} from "./envelope.js";
import { redactAssistantValue } from "./redact.js";
import {
  agentMap,
  cardFor,
  projectMap,
  refInput,
  resolveBestFit,
  unresolved,
  userMap,
} from "./lookups.js";
import {
  resolveAgentRef,
  resolveIssueRef,
  resolveProjectRef,
  type AgentRow,
  type IssueRow,
  type ProjectRow,
  type Resolution,
} from "./resolve.js";

/**
 * AgentDash assistant MCP (M3, GH #678, spec §4.2 tools 10–14): the work
 * class — immediate, reversible writes a person's assistant performs on
 * their behalf. Every tool wraps an existing REST route so route-level
 * authorization, company scoping, activity logging and wake-up behaviour
 * apply exactly as they do for the board UI; the loopback credential is
 * scope-gated (`agentdash:work`) and rate-limited upstream in
 * middleware/auth.ts, so a refusal lands here as a `refused` envelope.
 *
 * Rules carried from §4.1, now with side effects:
 * - Resolve every name/ref BEFORE writing; 0 or 2+ matches answer with
 *   not_found / needs_clarification and change nothing.
 * - "best fit" means the company's Chief of Staff — never a guess.
 * - What changed is echoed back (before/after where a field moves).
 */

/** The literal phrase the spec routes to the Chief of Staff. */
const BEST_FIT = /^\s*best\s*fit\s*$/i;

const WRITE_STATUS_ENUM = z.enum(["todo", "in_progress", "done", "cancelled", "backlog"]);

/** The small before/after view `update_work_item` and `assign_work` return. */
interface WorkSnapshot {
  ref: string;
  status: string;
  priority: string | null;
  title: string;
  project: string | null;
  assignee: string | null;
  link: string;
}

function snapshot(
  issue: IssueRow,
  projects: Map<string, ProjectRow>,
  ownerName: string | null,
  link: string,
): WorkSnapshot {
  return {
    ref: issue.identifier ?? issue.id,
    status: issue.status,
    priority: issue.priority ?? null,
    title: clip(issue.title, 120),
    project: issue.projectId ? projects.get(issue.projectId)?.name ?? null : null,
    assignee: ownerName,
    link,
  };
}

/** agent-or-CoS resolution shared by the three tools that take an assignee. */
async function resolveAssignee(
  client: PaperclipApiClient,
  companyId: string,
  raw: string,
): Promise<Resolution<AgentRow>> {
  if (BEST_FIT.test(raw)) return resolveBestFit(client, companyId);
  return resolveAgentRef(client, companyId, raw);
}

interface CreatedIssueResponse extends IssueRow {
  identifier?: string | null;
  /** Server idempotency replay — the row already existed, nothing re-created. */
  replayed?: boolean;
}

/**
 * The nudge wakeup's dedup key (GH #745 review): one paid wake per task
 * per hour. A retry inside the bucket replays the recorded wakeup row;
 * a genuine second nudge an hour later still goes through.
 */
function nudgeIdempotencyKey(issueId: string): string {
  return `assistant_nudge:${issueId}:${Math.floor(Date.now() / 3600000)}`;
}

export function assistantWorkTools(client: PaperclipApiClient, ctx: AssistantContext): ToolDefinition[] {
  const companyId = () => ctx.companyId;

  const startProject = makeAssistantTool(
    "start_project",
    "AgentDash: create a project with a goal, and a kickoff task for its lead (default: the Chief of Staff) to plan and staff it.",
    z.object({
      name: z.string().min(1).max(200).describe("The project's name, as the person said it"),
      goal: z.string().max(4000).optional().describe("What the project is for — becomes the project description and the kickoff task's brief"),
      lead: refInput("The agent to lead it").optional().describe("Who leads it — omit for the Chief of Staff, or say \"best fit\""),
      dueDate: z.string().max(64).optional().describe("Target date (ISO 8601, e.g. 2026-10-31)"),
    }),
    async ({ name, goal, lead, dueDate }) => {
      let leadAgent: AgentRow | null = null;
      if (lead) {
        const resolution = await resolveAssignee(client, companyId(), lead);
        const unresolvedResult = await unresolved(resolution, "agent", (ref) => ctx.agentLink(ref));
        if (unresolvedResult) return unresolvedResult;
        leadAgent = (resolution as { value: AgentRow }).value;
      } else {
        const cos = await resolveBestFit(client, companyId());
        // No CoS is not a clarification — the project still gets created,
        // just without a kickoff task, and the summary says so plainly.
        if (cos.kind === "one") leadAgent = cos.value;
        if (cos.kind === "many") {
          const unresolvedResult = await unresolved(cos, "Chief of Staff", (ref) => ctx.agentLink(ref));
          if (unresolvedResult) return unresolvedResult;
        }
      }

      // The server replays a live same-name project for assistant writes
      // (`replayed: true`), so a retry after a failed kickoff lands here
      // with the ORIGINAL project and finishes the pending kickoff instead
      // of orphaning a second one.
      const project = await client.requestJson<ProjectRow & { replayed?: boolean; kickoffPending?: boolean }>(
        "POST",
        `/companies/${companyId()}/projects`,
        {
          body: {
            name,
            description: goal ?? null,
            targetDate: dueDate ?? null,
            leadAgentId: leadAgent?.id ?? null,
          },
        },
      );
      const projectReplayed = project.replayed === true;
      // Reported by the server on a replayed project — true when this retry
      // still has to file the kickoff task.
      const kickoffWasPending = project.kickoffPending === true;

      let kickoffCard = null;
      let kickoffReplayed = false;
      let wakeQueued = false;
      if (leadAgent) {
        const kickoff = await client.requestJson<CreatedIssueResponse>(
          "POST",
          `/companies/${companyId()}/issues`,
          {
            body: {
              projectId: project.id,
              title: `Kick off ${clip(name, 80)}`,
              description: `Plan and staff the ${name} project.${goal ? `\n\nGoal: ${goal}` : ""}`,
              assigneeAgentId: leadAgent.id,
              status: "todo",
              // Deterministic per project — the retry creates it once, ever.
              requestId: assistantKickoffRequestId(project.id),
            },
          },
        );
        kickoffReplayed = kickoff.replayed === true;
        kickoffCard = await cardFor(client, ctx, kickoff);
        // Assigned + non-backlog ⇒ the route's issue_assigned wakeup is queued.
        wakeQueued = true;
      }

      const projectLink = await ctx.projectLink(project.id);
      const leadName = leadAgent?.name ?? null;
      const summary = projectReplayed
        ? `${project.name} already exists — reusing it${leadName ? kickoffReplayed ? `, and ${leadName}'s kickoff task was already there` : `, and ${leadName} now has the kickoff task` : ""}. ${projectLink}`
        : `${project.name} is created${leadName ? `, and ${leadName} has a kickoff task to plan and staff it` : ""}. ${projectLink}`;
      return ok({
        summary,
        data: redactAssistantValue({
          project: { id: project.id, name: project.name, link: projectLink },
          projectReused: projectReplayed,
          kickoffItem: kickoffCard,
          kickoffReplayed,
          kickoffWasPending,
          lead: leadAgent ? { name: leadAgent.name, link: await ctx.agentLink(leadAgent.id) } : null,
          wakeQueued,
        }),
        links: { primary: kickoffCard?.link ?? projectLink },
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const createWorkItem = makeAssistantTool(
    "create_work_item",
    "AgentDash: file a task and, optionally, assign it to an agent by name. Check find_work first to avoid duplicates.",
    z.object({
      title: z.string().min(1).max(500).describe("The task title, as the person said it"),
      description: z.string().max(4000).optional().describe("Details the assignee needs"),
      project: refInput("A project").optional().describe("The project it belongs to"),
      assignee: refInput("An agent").optional().describe("Which agent should do it — a name, or \"best fit\" for the Chief of Staff"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Task priority"),
    }),
    async ({ title, description, project, assignee, priority }) => {
      let projectRow: ProjectRow | null = null;
      if (project) {
        const resolution = await resolveProjectRef(client, companyId(), project);
        const unresolvedResult = await unresolved(resolution, "project", (ref) => ctx.projectLink(ref));
        if (unresolvedResult) return unresolvedResult;
        projectRow = (resolution as { value: ProjectRow }).value;
      }

      let assigneeAgent: AgentRow | null = null;
      if (assignee) {
        const resolution = await resolveAssignee(client, companyId(), assignee);
        const unresolvedResult = await unresolved(resolution, "agent", (ref) => ctx.agentLink(ref));
        if (unresolvedResult) return unresolvedResult;
        assigneeAgent = (resolution as { value: AgentRow }).value;
      }

      // Duplicate hint (spec §4.2): surface lookalikes in the answer — the
      // person may still want the new task, so this informs, never blocks.
      const lookalikes = await client
        .requestJson<IssueRow[]>(
          "GET",
          `/companies/${companyId()}/issues?q=${encodeURIComponent(title.slice(0, 200))}&limit=50`,
        )
        .then((list) => (Array.isArray(list) ? list : []))
        .catch(() => [] as IssueRow[]);
      const needle = title.trim().toLowerCase();
      const possibleDuplicates = lookalikes
        .filter(
          (issue) =>
            issue.status !== "cancelled" &&
            (issue.title.trim().toLowerCase() === needle || issue.title.trim().toLowerCase().includes(needle)),
        )
        .slice(0, 3);

      const issue = await client.requestJson<CreatedIssueResponse>(
        "POST",
        `/companies/${companyId()}/issues`,
        {
          body: {
            title,
            description: description ?? null,
            projectId: projectRow?.id ?? null,
            assigneeAgentId: assigneeAgent?.id ?? null,
            ...(priority ? { priority } : {}),
            // todo (not the backlog default) so the route's assignment wake-up
            // actually fires — queueIssueAssignmentWakeup skips backlog.
            ...(assigneeAgent ? { status: "todo" } : {}),
          },
        },
      );

      const card = await cardFor(client, ctx, issue);
      const wakeQueued = Boolean(assigneeAgent);
      const dupNote =
        possibleDuplicates.length > 0
          ? ` Heads-up: ${possibleDuplicates.map((d) => `${d.identifier ?? d.id.slice(0, 8)} "${clip(d.title, 60)}"`).join(", ")} look similar.`
          : "";
      return ok({
        summary: `Filed ${card.ref} — ${card.title}${assigneeAgent ? `, assigned to ${assigneeAgent.name}` : ""}.${dupNote} ${card.link}`,
        data: redactAssistantValue({
          item: card,
          assignedTo: assigneeAgent ? { name: assigneeAgent.name, link: await ctx.agentLink(assigneeAgent.id) } : null,
          wakeQueued,
          possibleDuplicates: possibleDuplicates.map((d) => ({
            ref: d.identifier ?? d.id,
            title: clip(d.title, 120),
            status: d.status,
          })),
        }),
        links: { primary: card.link },
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const assignWork = makeAssistantTool(
    "assign_work",
    "AgentDash: give an existing task to a different agent, or nudge the current owner to pick it up now.",
    z.object({
      ref: refInput("The task"),
      agent: refInput("The agent to give it to").optional().describe("Who gets it — a name or \"best fit\" for the Chief of Staff; omit to nudge the current owner"),
    }),
    async ({ ref, agent }) => {
      const resolution = await resolveIssueRef(client, companyId(), ref);
      const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: IssueRow }).value;

      if (!agent) {
        // Omit = nudge the current owner (spec §4.2 #12).
        if (found.assigneeUserId && !found.assigneeAgentId) {
          return refused({
            summary: `${found.identifier ?? ref} is assigned to a person, not an agent — I can only nudge agents. Nothing was changed.`,
          });
        }
        if (!found.assigneeAgentId) {
          return refused({
            summary: `${found.identifier ?? ref} has no assignee to nudge — tell me who should take it. Nothing was changed.`,
          });
        }
        const owner = await client
          .requestJson<AgentRow>("GET", `/agents/${found.assigneeAgentId}`)
          .catch(() => null);
        const run = await client.requestJson<{ status?: string; reason?: string; replayed?: boolean }>(
          "POST",
          `/agents/${found.assigneeAgentId}/wakeup`,
          {
            body: {
              source: "on_demand",
              triggerDetail: "manual",
              reason: `Nudge on ${found.identifier ?? found.id}`,
              payload: { issueId: found.id },
              // A paid wake dedupes on this key for an hour (route-side).
              idempotencyKey: nudgeIdempotencyKey(found.id),
            },
          },
        );
        const wakeQueued = run?.status !== "skipped";
        const link = await ctx.issueLink(found.identifier ?? found.id);
        return ok({
          summary: wakeQueued
            ? `Nudged ${owner?.name ?? "the assignee"} to pick up ${found.identifier ?? ref} now. ${link}`
            : `${found.identifier ?? ref} is still with ${owner?.name ?? "its owner"}, but the wake-up was skipped — it may already be running. ${link}`,
          data: redactAssistantValue({
            item: await cardFor(client, ctx, found),
            from: owner?.name ?? null,
            to: owner?.name ?? null,
            wakeQueued,
          }),
          links: { primary: link },
        });
      }

      const agentResolution = await resolveAssignee(client, companyId(), agent);
      const unresolvedAgent = await unresolved(agentResolution, "agent", (r) => ctx.agentLink(r));
      if (unresolvedAgent) return unresolvedAgent;
      const target = (agentResolution as { value: AgentRow }).value;

      const [projects, agents, users] = await Promise.all([
        projectMap(client, companyId()),
        agentMap(client, companyId()),
        userMap(client, companyId()),
      ]);
      const beforeOwner = found.assigneeAgentId
        ? agents.get(found.assigneeAgentId)?.name ?? null
        : found.assigneeUserId
          ? users.get(found.assigneeUserId) ?? "a person"
          : null;
      const beforeLink = await ctx.issueLink(found.identifier ?? found.id);
      const before = snapshot(found, projects, beforeOwner, beforeLink);

      const updated = await client.requestJson<IssueRow>("PATCH", `/issues/${found.id}`, {
        body: {
          assigneeAgentId: target.id,
          // Single-assignee invariant: a person-owned task moving to an agent
          // must clear assigneeUserId — PATCH leaves omitted fields untouched.
          assigneeUserId: null,
        },
      });
      const after = snapshot(updated, projects, target.name, await ctx.issueLink(updated.identifier ?? updated.id));
      // The route queues the assignee wake-up only off the backlog.
      const wakeQueued = updated.status !== "backlog";
      return ok({
        summary: `${after.ref} is now with ${target.name}${beforeOwner ? ` (was ${beforeOwner})` : ""}${wakeQueued ? " — they've been woken to pick it up" : " — it stays quiet on the backlog"}. ${after.link}`,
        data: redactAssistantValue({ before, after, wakeQueued }),
        links: { primary: after.link },
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const commentOnWork = makeAssistantTool(
    "comment_on_work",
    "AgentDash: post the person's instruction or answer on a task. The assigned agent reads it on its next run.",
    z.object({
      ref: refInput("The task"),
      text: z.string().min(1).max(4000).describe("What to say, in the person's voice"),
    }),
    async ({ ref, text }) => {
      const resolution = await resolveIssueRef(client, companyId(), ref);
      const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: IssueRow }).value;

      const comment = await client.requestJson<{ id: string; createdAt?: string }>(
        "POST",
        `/issues/${found.id}/comments`,
        { body: { body: text } },
      );
      const link = await ctx.issueLink(found.identifier ?? found.id);
      return ok({
        summary: `Posted on ${found.identifier ?? ref}${found.assigneeAgentId ? " — the assignee will read it on its next run" : ""}. ${link}`,
        data: redactAssistantValue({
          commentId: comment.id,
          item: { ref: found.identifier ?? found.id, title: clip(found.title, 120), status: found.status, link },
          commentPreview: clip(text, FREE_TEXT_LIMIT),
        }),
        links: { primary: link },
      });
    },
    { annotations: { ...WORK_ANNOTATIONS } },
  );

  const updateWorkItem = makeAssistantTool(
    "update_work_item",
    "AgentDash: change a task's status, priority, title or project. Cancelling is reversible by reopening.",
    z.object({
      ref: refInput("The task"),
      status: WRITE_STATUS_ENUM.optional().describe("New status — todo, in_progress, done, cancelled or backlog"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
      title: z.string().min(1).max(500).optional().describe("New title"),
      project: refInput("A project").optional().describe("Move it to this project"),
    }),
    async ({ ref, status, priority, title, project }) => {
      if (!status && !priority && !title && !project) {
        return refused({
          summary: "Nothing to change — tell me a new status, priority, title or project. Nothing was changed.",
        });
      }

      const resolution = await resolveIssueRef(client, companyId(), ref);
      const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: IssueRow }).value;

      let projectRow: ProjectRow | null = null;
      if (project) {
        const projectResolution = await resolveProjectRef(client, companyId(), project);
        const unresolvedProject = await unresolved(projectResolution, "project", (r) => ctx.projectLink(r));
        if (unresolvedProject) return unresolvedProject;
        projectRow = (projectResolution as { value: ProjectRow }).value;
      }

      const projects = await projectMap(client, companyId());
      const ownerName = found.assigneeAgentId
        ? await client
            .requestJson<AgentRow>("GET", `/agents/${found.assigneeAgentId}`)
            .then((a) => a?.name ?? null)
            .catch(() => null)
        : null;
      const before = snapshot(found, projects, ownerName, await ctx.issueLink(found.identifier ?? found.id));

      const updated = await client.requestJson<IssueRow>("PATCH", `/issues/${found.id}`, {
        body: {
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(title ? { title } : {}),
          ...(projectRow ? { projectId: projectRow.id } : {}),
        },
      });
      const after = snapshot(updated, projects, ownerName, await ctx.issueLink(updated.identifier ?? updated.id));

      const changes: string[] = [];
      if (status && before.status !== after.status) changes.push(`${before.status} → ${after.status}`);
      if (priority && before.priority !== after.priority) changes.push(`priority ${before.priority ?? "none"} → ${after.priority}`);
      if (title && before.title !== after.title) changes.push("retitled");
      if (projectRow && before.project !== after.project) changes.push(`moved to ${after.project ?? projectRow.name}`);
      return ok({
        summary: `${after.ref}: ${changes.length > 0 ? changes.join(", ") : "already as requested"}. ${after.link}`,
        data: redactAssistantValue({ before, after }),
        links: { primary: after.link },
      });
    },
    { annotations: { ...DESTRUCTIVE_WORK_ANNOTATIONS } },
  );

  return [startProject, createWorkItem, assignWork, commentOnWork, updateWorkItem];
}
