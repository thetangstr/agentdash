import type { Request } from "express";
import { and, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issues } from "@paperclipai/db";
import type { AnyBatchKind } from "./kinds.js";

/**
 * AgentDash admin powers (part 5): the records an assistant-prepared batch
 * names, resolved on the server, never by the model. The rules are those of
 * the assistant toolset (packages/mcp-server/src/assistant/resolve.ts): an
 * issue identifier, a UUID or a pasted link is direct; anything else is a
 * search where exact matches win; finding nobody or several is an answer
 * (`not_found` / `needs_clarification` with at most five candidates), never a
 * guess. Candidates are only records the person can see: each pool goes
 * through the kind's own `load`, the same visibility the batch applies.
 */

export interface AssistantTargetProblem {
  ref: string;
  kind: "not_found" | "needs_clarification";
  candidates: Array<{ label: string; ref: string }>;
}

export type AssistantTargetResolution =
  | { ok: true; ids: string[] }
  | { ok: false; problems: AssistantTargetProblem[] };

const IDENTIFIER_PATTERN = /^[A-Za-z]+-\d+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refFromMaybeLink(ref: string, segment: string): string {
  const trimmed = ref.trim();
  const match = trimmed.match(new RegExp(`/${segment}/([^/?#\\s]+)`));
  return match ? match[1]! : trimmed;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type Row = { id: string; exact: boolean };

async function issueCandidates(db: Db, companyId: string, rawRef: string): Promise<Row[]> {
  const ref = refFromMaybeLink(rawRef, "issues");
  if (UUID_PATTERN.test(ref)) {
    const rows = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, ref), isNull(issues.hiddenAt)));
    return rows.map((row) => ({ id: row.id, exact: true }));
  }
  if (IDENTIFIER_PATTERN.test(ref)) {
    const rows = await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), sql`upper(${issues.identifier}) = ${ref.toUpperCase()}`, isNull(issues.hiddenAt)));
    if (rows.length > 0) return rows.map((row) => ({ id: row.id, exact: true }));
  }
  const pattern = `%${escapeLike(ref)}%`;
  const rows = await db
    .select({ id: issues.id, title: issues.title, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      isNull(issues.hiddenAt),
      or(ilike(issues.title, pattern), ilike(issues.identifier, pattern)),
    ))
    .limit(50);
  const needle = norm(ref);
  return rows.map((row) => ({ id: row.id, exact: norm(row.title) === needle || norm(row.identifier) === needle }));
}

async function agentCandidates(db: Db, companyId: string, rawRef: string): Promise<Row[]> {
  const ref = refFromMaybeLink(rawRef, "agents");
  const rows = await db
    .select({ id: agents.id, name: agents.name, title: agents.title, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
  const needle = norm(ref);
  const out: Row[] = [];
  for (const agent of rows) {
    const exact = norm(agent.name) === needle || norm(agent.title) === needle || agent.id === ref;
    const fuzzy = norm(agent.name).includes(needle) || norm(agent.title).includes(needle) || norm(agent.role) === needle;
    if (exact || fuzzy) out.push({ id: agent.id, exact });
  }
  return out;
}

async function approvalCandidates(db: Db, companyId: string, rawRef: string): Promise<Row[]> {
  const ref = refFromMaybeLink(rawRef, "approvals");
  if (!UUID_PATTERN.test(ref)) return [];
  const rows = await db.select({ id: approvals.id }).from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.id, ref)));
  return rows.map((row) => ({ id: row.id, exact: true }));
}

export async function resolveAssistantTargets(
  db: Db,
  req: Request,
  companyId: string,
  kind: AnyBatchKind,
  change: unknown,
  refs: readonly string[],
): Promise<AssistantTargetResolution> {
  const find = kind.entityType === "issue" ? issueCandidates
    : kind.entityType === "agent" ? agentCandidates
      : kind.entityType === "approval" ? approvalCandidates
        : null;
  if (!find) return { ok: false, problems: refs.map((ref) => ({ ref, kind: "not_found", candidates: [] })) };

  const ids: string[] = [];
  const problems: AssistantTargetProblem[] = [];
  for (const ref of [...new Set(refs.map((value) => value.trim()))]) {
    const rows = await find(db, companyId, ref);
    // Only what this person can see takes part, so a hidden record is never
    // a candidate and never makes a reference look ambiguous.
    const visible = rows.length === 0 ? new Map() : await kind.load({ db, req, companyId }, [...new Set(rows.map((row) => row.id))], change);
    const seen = rows.filter((row) => visible.has(row.id));
    const exact = seen.filter((row) => row.exact);
    const pool = exact.length > 0 ? exact : seen;
    const unique = [...new Set(pool.map((row) => row.id))];
    if (unique.length === 1) {
      ids.push(unique[0]!);
    } else if (unique.length === 0) {
      problems.push({ ref, kind: "not_found", candidates: [] });
    } else {
      problems.push({
        ref,
        kind: "needs_clarification",
        candidates: unique.slice(0, 5).map((id) => ({ label: visible.get(id)!.label, ref: id })),
      });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, ids: [...new Set(ids)] };
}

/** Plain text for one record's change: "status: todo → done; assignee: none → Casper". */
export function describeChangeAsText(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const show = (value: unknown) => (value === null || value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value));
  return keys.map((key) => `${key}: ${show(before[key])} → ${show(after[key])}`).join("; ");
}

