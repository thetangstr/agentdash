// AgentDash: agent-instruction-refresh
//
// Refresh stale `<!-- AgentDash: SLUG -->...<!-- /AgentDash: SLUG -->` blocks
// inside an agent's bundled AGENTS.md when the underlying source files
// (server/src/onboarding-assets/default/AGENTS.md) have
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
import { adapterSupportsInstructionsBundle } from "../adapters/instructions-bundle-support.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "./default-agent-instructions.js";
import { logger } from "../middleware/logger.js";

export interface RefreshResult {
  refreshed: boolean;
  blocksUpdated: string[];
  blocksAdded: string[];
  /** Generated blocks present in bundle but no longer in source — now removed. */
  blocksRemoved: string[];
  /** True when the agent had no bundle and the default managed bundle was created. */
  backfilled?: boolean;
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
  /**
   * Optional override for the adapter capability check that gates the
   * no-bundle backfill. Production uses adapterSupportsInstructionsBundle.
   */
  supportsBundle?: (adapterType: string) => boolean;
  /**
   * Optional override for loading the default bundle files for a role.
   * Production uses loadDefaultAgentInstructionsBundle.
   */
  loadDefaultBundle?: (role: string) => Promise<Record<string, string>>;
}

// One archetype for every agent. This used to be "default" | "ceo" |
// "chief_of_staff", but the two persona archetypes were the same inherited
// Paperclip CEO character on top of an identical block set, so they are gone
// (see default-agent-instructions.ts). The union stays a named type because
// the loader plumbing is injectable in tests.
export type SourceArchetype = "default";

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

function archetypeForAgent(_agent: { role: string }): SourceArchetype {
  // One archetype for every role. The `ceo` and `chief_of_staff` archetypes
  // were the same inherited Paperclip persona ("You are the CEO", delegate
  // everything, never do the work) sitting on top of an identical shared block
  // set — this very service had kept the blocks in sync across all three
  // copies, so the only real difference was the persona intro. The product's
  // model is a steward and their agent, not an org chart, so the persona is
  // gone and `default` is the source of truth. Role now carries routing and
  // display meaning only; authority comes from permission grants.
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

  // Generated blocks the source no longer carries are now REMOVED, not just
  // reported.
  //
  // This was audit-only ("leaving them in place"), which meant the generated
  // default could never get smaller in practice: dropping a block from
  // `onboarding-assets/default/AGENTS.md` left it in every existing agent's
  // bundle for ever, so a mandate could only ever grow. Agents ended up
  // carrying pages of connector material for providers this instance has never
  // had a connection to.
  //
  // Removal is scoped to the `AgentDash:` namespace, which is generated content
  // and ours to withdraw. A steward's own prose lives OUTSIDE these markers and
  // is never matched here, agent-specific text between blocks is untouched, and
  // no file other than AGENTS.md is read or written — so this cannot take away
  // anything a human authored.
  const removals: BlockSpan[] = [];
  for (const [slug, bundleSpan] of bundleBlocks) {
    if (sourceBlocks.has(slug)) continue;
    blocksRemoved.push(slug);
    removals.push(bundleSpan);
  }

  // Apply edits highest-startIndex first so earlier offsets stay valid.
  const edits: Array<{ span: BlockSpan; replacement: string }> = [
    ...replacements.map(({ span, replacement }) => ({ span, replacement })),
    ...removals.map((span) => ({ span, replacement: "" })),
  ].sort((a, b) => b.span.startIndex - a.span.startIndex);

  for (const { span, replacement } of edits) {
    next = next.slice(0, span.startIndex) + replacement + next.slice(span.endIndex);
  }

  // A removal leaves the blank lines that surrounded the block. Collapse runs of
  // three or more so a bundle does not accumulate a gap per dropped block.
  if (removals.length > 0) next = next.replace(/\n{3,}/g, "\n\n");

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
  adapterType: string;
  adapterConfig: unknown;
};

