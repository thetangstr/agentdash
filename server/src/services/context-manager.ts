/**
 * AgentDash: Platform-level context management service.
 *
 * Sits between the heartbeat orchestrator and adapters to ensure all agents
 * (regardless of adapter type) get properly sized, fresh, non-stale context.
 *
 * Inspired by Claude Code's context management patterns:
 *  - Token budget allocation across prompt sections
 *  - Staleness detection for context data
 *  - Session handoff summary generation on rotation
 *  - Platform-level compaction for adapters without native context management
 *
 * Adapters with native context management (claude_local, codex_local) bypass
 * platform truncation — they handle their own context window internally.
 */
import type { Db } from "@agentdash/db";
import {
  type AdapterContextBudget,
  type PromptSectionBudget,
  getAdapterContextBudget,
  getPromptTokenBudget,
  DEFAULT_PROMPT_SECTION_BUDGETS,
} from "@agentdash/adapter-utils/session-compaction";

// ── Constants ───────────────────────────────────────────────────────────

/** Rough chars-per-token ratio for token estimation (conservative) */
const CHARS_PER_TOKEN = 3.5;

/** Maximum age (hours) before context data gets a staleness warning */
const CONTEXT_STALE_HOURS = 24;

/** Maximum age (hours) before context data is considered expired */
const CONTEXT_EXPIRED_HOURS = 72;

/** Maximum handoff summary tokens */
const MAX_HANDOFF_SUMMARY_TOKENS = 2000;

// ── Types ───────────────────────────────────────────────────────────────

export interface PromptSection {
  name: string;
  content: string;
  /** Timestamp when this section's data was last refreshed */
  dataFreshnessMs?: number;
}

export interface ContextBudgetAllocation {
  section: string;
  originalTokens: number;
  allocatedTokens: number;
  truncated: boolean;
  stale: boolean;
}

export interface ManagedPromptResult {
  /** The assembled prompt sections (may be truncated) */
  sections: PromptSection[];
  /** Token budget allocation report */
  allocations: ContextBudgetAllocation[];
  /** Total estimated tokens used */
  totalTokens: number;
  /** Available budget (0 if adapter manages its own context) */
  budgetTokens: number;
  /** Whether platform-level truncation was applied */
  platformManaged: boolean;
  /** Staleness warnings for the agent */
  stalenessWarnings: string[];
}

export interface SessionHandoffSummary {
  /** Compact markdown summary of the session */
  markdown: string;
  /** Estimated token count of the summary */
  estimatedTokens: number;
  /** When the session started */
  sessionStartedAt: string;
  /** Number of runs in the session */
  runCount: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  // Truncate at last newline before the limit to avoid mid-line cuts
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return truncated.slice(0, cutPoint) + "\n\n[...truncated by AgentDash context manager]";
}

function isStale(freshnessMs: number | undefined): boolean {
  if (!freshnessMs) return false;
  const ageHours = (Date.now() - freshnessMs) / (1000 * 60 * 60);
  return ageHours > CONTEXT_STALE_HOURS;
}

function isExpired(freshnessMs: number | undefined): boolean {
  if (!freshnessMs) return false;
  const ageHours = (Date.now() - freshnessMs) / (1000 * 60 * 60);
  return ageHours > CONTEXT_EXPIRED_HOURS;
}

