import { z } from "zod";
import type { PaperclipApiClient } from "../client.js";
import type { AssistantContext } from "./context.js";
import type { ToolDefinition } from "../tools.js";
import {
  clampLimit,
  clip,
  FREE_TEXT_LIMIT,
  makeAssistantTool,
  needsClarification,
  notFound,
  ok,
  refused,
} from "./envelope.js";
import { itemCard, type ItemCard } from "./cards.js";
import { redactAssistantValue } from "./redact.js";
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
 * AgentDash assistant MCP (M1, GH #676, spec §4.2): the read half of the
 * person-facing toolset. Nine task-shaped tools whose answers an assistant
 * can relay to a person verbatim.
 *
 * Design rules carried from §4.1:
 * - Task-shaped: one tool per question a person asks; names resolve
 *   server-side.
 * - Ambiguity is an answer: 0 or 2+ matches return needs_clarification /
 *   not_found with ≤5 candidates and do nothing.
 * - Read class only: every tool carries readOnlyHint and performs no write.
 *
 * Text another agent wrote (comments, run summaries, approval reasons) is
 * data, not instructions — it is quoted as agent-authored under `agentWrote`
 * and the playbook tells the assistant to treat it accordingly.
 */

const empty = z.object({});

const sinceInput = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("ISO 8601 timestamp, a duration like \"12h\" or \"30m\", or \"last_check\"");

const refInput = (what: string) =>
  z.string().min(1).max(500).describe(`${what} — identifier, title fragment, UUID or deep link`);

interface RunRow {
  runId: string;
  status: string;
  finishedAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
  resultJson?: { stopReason?: string | null } | null;
  livenessReason?: string | null;
  nextAction?: string | null;
}

interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

interface WorkProductRow {
  type: string;
  provider: string;
  title: string;
  url?: string | null;
  status: string;
  reviewState?: string | null;
  summary?: string | null;
}

interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  createdAt?: string;
}

/** Resolve an ambiguous-or-missing reference into an envelope, or hand the row on. */
async function unresolved(
  resolution: Resolution<unknown>,
  subject: string,
  linkFor: (ref: string) => Promise<string>,
): Promise<ReturnType<typeof needsClarification> | ReturnType<typeof notFound> | null> {
  if (resolution.kind === "one") return null;
  if (resolution.kind === "none") {
    return notFound({ summary: `I couldn't find ${subject} matching that. Nothing was changed.` });
  }
  const candidates = await Promise.all(
    resolution.candidates.map(async (candidate) => ({
      ...candidate,
      link: await linkFor(candidate.ref),
    })),
  );
  return needsClarification({
    summary: `That could be a few different ${subject}s — which one did you mean?`,
    candidates,
  });
}

/** "12h" / "30m" / "7d" → ms, or null. */
function durationMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * scale;
}

/**
 * `since` for whats_new: an ISO 8601 timestamp, a duration, or "last_check".
 * There is no grant cursor until M2's OAuth grants exist — "last_check" and
 * an omitted `since` both resolve to the 24-hour default the spec names.
 * `new Date` alone is not a validator — it accepts bare numerals like "1".
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

function resolveSince(raw: string | undefined): { since: Date } | { error: string } {
  if (!raw || raw === "last_check") {
    return { since: new Date(Date.now() - 24 * 3_600_000) };
  }
  const duration = durationMs(raw);
  if (duration !== null) return { since: new Date(Date.now() - duration) };
  if (!ISO_8601.test(raw.trim())) {
    return { error: "since must be an ISO 8601 timestamp or a duration like \"12h\"" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "since must be an ISO 8601 timestamp or a duration like \"12h\"" };
  }
  return { since: parsed };
}

async function agentMap(client: PaperclipApiClient, companyId: string): Promise<Map<string, AgentRow>> {
  const rows = await client
    .requestJson<AgentRow[]>("GET", `/companies/${companyId}/agents`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as AgentRow[]);
  return new Map(rows.map((row) => [row.id, row]));
}

async function projectMap(client: PaperclipApiClient, companyId: string): Promise<Map<string, ProjectRow>> {
  const rows = await client
    .requestJson<ProjectRow[]>("GET", `/companies/${companyId}/projects`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as ProjectRow[]);
  return new Map(rows.map((row) => [row.id, row]));
}

interface DigestSection {
  total: number;
  shown: number;
  items: Array<{
    issueId?: string;
    identifier?: string | null;
    title?: string | null;
    agentName?: string | null;
    project?: string | null;
    updatedAt?: string;
    completedAt?: string;
    approvalId?: string;
    type?: string;
    waitingSince?: string;
    workProducts?: WorkProductRow[];
  }>;
}

interface DigestResponse {
  agentsAnsweredFor: number;
  since: string | null;
  asOf: string;
  shipped: DigestSection;
  blocked: DigestSection;
  decisionsWaiting: DigestSection;
  truncated: boolean;
}

/**
 * Digest rows are agent-authored content — titles clip to 120, work-product
 * summaries to FREE_TEXT_LIMIT, and every work product is marked `agentWrote`
 * so the assistant relays the text as quoted material, never instructions.
 */
