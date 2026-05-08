// AgentDash: agent-instruction-refresh
//
// Refresh stale `<!-- AgentDash: SLUG -->...<!-- /AgentDash: SLUG -->` blocks
// inside an agent's bundled AGENTS.md when the underlying source files
// (server/src/onboarding-assets/{default,ceo,chief_of_staff}/AGENTS.md) have
// drifted from what was baked into the agent's instructions bundle at create
// time.
//
// Why named-block scope (and NOT whole-file replacement):
//   1. Proposal-created agents have role-specific content interpolated into
//      their AGENTS.md (`${p.name}`, `${p.role}`, `${p.oneLineOkr}` —
//      see agent-creator-from-proposal.ts `renderAgents`). We must preserve
//      that.
//   2. Upstream Paperclip prose outside the AgentDash blocks is not ours to
//      touch.
//   3. Each `<!-- AgentDash: X -->` block is the cleanest invariant: it must
//      equal the current source.
//
// Cache strategy: the source files (default/ceo/chief_of_staff AGENTS.md) are
// read-once-per-process. Cache invalidation = process restart, which is what
// every deploy already does. Hot-path byte-compare against the cached source
// avoids regex parsing on every heartbeat tick.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import { logActivity } from "./activity-log.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { logger } from "../middleware/logger.js";

export interface RefreshResult {
  refreshed: boolean;
  blocksUpdated: string[];
  blocksAdded: string[];
  /** Blocks present in bundle but no longer in source — left alone, audit-only. */
  blocksRemoved: string[];
}

export interface AgentInstructionRefreshDeps {
  db: Db;
  /**
   * Optional override for reading source AGENTS.md files. Tests inject their
   * own; production uses {@link defaultSourceLoader}.
   */
  loadSource?: (archetype: SourceArchetype) => Promise<string>;
  /**
   * Optional override for the instructions service. Tests inject a stub that
   * returns the bundle bytes from memory; production uses
   * agentInstructionsService().
   */
  instructions?: ReturnType<typeof agentInstructionsService>;
}

export type SourceArchetype = "default" | "ceo" | "chief_of_staff";

interface BlockSpan {
  slug: string;
  /** Start index of the opening `<!-- AgentDash:` comment. */
  startIndex: number;
  /** End index (exclusive) of the closing `<!-- /AgentDash: ... -->` comment. */
  endIndex: number;
  /** Full matched text (open marker + body + close marker). */
  fullText: string;
}

/**
 * Regex for `<!-- AgentDash: SLUG (any trailing prose) -->BODY<!-- /AgentDash: SLUG -->`.
 *
 * Captures:
 *   1: slug
 *   2: body between markers
 *
 * The closing marker uses a back-reference to the captured slug to pair the
 * right open/close.
 */
const BLOCK_REGEX = /<!--\s*AgentDash:\s*([\w-]+)[^]*?-->([\s\S]*?)<!--\s*\/AgentDash:\s*\1\s*-->/g;

function parseBlocks(content: string): Map<string, BlockSpan> {
  const out = new Map<string, BlockSpan>();
  // Reset lastIndex on the shared regex (it's stateful with /g).
  BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_REGEX.exec(content)) !== null) {
    const slug = match[1]!;
    out.set(slug, {
      slug,
      startIndex: match.index,
      endIndex: match.index + match[0]!.length,
      fullText: match[0]!,
    });
  }
  return out;
}

function bodyEqual(a: BlockSpan, b: BlockSpan): boolean {
  // Compare the WHOLE marker+body region — if the source rewrites only the
  // marker (e.g. trailing prose after the slug), we still want to refresh.
  return a.fullText.trim() === b.fullText.trim();
}

// ---------------------------------------------------------------------------
// Source-file cache. Read once per process, then keep in memory. Cache
// invalidation is "restart the process" — fine because deploys restart.
// ---------------------------------------------------------------------------

const sourceCache = new Map<SourceArchetype, string>();

function resolveSourcePath(archetype: SourceArchetype): string {
  // Use import.meta.url so the path resolves correctly whether running from
  // src/ (vitest) or dist/ (production).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "onboarding-assets", archetype, "AGENTS.md");
}

async function defaultSourceLoader(archetype: SourceArchetype): Promise<string> {
  const cached = sourceCache.get(archetype);
  if (cached !== undefined) return cached;
  const filePath = resolveSourcePath(archetype);
  const content = await fs.readFile(filePath, "utf8");
  sourceCache.set(archetype, content);
  return content;
}

/** Test-only: reset the in-process source cache. */
export function __resetAgentInstructionRefreshCache(): void {
  sourceCache.clear();
}

// ---------------------------------------------------------------------------
// Archetype resolution
// ---------------------------------------------------------------------------

function archetypeForAgent(agent: { role: string }): SourceArchetype {
  if (agent.role === "ceo") return "ceo";
  if (agent.role === "chief_of_staff") return "chief_of_staff";
  return "default";
}

// ---------------------------------------------------------------------------
// Block diff + apply
// ---------------------------------------------------------------------------

interface DiffResult {
  blocksUpdated: string[];
  blocksAdded: string[];
  blocksRemoved: string[];
  nextContent: string;
}