export function agentInstructionRefreshService(deps: AgentInstructionRefreshDeps) {
  const { db } = deps;
  const loadSource = deps.loadSource ?? defaultSourceLoader;
  const instructions = deps.instructions ?? agentInstructionsService();
  const supportsBundle = deps.supportsBundle ?? adapterSupportsInstructionsBundle;
  const loadDefaultBundle = deps.loadDefaultBundle
    ?? ((role: string) => loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(role)));

  async function loadAgent(agentId: string): Promise<AgentRow | null> {
    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        role: agentsTable.role,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
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

  /**
   * AgentDash (AGE-8 / GH #554): an agent whose adapter consumes the managed
   * bundle but who has none yet (created before its adapter gained bundling,
   * or bundle config never set) gets the default managed bundle written to
   * disk and its adapterConfig pointed at it. Existing files on disk win
   * (skipExisting), so a partially customized bundle is never overwritten;
   * externally managed bundles are left alone. Returns the entry-file content
   * after backfill, or null when no backfill applies.
   */
  async function backfillDefaultBundle(agent: AgentRow): Promise<string | null> {
    if (!supportsBundle(agent.adapterType)) return null;

    const agentLike = {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      adapterConfig: agent.adapterConfig,
    };
    const existing = await instructions.getBundle(agentLike);
    if (existing.mode === "external") return null;

    const files = await loadDefaultBundle(agent.role);
    const materialized = await instructions.materializeManagedBundle(agentLike, files, {
      entryFile: "AGENTS.md",
      replaceExisting: false,
      skipExisting: true,
    });
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;

    await db
      .update(agentsTable)
      .set({ adapterConfig: nextAdapterConfig, updatedAt: new Date() })
      .where(eq(agentsTable.id, agent.id));
    agent.adapterConfig = nextAdapterConfig;

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "agent-instruction-refresh-service",
      action: "instructions_backfilled",
      entityType: "agent",
      entityId: agent.id,
      details: { adapterType: agent.adapterType, entryFile: "AGENTS.md" },
    });

    return readBundleEntry(agent);
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

    let backfilled = false;
    const done = (result: RefreshResult): RefreshResult =>
      backfilled ? { ...result, refreshed: true, backfilled: true } : result;

    const archetype = archetypeForAgent(agent);
    const [sourceContent, existingBundleContent] = await Promise.all([
      loadSource(archetype),
      readBundleEntry(agent),
    ]);

    let bundleContent = existingBundleContent;
    if (bundleContent === null) {
      // No bundle to refresh. This used to be a silent no-op (GH #554), which
      // is how agents on adapters that gained bundling after their creation
      // ended up running with no managed instructions at all. Backfill the
      // default bundle instead when the adapter supports it and the agent is
      // not on an externally managed bundle.
      bundleContent = await backfillDefaultBundle(agent);
      if (bundleContent === null) return noop;
      backfilled = true;
    }

    // Hot-path optimization: byte-compare source vs bundle. If they're equal
    // there can't be drift. Cheap.
    if (bundleContent === sourceContent) return done(noop);

    const diff = diffAndApply(sourceContent, bundleContent);

    if (diff.blocksRemoved.length > 0) {
      logger.info(
        {
          agentId: agent.id,
          companyId: agent.companyId,
          archetype,
          blocksRemoved: diff.blocksRemoved,
        },
        "agent bundle carried generated blocks no longer present in source; removing them",
      );
    }

    if (
      diff.blocksUpdated.length === 0
      && diff.blocksAdded.length === 0
      && diff.blocksRemoved.length === 0
    ) {
      return done({
        refreshed: false,
        blocksUpdated: [],
        blocksAdded: [],
        blocksRemoved: diff.blocksRemoved,
      });
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

    return done({
      refreshed: true,
      blocksUpdated: diff.blocksUpdated,
      blocksAdded: diff.blocksAdded,
      blocksRemoved: diff.blocksRemoved,
    });
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