function boundDigestSection(section: DigestSection): DigestSection {
  return {
    ...section,
    items: section.items.map((item) => ({
      ...item,
      title: item.title ? clip(item.title, 120) : item.title,
      workProducts: item.workProducts?.map((wp) => ({
        agentWrote: true,
        type: wp.type,
        provider: wp.provider,
        title: clip(wp.title, 120),
        url: wp.url ?? null,
        status: wp.status,
        reviewState: wp.reviewState ?? null,
        summary: wp.summary ? clip(wp.summary, FREE_TEXT_LIMIT) : null,
      })),
    })),
  };
}

export function assistantTools(client: PaperclipApiClient, ctx: AssistantContext): ToolDefinition[] {
  const companyId = () => ctx.companyId;

  async function cardFor(issue: IssueRow, agents: Map<string, AgentRow>, projects: Map<string, ProjectRow>): Promise<ItemCard> {
    return itemCard(ctx, issue, { agentById: agents, projectById: projects });
  }

  async function cardsFor(issues: IssueRow[]): Promise<ItemCard[]> {
    const [agents, projects] = await Promise.all([agentMap(client, companyId()), projectMap(client, companyId())]);
    return Promise.all(issues.map((issue) => cardFor(issue, agents, projects)));
  }

  const whoami = makeAssistantTool(
    "whoami",
    "AgentDash: who you are connected as, which company, and what you may do.",
    empty,
    async () => {
      const [me, company] = await Promise.all([
        client.requestJson<{
          user?: { name?: string | null; email?: string | null } | null;
          userId?: string | null;
          isInstanceAdmin?: boolean;
          source?: string;
          keyId?: string | null;
          companyIds?: string[];
          memberships?: Array<{ companyId?: string; role?: string }>;
        }>("GET", "/cli-auth/me"),
        ctx.company(),
      ]);
      const role = me.memberships?.find((m) => m.companyId === company.id)?.role ?? null;
      const scopes = ["read", ...(me.isInstanceAdmin ? ["instance_admin"] : role ? [role] : [])];
      const home = await ctx.homeLink();
      const name = me.user?.name ?? me.user?.email ?? "a board user";
      // The caller's own email is the one address allowed through redaction —
      // whoami exists to tell them who they are connected as.
      const data = redactAssistantValue({
        user: { name: me.user?.name ?? null, email: me.user?.email ?? null, userId: me.userId ?? null },
        company: { name: company.name, prefix: company.issuePrefix },
        scopes,
        grant: { client: me.source ?? "stdio", keyId: me.keyId ?? null, createdAt: null },
        links: { home },
      }, { allowEmails: me.user?.email ? [me.user.email] : [] });
      return ok({
        summary: `You're connected to ${company.name} on AgentDash as ${name} (${me.source ?? "board session"}), with ${scopes.join(", ")} access. ${home}`,
        data,
        links: { primary: home },
      });
    },
  );

  const whatsNew = makeAssistantTool(
    "whats_new",
    "AgentDash: what changed since a time. Finished work with PRs, new blockers, and decisions waiting for you. Start here for \"what happened\".",
    z.object({ since: sinceInput, project: refInput("A project name or id").optional() }),
    async ({ since, project }) => {
      const resolved = resolveSince(since);
      if ("error" in resolved) return refused({ summary: resolved.error });

      let projectId: string | null = null;
      let projectName: string | null = null;
      if (project) {
        const res = await resolveProjectRef(client, companyId(), project);
        const unresolvedResult = await unresolved(res, "project", (ref) => ctx.projectLink(ref));
        if (unresolvedResult) return unresolvedResult;
        projectId = (res as { value: ProjectRow }).value.id;
        projectName = (res as { value: ProjectRow }).value.name;
      }

      const digest = await client.requestJson<DigestResponse>(
        "GET",
        `/companies/${companyId()}/assistant/digest?since=${encodeURIComponent(resolved.since.toISOString())}${projectId ? `&projectId=${projectId}` : ""}`,
      );
      const scope = projectName ? ` on ${projectName}` : "";
      const shippedNames = digest.shipped.items
        .slice(0, 3)
        .map((item) => {
          const title = item.title ? clip(item.title, 120) : item.title;
          const wp = item.workProducts?.find((w) => w.url);
          return title && wp ? `${title} (${clip(wp.title, 120)})` : title;
        })
        .filter((title): title is string => Boolean(title));
      const shippedMore = digest.shipped.total - shippedNames.length;
      const parts: string[] = [];
      parts.push(
        digest.shipped.total === 0
          ? `Nothing finished${scope} since ${digest.since ?? "yesterday"}`
          : `${digest.shipped.total} thing${digest.shipped.total === 1 ? "" : "s"} finished${scope}${shippedNames.length ? `: ${shippedNames.join(", ")}` : ""}${shippedMore > 0 ? `, and ${shippedMore} more` : ""}`,
      );
      if (digest.blocked.total > 0) {
        parts.push(`${digest.blocked.total} blocked`);
      }
      if (digest.decisionsWaiting.total > 0) {
        parts.push(`${digest.decisionsWaiting.total} decision${digest.decisionsWaiting.total === 1 ? "" : "s"} wait${digest.decisionsWaiting.total === 1 ? "s" : ""} for you`);
      }
      const firstLink = digest.shipped.items.find((item) => item.identifier)?.identifier;
      const primary = firstLink ? await ctx.issueLink(firstLink) : await ctx.homeLink();
      const boundedDigest = {
        ...digest,
        shipped: boundDigestSection(digest.shipped),
        blocked: boundDigestSection(digest.blocked),
        decisionsWaiting: boundDigestSection(digest.decisionsWaiting),
      };
      return ok({
        summary: `${parts.join("; ")}. ${primary}`,
        data: redactAssistantValue(boundedDigest as unknown as Record<string, unknown>),
        links: { primary },
        truncated: digest.truncated,
      });
    },
  );

  const listProjects = makeAssistantTool(
    "list_projects",
    "AgentDash: the company's projects with a one-line status each.",
    z.object({
      status: z.enum(["active", "all"]).optional().describe("\"active\" (default) hides archived and completed projects"),
    }),
    async ({ status }) => {
      const [projects, issues, agents] = await Promise.all([
        client.requestJson<ProjectRow[]>("GET", `/companies/${companyId()}/projects`),
        client.requestJson<IssueRow[]>("GET", `/companies/${companyId()}/issues?limit=1000`),
        agentMap(client, companyId()),
      ]);
      const filtered = status === "all"
        ? projects
        : projects.filter((p) => p.status !== "archived" && p.status !== "completed");
      const visible = filtered.slice(0, 25);
      const items = await Promise.all(
        visible.map(async (project) => {
          const projectIssues = (issues ?? []).filter((issue) => issue.projectId === project.id);
          const counts: Record<string, number> = {};
          for (const issue of projectIssues) counts[issue.status] = (counts[issue.status] ?? 0) + 1;
          const lastShipped = projectIssues
            .filter((issue) => issue.status === "done" && issue.completedAt)
            .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0];
          const lead = project.leadAgentId ? agents.get(project.leadAgentId)?.name ?? null : null;
          const countText = Object.entries(counts)
            .map(([state, n]) => `${n} ${state}`)
            .join(", ") || "no tasks yet";
          return {
            name: project.name,
            lead,
            status: project.status ?? null,
            counts,
            lastShipped: lastShipped ? { ref: lastShipped.identifier ?? null, title: lastShipped.title, completedAt: lastShipped.completedAt ?? null } : null,
            oneLine: `${countText}${lastShipped ? `; last shipped ${lastShipped.title}` : ""}`,
            link: await ctx.projectLink(project.id),
          };
        }),
      );
      const primary = items[0]?.link ?? (await ctx.homeLink());
      return ok({
        summary:
          items.length === 0
            ? `No ${status === "all" ? "" : "active "}projects yet. ${primary}`
            : `${items.length} project${items.length === 1 ? "" : "s"}${status === "all" ? "" : " active"}: ${items.slice(0, 5).map((i) => i.name).join(", ")}${items.length > 5 ? `, and ${items.length - 5} more` : ""}. ${primary}`,
        data: redactAssistantValue({ projects: items, total: filtered.length, truncated: filtered.length > items.length }),
        links: { primary },
        truncated: filtered.length > items.length,
      });
    },
  );

  const getProject = makeAssistantTool(
    "get_project",
    "AgentDash: how one project is going. Progress, who is on it, what is blocked, and what shipped.",
    z.object({ project: refInput("The project") }),
    async ({ project }) => {
      const resolution = await resolveProjectRef(client, companyId(), project);
      const unresolvedResult = await unresolved(resolution, "project", (ref) => ctx.projectLink(ref));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: ProjectRow }).value;

      const [detail, issues, agents] = await Promise.all([
        client.requestJson<ProjectRow & { goalId?: string | null }>("GET", `/projects/${found.id}`).catch(() => found),
        client.requestJson<IssueRow[]>("GET", `/companies/${companyId()}/issues?projectId=${found.id}&limit=500`),
        agentMap(client, companyId()),
      ]);
      const list = Array.isArray(issues) ? issues : [];
      const counts: Record<string, number> = {};
      for (const issue of list) counts[issue.status] = (counts[issue.status] ?? 0) + 1;
      const projects = await projectMap(client, companyId());
      const inProgress = await Promise.all(
        list.filter((i) => i.status === "in_progress").slice(0, 5).map((i) => cardFor(i, agents, projects)),
      );
      const blockedItems = await Promise.all(
        list.filter((i) => i.status === "blocked").slice(0, 5).map((i) => cardFor(i, agents, projects)),
      );
      const shipped = list
        .filter((i) => i.status === "done")
        .sort((a, b) => String(b.completedAt ?? b.updatedAt).localeCompare(String(a.completedAt ?? a.updatedAt)))
        .slice(0, 3);
      const recentlyShipped = await Promise.all(
        shipped.map(async (issue) => ({
          card: await cardFor(issue, agents, projects),
          workProducts: await client
            .requestJson<WorkProductRow[]>("GET", `/issues/${issue.id}/work-products`)
            .then((rows) => (Array.isArray(rows) ? rows.slice(0, 3) : []))
            .catch(() => []),
        })),
      );
      const lead = detail.leadAgentId ? agents.get(detail.leadAgentId)?.name ?? null : null;
      const countText = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") || "no tasks yet";
      const lastShippedTitle = recentlyShipped[0]?.card.title;
      const link = await ctx.projectLink(found.id);
      return ok({
        summary: `${found.name}: ${list.length} task${list.length === 1 ? "" : "s"} (${countText})${lead ? `, led by ${lead}` : ""}${lastShippedTitle ? `. Last shipped: ${lastShippedTitle}` : ""}. ${link}`,
        data: redactAssistantValue({
          project: { id: found.id, name: found.name, status: detail.status ?? null, goal: detail.description ? clip(detail.description, FREE_TEXT_LIMIT) : null, lead, targetDate: detail.targetDate ?? null },
          counts,
          total: list.length,
          inProgress,
          blocked: blockedItems,
          recentlyShipped,
        }),
        links: { primary: link },
      });
    },
  );

  const findWork = makeAssistantTool(
    "find_work",
    "AgentDash: find tasks by words, status, person or project. Use before creating a task, to avoid duplicates.",
    z.object({
      query: z.string().max(280).optional().describe("Words to match in the title or identifier"),
      status: z
        .enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"])
        .optional()
        .describe("Task status filter"),
      agent: refInput("A person or agent").optional(),
      project: refInput("A project").optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async ({ query, status, agent, project, limit }) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (status) params.set("status", status);

      if (agent) {
        const res = await resolveAgentRef(client, companyId(), agent);
        const unresolvedResult = await unresolved(res, "person or agent", (ref) => ctx.agentLink(ref));
        if (unresolvedResult) return unresolvedResult;
        params.set("assigneeAgentId", (res as { value: AgentRow }).value.id);
      }
      if (project) {
        const res = await resolveProjectRef(client, companyId(), project);
        const unresolvedResult = await unresolved(res, "project", (ref) => ctx.projectLink(ref));
        if (unresolvedResult) return unresolvedResult;
        params.set("projectId", (res as { value: ProjectRow }).value.id);
      }
      params.set("limit", "500");

      const issues = await client.requestJson<IssueRow[]>(
        "GET",
        `/companies/${companyId()}/issues?${params.toString()}`,
      );
      const list = (Array.isArray(issues) ? issues : []);
      const capped = clampLimit(limit);
      const shown = list.slice(0, capped);
      const cards = await cardsFor(shown);
      const primary = cards[0]?.link ?? (await ctx.homeLink());
      const more = list.length - shown.length;
      return ok({
        summary:
          cards.length === 0
            ? `No matching tasks${query ? ` for "${clip(query, 60)}"` : ""}. ${primary}`
            : `${list.length} task${list.length === 1 ? "" : "s"}${query ? ` matching "${clip(query, 60)}"` : ""}: ${cards.slice(0, 4).map((c) => `${c.ref} ${c.title}`).join("; ")}${more > 0 ? `; and ${more} more` : ""}. ${primary}`,
        data: redactAssistantValue({ items: cards, total: list.length, truncated: more > 0 }),
        links: { primary },
        truncated: more > 0,
      });
    },
  );

  const getWorkItem = makeAssistantTool(
    "get_work_item",
    "AgentDash: one task's current state. Status, owner, latest update, linked PRs and pending decisions.",
    z.object({ ref: refInput("The task") }),
    async ({ ref }) => {
      const resolution = await resolveIssueRef(client, companyId(), ref);
      const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: IssueRow }).value;

      const [detail, comments, runs, approvals, agents, projects] = await Promise.all([
        client.requestJson<IssueRow & {
          project?: ProjectRow | null;
          workProducts?: WorkProductRow[];
          blockedBy?: Array<{ identifier?: string | null; title?: string }>;
        }>("GET", `/issues/${found.id}`),
        client.requestJson<CommentRow[]>("GET", `/issues/${found.id}/comments?limit=3`).catch(() => [] as CommentRow[]),
        client.requestJson<RunRow[]>("GET", `/issues/${found.id}/runs?limit=3`).catch(() => [] as RunRow[]),
        client.requestJson<ApprovalRow[]>("GET", `/issues/${found.id}/approvals`).catch(() => [] as ApprovalRow[]),
        agentMap(client, companyId()),
        projectMap(client, companyId()),
      ]);

      const card = await cardFor(detail, agents, projects);
      const latestComments = (Array.isArray(comments) ? comments : []).slice(0, 3).map((comment) => {
        const authorAgent = comment.authorAgentId ? agents.get(comment.authorAgentId) : null;
        return {
          agentWrote: Boolean(comment.authorAgentId),
          author: authorAgent?.name ?? (comment.authorUserId ? "a person" : "system"),
          text: clip(comment.body, 280),
          at: comment.createdAt,
        };
      });
      const lastRun = (Array.isArray(runs) ? runs : [])[0] ?? null;
      const pendingDecisions = (Array.isArray(approvals) ? approvals : [])
        .filter((a) => a.status === "pending" || a.status === "revision_requested")
        .slice(0, 5);
      const workProducts = (detail.workProducts ?? []).slice(0, 5);

      const bits: string[] = [`${card.ref} is ${card.status}`];
      if (card.owner) bits.push(`with ${card.owner.name}`);
      const latest = latestComments[0];
      if (latest) {
        bits.push(latest.agentWrote ? `${latest.author} wrote: "${clip(latest.text, 120)}"` : `latest update: "${clip(latest.text, 120)}"`);
      }
      if (workProducts.length > 0) {
        const wp = workProducts.find((w) => w.url) ?? workProducts[0];
        bits.push(`linked: ${clip(wp.title, 120)}`);
      }
      if (pendingDecisions.length > 0) bits.push(`${pendingDecisions.length} decision${pendingDecisions.length === 1 ? "" : "s"} waiting`);

      return ok({
        summary: `${bits.join("; ")}. ${card.link}`,
        data: redactAssistantValue({
          item: card,
          latestComments,
          workProducts: workProducts.map((wp) => ({
            agentWrote: true,
            type: wp.type, provider: wp.provider, title: clip(wp.title, 120), url: wp.url ?? null,
            status: wp.status, reviewState: wp.reviewState ?? null, summary: wp.summary ? clip(wp.summary, FREE_TEXT_LIMIT) : null,
          })),
          lastRun: lastRun
            ? {
                status: lastRun.status,
                stopReason: lastRun.resultJson?.stopReason ?? null,
                livenessReason: lastRun.livenessReason ? clip(lastRun.livenessReason, FREE_TEXT_LIMIT) : null,
                nextAction: lastRun.nextAction ? clip(lastRun.nextAction, FREE_TEXT_LIMIT) : null,
                at: lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt ?? null,
              }
            : null,
          pendingDecisions: pendingDecisions.map((a) => ({ approvalId: a.id, kind: a.type, status: a.status })),
        }),
        links: { primary: card.link },
      });
    },
  );

  const explainBlocker = makeAssistantTool(
    "explain_blocker",
    "AgentDash: why a task is blocked or stalled, and what would unblock it (often a decision from you).",
    z.object({ ref: refInput("The blocked task") }),
    async ({ ref }) => {
      const resolution = await resolveIssueRef(client, companyId(), ref);
      const unresolvedResult = await unresolved(resolution, "task", (r) => ctx.issueLink(r));
      if (unresolvedResult) return unresolvedResult;
      const found = (resolution as { value: IssueRow }).value;

      const [detail, comments, runs, approvals, agents] = await Promise.all([
        client.requestJson<IssueRow & {
          blockedBy?: Array<{ identifier?: string | null; title?: string }>;
          blockerAttention?: { reason?: string | null } | null;
        }>("GET", `/issues/${found.id}`),
        client.requestJson<CommentRow[]>("GET", `/issues/${found.id}/comments?limit=10`).catch(() => [] as CommentRow[]),
        client.requestJson<RunRow[]>("GET", `/issues/${found.id}/runs?limit=3`).catch(() => [] as RunRow[]),
        client.requestJson<ApprovalRow[]>("GET", `/issues/${found.id}/approvals`).catch(() => [] as ApprovalRow[]),
        agentMap(client, companyId()),
      ]);

      const lastRun = (Array.isArray(runs) ? runs : [])[0] ?? null;
      const pendingApprovals = (Array.isArray(approvals) ? approvals : []).filter(
        (a) => a.status === "pending" || a.status === "revision_requested",
      );
      const blockedBy = detail.blockedBy ?? [];
      const blockerComment = (Array.isArray(comments) ? comments : []).find((c) =>
        /^\s*blocked\b/i.test(c.body),
      );

      const blockerAuthor = blockerComment
        ? blockerComment.authorAgentId
          ? agents.get(blockerComment.authorAgentId)?.name ?? "an agent"
          : "a person"
        : null;

      const evidence: Array<Record<string, unknown>> = [];
      if (blockerComment) {
        evidence.push({ kind: "blocked_declaration", agentWrote: Boolean(blockerComment.authorAgentId), text: `${blockerAuthor} wrote: "${clip(blockerComment.body, 280)}"`, at: blockerComment.createdAt });
      }
      if (lastRun?.resultJson?.stopReason || lastRun?.livenessReason || lastRun?.nextAction) {
        evidence.push({
          kind: "run_stop",
          stopReason: lastRun.resultJson?.stopReason ?? null,
          livenessReason: lastRun.livenessReason ? clip(lastRun.livenessReason, FREE_TEXT_LIMIT) : null,
          nextAction: lastRun.nextAction ? clip(lastRun.nextAction, FREE_TEXT_LIMIT) : null,
          at: lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt ?? null,
        });
      }
      for (const dep of blockedBy.slice(0, 3)) {
        evidence.push({ kind: "dependency", ref: dep.identifier ?? null, title: dep.title ?? null });
      }
      for (const approval of pendingApprovals.slice(0, 3)) {
        evidence.push({ kind: "pending_decision", approvalId: approval.id, decisionKind: approval.type, waitingSince: approval.createdAt ?? null });
      }

      // A quoted reason must carry its author — "Priya wrote: ..." frames the
      // text as something an agent said, never as a fact the system asserts.
      const reason =
        detail.status !== "blocked"
          ? `${found.identifier ?? ref} is not marked blocked (it is ${detail.status})${lastRun?.livenessReason ? `, though its last run noted: ${clip(lastRun.livenessReason, 160)}` : ""}`
          : blockerComment
            ? `${blockerAuthor} wrote: "${clip(blockerComment.body.replace(/^\s*blocked[\s:—-]*/i, ""), 200)}"`
            : lastRun?.livenessReason
              ? clip(lastRun.livenessReason, 200)
              : pendingApprovals.length > 0
                ? `it is waiting on ${pendingApprovals.length} decision${pendingApprovals.length === 1 ? "" : "s"}`
                : "no explicit reason recorded";

      const unblockOptions: Array<{ option: string; tool: string }> = [];
      if (pendingApprovals.length > 0) {
        unblockOptions.push({ option: "decide the pending request(s)", tool: "list_pending_decisions" });
      }
      if (blockedBy.length > 0) {
        unblockOptions.push({ option: "check or finish the blocking task(s)", tool: "get_work_item" });
      }
      unblockOptions.push({ option: "post what it needs or a nudge", tool: "comment_on_work" });
      unblockOptions.push({ option: "hand it to someone else", tool: "assign_work" });

      const since = blockerComment?.createdAt ?? detail.updatedAt ?? null;
      const ownerName = detail.assigneeAgentId ? agents.get(detail.assigneeAgentId)?.name ?? null : null;
      const link = await ctx.issueLink(detail.identifier ?? detail.id);
      return ok({
        summary: `${detail.identifier ?? ref}: ${reason}${ownerName ? ` — ${ownerName} is on it` : ""}${since ? `, since ${since}` : ""}. ${link}`,
        data: redactAssistantValue({
          ref: detail.identifier ?? detail.id,
          reason,
          since,
          owner: ownerName,
          status: detail.status,
          evidence,
          unblockOptions,
        }),
        links: { primary: link },
      });
    },
  );

  const listTeam = makeAssistantTool(
    "list_team",
    "AgentDash: the company's agents, what each is working on, and whether they are running, idle or paused.",
    empty,
    async () => {
      const [agentRows, issues] = await Promise.all([
        client.requestJson<AgentRow[]>("GET", `/companies/${companyId()}/agents`),
        client.requestJson<IssueRow[]>("GET", `/companies/${companyId()}/issues?status=in_progress&limit=500`).catch(() => [] as IssueRow[]),
      ]);
      const eligible = (Array.isArray(agentRows) ? agentRows : [])
        .filter((agent) => agent.status !== "terminated" && agent.status !== "retired");
      const roster = eligible.slice(0, 25);
      const currentByAgent = new Map<string, IssueRow>();
      for (const issue of Array.isArray(issues) ? issues : []) {
        if (issue.assigneeAgentId && !currentByAgent.has(issue.assigneeAgentId)) {
          currentByAgent.set(issue.assigneeAgentId, issue);
        }
      }
      const items = await Promise.all(
        roster.map(async (agent) => {
          const current = currentByAgent.get(agent.id);
          return {
            name: agent.name,
            role: agent.title ?? agent.role ?? null,
            state: agent.status ?? "unknown",
            currentItem: current
              ? { ref: current.identifier ?? current.id, title: clip(current.title, 120), link: await ctx.issueLink(current.identifier ?? current.id) }
              : null,
            link: await ctx.agentLink(agent.id),
          };
        }),
      );
      const busy = items.filter((i) => i.currentItem).length;
      const primary = await ctx.homeLink();
      return ok({
        summary:
          items.length === 0
            ? `No agents in this company yet. ${primary}`
            : `${items.length} agent${items.length === 1 ? "" : "s"}: ${items.slice(0, 5).map((i) => i.currentItem ? `${i.name} on ${i.currentItem.ref}` : `${i.name} (${i.state})`).join("; ")}${items.length > 5 ? `; and ${items.length - 5} more` : ""}. ${busy} working now. ${primary}`,
        data: redactAssistantValue({ agents: items, total: eligible.length, truncated: eligible.length > items.length }),
        links: { primary },
        truncated: eligible.length > items.length,
      });
    },
  );

  const listPendingDecisions = makeAssistantTool(
    "list_pending_decisions",
    "AgentDash: approvals and questions from agents that are waiting on you, most urgent first.",
    z.object({ limit: z.number().int().min(1).max(10).optional() }),
    async ({ limit }) => {
      const response = await client.requestJson<{
        decisions: Array<{
          approvalId: string;
          kind: string;
          askedBy: string | null;
          summary: string;
          relatedItem?: { identifier?: string | null; title?: string | null } | null;
          waitingSince: string | null;
          canDecide: boolean;
          risk?: { level?: string } | null;
        }>;
        total: number;
        shown: number;
      }>("GET", `/companies/${companyId()}/assistant/pending-decisions`);

      const cap = Math.min(limit ?? 10, 10);
      const shown = (response.decisions ?? []).slice(0, cap);
      const items = await Promise.all(
        shown.map(async (decision) => ({
          ...decision,
          summary: clip(decision.summary, FREE_TEXT_LIMIT),
          relatedItem: decision.relatedItem
            ? {
                ...decision.relatedItem,
                title: decision.relatedItem.title ? clip(decision.relatedItem.title, 120) : decision.relatedItem.title,
              }
            : null,
          link: await ctx.approvalLink(decision.approvalId),
        })),
      );
      const undecidable = items.filter((d) => !d.canDecide).length;
      const primary = items[0]?.link ?? (await ctx.homeLink());
      const names = items.slice(0, 3).map((d) => d.summary.replace(/\.$/, ""));
      const more = (response.total ?? items.length) - items.length;
      return ok({
        summary:
          items.length === 0
            ? `Nothing is waiting on you. ${primary}`
            : `${response.total ?? items.length} thing${(response.total ?? items.length) === 1 ? "" : "s"} waiting on you: ${names.join("; ")}${more > 0 ? `; and ${more} more` : ""}${undecidable > 0 ? ` (${undecidable} you cannot decide)` : ""}. ${primary}`,
        data: redactAssistantValue({ decisions: items, total: response.total ?? items.length, truncated: more > 0 }),
        links: { primary },
        truncated: more > 0,
      });
    },
  );

  return [
    whoami,
    whatsNew,
    listProjects,
    getProject,
    findWork,
    getWorkItem,
    explainBlocker,
    listTeam,
    listPendingDecisions,
  ];
}