function diffAndApply(sourceContent: string, bundleContent: string): DiffResult {
  const sourceBlocks = parseBlocks(sourceContent);
  const bundleBlocks = parseBlocks(bundleContent);

  const blocksUpdated: string[] = [];
  const blocksAdded: string[] = [];
  const blocksRemoved: string[] = [];

  // Build the next bundle content by replacing matching blocks in place
  // (highest-index-first, so earlier indices stay valid) and appending new
  // blocks at the end.
  let next = bundleContent;
  const replacements: Array<{ slug: string; span: BlockSpan; replacement: string }> = [];

  for (const [slug, sourceSpan] of sourceBlocks) {
    const bundleSpan = bundleBlocks.get(slug);
    if (!bundleSpan) {
      blocksAdded.push(slug);
      continue;
    }
    if (!bodyEqual(sourceSpan, bundleSpan)) {
      blocksUpdated.push(slug);
      replacements.push({ slug, span: bundleSpan, replacement: sourceSpan.fullText });
    }
  }

  for (const slug of bundleBlocks.keys()) {
    if (!sourceBlocks.has(slug)) blocksRemoved.push(slug);
  }

  // Apply replacements highest-startIndex first to keep earlier offsets valid.
  replacements.sort((a, b) => b.span.startIndex - a.span.startIndex);
  for (const { span, replacement } of replacements) {
    next = next.slice(0, span.startIndex) + replacement + next.slice(span.endIndex);
  }

  // Append new blocks at the end (current sources put AgentDash blocks at
  // the tail; appending matches that convention).
  for (const slug of blocksAdded) {
    const sourceSpan = sourceBlocks.get(slug)!;
    if (!next.endsWith("\n")) next += "\n";
    next += `\n${sourceSpan.fullText}\n`;
  }

  return { blocksUpdated, blocksAdded, blocksRemoved, nextContent: next };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type AgentRow = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: string;
  adapterConfig: unknown;
};

export function agentInstructionRefreshService(deps: AgentInstructionRefreshDeps) {
  const { db } = deps;
  const loadSource = deps.loadSource ?? defaultSourceLoader;
  const instructions = deps.instructions ?? agentInstructionsService();

  async function loadAgent(agentId: string): Promise<AgentRow | null> {
    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        role: agentsTable.role,
        status: agentsTable.status,
        adapterConfig: agentsTable.adapterConfig,
      })
      .from(agentsTable)
      .where(eq(agentsTable.id, agentId))
      .limit(1);
    return (rows[0] as AgentRow | undefined) ?? null;
  }

  async function readBundleEntry(agent: AgentRow): Promise<string | null> {
    try {
      const file = await instructions.readFile(
        { id: agent.id, companyId: agent.companyId, name: agent.name, adapterConfig: agent.adapterConfig },
        "AGENTS.md",
      );
      return typeof file?.content === "string" ? file.content : null;
    } catch {
      return null;
    }
  }

  async function writeBundleEntry(agent: AgentRow, content: string): Promise<void> {
    await instructions.writeFile(
      { id: agent.id, companyId: agent.companyId, name: agent.name, adapterConfig: agent.adapterConfig },
      "AGENTS.md",
      content,
    );
  }

  async function refreshIfStale(agentId: string): Promise<RefreshResult> {
    const noop: RefreshResult = { refreshed: false, blocksUpdated: [], blocksAdded: [], blocksRemoved: [] };

    const agent = await loadAgent(agentId);
    if (!agent) return noop;

    const archetype = archetypeForAgent(agent);
    const [sourceContent, bundleContent] = await Promise.all([
      loadSource(archetype),
      readBundleEntry(agent),
    ]);

    if (bundleContent === null) {
      // No bundle to refresh — nothing to do (could be an external bundle on a
      // path we don't write; create-time bundling sets this up, so this is
      // unusual but not an error).
      return noop;
    }

    // Hot-path optimization: byte-compare source vs bundle. If they're equal
    // there can't be drift. Cheap.
    if (bundleContent === sourceContent) return noop;

    const diff = diffAndApply(sourceContent, bundleContent);

    // Warn (don't act) on bundle blocks that the source no longer carries.
    if (diff.blocksRemoved.length > 0) {
      logger.warn(
        {
          agentId: agent.id,
          companyId: agent.companyId,
          archetype,
          blocksRemoved: diff.blocksRemoved,
        },
        "agent bundle has AgentDash blocks no longer present in source; leaving them in place",
      );
    }

    if (diff.blocksUpdated.length === 0 && diff.blocksAdded.length === 0) {
      return {
        refreshed: false,
        blocksUpdated: [],
        blocksAdded: [],
        blocksRemoved: diff.blocksRemoved,
      };
    }

    await writeBundleEntry(agent, diff.nextContent);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "agent-instruction-refresh-service",
      action: "instructions_refreshed",
      entityType: "agent",
      entityId: agent.id,
      details: {
        archetype,
        blocksUpdated: diff.blocksUpdated,
        blocksAdded: diff.blocksAdded,
        blocksRemoved: diff.blocksRemoved,
      },
    });

    return {
      refreshed: true,
      blocksUpdated: diff.blocksUpdated,
      blocksAdded: diff.blocksAdded,
      blocksRemoved: diff.blocksRemoved,
    };
  }

  async function refreshAllForCompany(companyId: string): Promise<Record<string, RefreshResult>> {
    const rows = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.companyId, companyId),
          ne(agentsTable.status, "terminated"),
        ),
      );

    const results: Record<string, RefreshResult> = {};
    for (const row of rows as Array<{ id: string }>) {
      try {
        results[row.id] = await refreshIfStale(row.id);
      } catch (err) {
        logger.error(
          { agentId: row.id, companyId, err },
          "agent instruction refresh failed",
        );
        results[row.id] = {
          refreshed: false,
          blocksUpdated: [],
          blocksAdded: [],
          blocksRemoved: [],
        };
      }
    }
    return results;
  }

  return {
    refreshIfStale,
    refreshAllForCompany,
  };
}
