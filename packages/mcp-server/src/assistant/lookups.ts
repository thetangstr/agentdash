import { z } from "zod";
import type { PaperclipApiClient } from "../client.js";
import type { AssistantContext } from "./context.js";
import { needsClarification, notFound } from "./envelope.js";
import { itemCard, type ItemCard } from "./cards.js";
import {
  resolveAgentRef,
  type AgentRow,
  type IssueRow,
  type ProjectRow,
  type Resolution,
} from "./resolve.js";

/**
 * AgentDash assistant MCP: the lookup helpers the read tools (tools.ts) and
 * the M3 work tools (work.ts) share — ref inputs, reference resolution, the
 * id→row maps cards are built from, and CoS discovery for "best fit".
 */

export const refInput = (what: string) =>
  z.string().min(1).max(500).describe(`${what} — identifier, title fragment, UUID or deep link`);

export interface RunRow {
  runId: string;
  status: string;
  finishedAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
  resultJson?: { stopReason?: string | null } | null;
  livenessReason?: string | null;
  nextAction?: string | null;
}

export interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export interface WorkProductRow {
  type: string;
  provider: string;
  title: string;
  url?: string | null;
  status: string;
  reviewState?: string | null;
  summary?: string | null;
}

export interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  createdAt?: string;
}

/** Resolve an ambiguous-or-missing reference into an envelope, or hand the row on. */
export async function unresolved(
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
export function durationMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * scale;
}

export async function agentMap(client: PaperclipApiClient, companyId: string): Promise<Map<string, AgentRow>> {
  const rows = await client
    .requestJson<AgentRow[]>("GET", `/companies/${companyId}/agents`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as AgentRow[]);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function projectMap(client: PaperclipApiClient, companyId: string): Promise<Map<string, ProjectRow>> {
  const rows = await client
    .requestJson<ProjectRow[]>("GET", `/companies/${companyId}/projects`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as ProjectRow[]);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * `assigneeUserId` → display name. Tasks can be assigned to a person, and an
 * owner that renders as nothing reads as "unowned". `/people` is the
 * board-scoped member list (no privileged permission) — only names are
 * copied out; emails never reach a card.
 */
export async function userMap(client: PaperclipApiClient, companyId: string): Promise<Map<string, string>> {
  const rows = await client
    .requestJson<{ people?: Array<{ userId?: string; name?: string | null }> }>(
      "GET",
      `/companies/${companyId}/people`,
    )
    .then((res) => (Array.isArray(res?.people) ? res.people : []))
    .catch(() => [] as Array<{ userId?: string; name?: string | null }>);
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.userId && row.name) map.set(row.userId, row.name);
  }
  return map;
}

/**
 * Card for a single task the way the write tools need it — fetch the three
 * lookup maps in one round and hand the row to `itemCard`.
 */
export async function cardFor(
  client: PaperclipApiClient,
  ctx: AssistantContext,
  issue: IssueRow,
): Promise<ItemCard> {
  const [agents, projects, users] = await Promise.all([
    agentMap(client, ctx.companyId),
    projectMap(client, ctx.companyId),
    userMap(client, ctx.companyId),
  ]);
  return itemCard(ctx, issue, { agentById: agents, projectById: projects, userById: users });
}

/**
 * GH #678 ("best fit" → the Chief of Staff, spec §4.2): find the company's
 * CoS agent. A company may run zero or (defensively) several — several is a
 * clarification, zero is a refusal to guess.
 */
export async function resolveBestFit(
  client: PaperclipApiClient,
  companyId: string,
): Promise<Resolution<AgentRow>> {
  const rows = await client
    .requestJson<AgentRow[]>("GET", `/companies/${companyId}/agents`)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => [] as AgentRow[]);
  const candidates = rows.filter(
    (agent) => agent.role === "chief_of_staff" && agent.status !== "terminated" && agent.status !== "retired",
  );
  if (candidates.length === 1) return { kind: "one", value: candidates[0] };
  if (candidates.length === 0) return { kind: "none" };
  return {
    kind: "many",
    candidates: candidates.slice(0, 5).map((agent) => ({ label: agent.name, ref: agent.id })),
  };
}