function ageLabel(freshnessMs: number): string {
  const ageHours = (Date.now() - freshnessMs) / (1000 * 60 * 60);
  if (ageHours < 1) return "just now";
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

// ── Service ─────────────────────────────────────────────────────────────

export function contextManagerService(_db: Db) {
  /**
   * Apply token budget allocation to prompt sections.
   *
   * For adapters with native context management, returns sections unchanged.
   * For platform-managed adapters, allocates tokens by priority and truncates
   * lower-priority sections first.
   */
  function applyContextBudget(
    adapterType: string | null | undefined,
    sections: PromptSection[],
    sectionBudgets: PromptSectionBudget[] = DEFAULT_PROMPT_SECTION_BUDGETS,
  ): ManagedPromptResult {
    const budget = getAdapterContextBudget(adapterType);
    const totalBudget = getPromptTokenBudget(adapterType);
    const stalenessWarnings: string[] = [];

    // Check staleness on all sections regardless of adapter
    for (const section of sections) {
      if (section.dataFreshnessMs && isStale(section.dataFreshnessMs)) {
        const age = ageLabel(section.dataFreshnessMs);
        if (isExpired(section.dataFreshnessMs)) {
          stalenessWarnings.push(
            `⚠ ${section.name}: data is ${age} old and may be expired. Consider refreshing.`,
          );
        } else {
          stalenessWarnings.push(
            `${section.name}: data is ${age} old. Verify against current state.`,
          );
        }
      }
    }

    // If adapter manages its own context, return sections unchanged
    if (!budget?.platformManagedTruncation || totalBudget <= 0) {
      const allocations = sections.map((s) => ({
        section: s.name,
        originalTokens: estimateTokens(s.content),
        allocatedTokens: estimateTokens(s.content),
        truncated: false,
        stale: s.dataFreshnessMs ? isStale(s.dataFreshnessMs) : false,
      }));
      return {
        sections,
        allocations,
        totalTokens: allocations.reduce((sum, a) => sum + a.allocatedTokens, 0),
        budgetTokens: 0,
        platformManaged: false,
        stalenessWarnings,
      };
    }

    // Platform-managed: allocate tokens by priority
    const allocations: ContextBudgetAllocation[] = [];
    const resultSections: PromptSection[] = [];

    // Build a map of section budgets by name
    const budgetMap = new Map(sectionBudgets.map((b) => [b.section, b]));

    // Calculate current token usage per section
    const sectionTokens = sections.map((s) => ({
      section: s,
      tokens: estimateTokens(s.content),
      budgetConfig: budgetMap.get(s.name),
    }));

    const totalCurrentTokens = sectionTokens.reduce((sum, s) => sum + s.tokens, 0);

    if (totalCurrentTokens <= totalBudget) {
      // Under budget — no truncation needed
      for (const { section, tokens } of sectionTokens) {
        allocations.push({
          section: section.name,
          originalTokens: tokens,
          allocatedTokens: tokens,
          truncated: false,
          stale: section.dataFreshnessMs ? isStale(section.dataFreshnessMs) : false,
        });
        resultSections.push(section);
      }
    } else {
      // Over budget — truncate by priority (lowest priority first)
      let tokensToShed = totalCurrentTokens - totalBudget;

      // Sort by priority descending (lowest priority = truncate first)
      const sortedByPriority = [...sectionTokens].sort(
        (a, b) => (b.budgetConfig?.priority ?? 99) - (a.budgetConfig?.priority ?? 99),
      );

      const truncationMap = new Map<string, number>(); // section name -> allocated tokens

      for (const { section, tokens, budgetConfig } of sortedByPriority) {
        if (tokensToShed <= 0) {
          truncationMap.set(section.name, tokens);
          continue;
        }

        const minTokens = budgetConfig?.minTokens ?? 0;
        const maxShed = Math.max(0, tokens - minTokens);
        const shed = Math.min(maxShed, tokensToShed);
        const allocated = tokens - shed;
        tokensToShed -= shed;

        truncationMap.set(section.name, allocated);
      }

      // Apply truncations in original order
      for (const { section, tokens } of sectionTokens) {
        const allocated = truncationMap.get(section.name) ?? tokens;
        const wasTruncated = allocated < tokens;

        const content = wasTruncated
          ? truncateToTokenBudget(section.content, allocated)
          : section.content;

        allocations.push({
          section: section.name,
          originalTokens: tokens,
          allocatedTokens: allocated,
          truncated: wasTruncated,
          stale: section.dataFreshnessMs ? isStale(section.dataFreshnessMs) : false,
        });

        if (allocated > 0) {
          resultSections.push({ ...section, content });
        }
      }
    }

    return {
      sections: resultSections,
      allocations,
      totalTokens: allocations.reduce((sum, a) => sum + a.allocatedTokens, 0),
      budgetTokens: totalBudget,
      platformManaged: true,
      stalenessWarnings,
    };
  }

  /**
   * Generate a compact session handoff summary.
   *
   * Called when a session is being rotated for a platform-managed adapter.
   * Produces a markdown summary that the next session receives as context.
   */
  function generateHandoffSummary(
    agentName: string,
    issueIdentifier: string | null,
    runSummaries: Array<{ runId: string; prompt: string; result: string; timestamp: string }>,
    sessionStartedAt: string,
  ): SessionHandoffSummary {
    const lines: string[] = [
      "## Session Handoff Summary",
      `Agent: ${agentName}`,
      `Previous session: ${sessionStartedAt}`,
      `Runs in session: ${runSummaries.length}`,
    ];

    if (issueIdentifier) {
      lines.push(`Working on: ${issueIdentifier}`);
    }

    if (runSummaries.length > 0) {
      lines.push("");
      lines.push("### Recent Activity");

      // Include most recent runs, truncate older ones
      const maxRuns = 5;
      const recentRuns = runSummaries.slice(-maxRuns);
      if (runSummaries.length > maxRuns) {
        lines.push(`(${runSummaries.length - maxRuns} earlier runs omitted)`);
      }

      for (const run of recentRuns) {
        const resultSnippet = run.result.length > 200
          ? run.result.slice(0, 200) + "..."
          : run.result;
        lines.push(`- **${run.timestamp}**: ${resultSnippet}`);
      }
    }

    const markdown = truncateToTokenBudget(lines.join("\n"), MAX_HANDOFF_SUMMARY_TOKENS);
    return {
      markdown,
      estimatedTokens: estimateTokens(markdown),
      sessionStartedAt,
      runCount: runSummaries.length,
    };
  }

  /**
   * Check if a session should be rotated based on context health.
   *
   * Extends the existing session compaction policy with context-aware checks:
   * - Accumulated staleness across sections
   * - Token accumulation approaching adapter limits
   */
  function shouldRotateForContextHealth(
    adapterType: string | null | undefined,
    totalInputTokensUsed: number,
  ): { shouldRotate: boolean; reason: string | null } {
    const budget = getAdapterContextBudget(adapterType);
    if (!budget || !budget.platformManagedTruncation) {
      return { shouldRotate: false, reason: null };
    }

    const threshold = budget.maxContextTokens * (budget.compactionThresholdPct / 100);
    if (totalInputTokensUsed > threshold) {
      return {
        shouldRotate: true,
        reason: `Token usage (${totalInputTokensUsed.toLocaleString()}) exceeds ${budget.compactionThresholdPct}% of ${budget.maxContextTokens.toLocaleString()} context window`,
      };
    }

    return { shouldRotate: false, reason: null };
  }

  /**
   * Get a context health report for an adapter's current state.
   */
  function getContextHealthReport(
    adapterType: string | null | undefined,
    totalInputTokensUsed: number,
    sections: PromptSection[],
  ): {
    adapterType: string | null;
    nativeManaged: boolean;
    contextWindowSize: number;
    tokensUsed: number;
    utilizationPct: number;
    staleSections: string[];
    expiredSections: string[];
  } {
    const budget = getAdapterContextBudget(adapterType);
    const contextWindow = budget?.maxContextTokens ?? 0;
    const nativeManaged = !budget?.platformManagedTruncation;

    const staleSections = sections
      .filter((s) => s.dataFreshnessMs && isStale(s.dataFreshnessMs) && !isExpired(s.dataFreshnessMs))
      .map((s) => s.name);

    const expiredSections = sections
      .filter((s) => s.dataFreshnessMs && isExpired(s.dataFreshnessMs))
      .map((s) => s.name);

    return {
      adapterType: adapterType ?? null,
      nativeManaged,
      contextWindowSize: contextWindow,
      tokensUsed: totalInputTokensUsed,
      utilizationPct: contextWindow > 0 ? Math.round((totalInputTokensUsed / contextWindow) * 100) : 0,
      staleSections,
      expiredSections,
    };
  }

  return {
    applyContextBudget,
    generateHandoffSummary,
    shouldRotateForContextHealth,
    getContextHealthReport,
    // Re-export for convenience
    estimateTokens,
  };
}
