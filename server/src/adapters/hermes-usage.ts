import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";

/**
 * Token metering for `hermes_local`.
 *
 * The platform already meters everything downstream of the adapter: an adapter
 * returns `usage`, the heartbeat writes it to `heartbeat_runs.usage_json`, and
 * `/costs/by-agent` and friends aggregate input/cached/output tokens per agent,
 * model, provider and biller. codex_local fills that in and shows up there.
 *
 * hermes_local did not, so the one agent MKThink actually runs contributed
 * nothing: `usage_json` null, and a costs page reading zero while real tokens
 * were being spent. The package tries to scrape totals out of stdout with a
 * regex, and Hermes 0.20 prints no such line — measured on the live instance,
 * a whole successful run whose log never says the word "token".
 *
 * Hermes will report it directly if asked: `--usage-file PATH` writes a JSON
 * report after the run, "even when the run fails, so pipelines can always
 * account for" it. That is the number, from the process that spent it, rather
 * than a guess parsed out of prose.
 */

/** The subset of Hermes' usage report this adapter trusts. */
export interface HermesUsageReport {
  usage: UsageSummary;
  model: string | null;
  provider: string | null;
  /** Only set when Hermes itself claims to know the cost. */
  costUsd: number | null;
  apiCalls: number | null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A cost Hermes describes as unknown is not a cost of zero.
 *
 * The MiniMax runs on the MKThink Mini come back with
 * `estimated_cost_usd: 0.0, cost_status: "unknown", cost_source: "none"` —
 * Hermes knows the token counts and not the price list. Copying that 0 into a
 * cost event would put "$0.00 spent" on a board where money is in fact being
 * spent, which is worse than an empty cost column: one is a gap, the other is
 * a false statement. Tokens are recorded either way.
 */
function readTrustedCostUsd(raw: Record<string, unknown>): number | null {
  const status = readString(raw.cost_status)?.toLowerCase();
  const source = readString(raw.cost_source)?.toLowerCase();
  if (!status || status === "unknown") return null;
  if (!source || source === "none") return null;
  const cost = readNumber(raw.estimated_cost_usd);
  return cost && cost > 0 ? cost : null;
}

/**
 * Map a Hermes usage report onto the platform's `UsageSummary`.
 *
 * Returns null when the file holds nothing countable, so a run with no report
 * is left exactly as the adapter returned it rather than being stamped with
 * zeros that would read as "this run cost nothing".
 */
export function parseHermesUsageReport(raw: unknown): HermesUsageReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const report = raw as Record<string, unknown>;

  const inputTokens = readNumber(report.input_tokens);
  const outputTokens = readNumber(report.output_tokens);
  const cachedInputTokens = readNumber(report.cache_read_tokens);
  if (inputTokens === null && outputTokens === null) return null;

  const usage: UsageSummary = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };

  return {
    usage,
    model: readString(report.model),
    provider: readString(report.provider),
    costUsd: readTrustedCostUsd(report),
    apiCalls: readNumber(report.api_calls),
  };
}

/**
 * Merge the report into the adapter's result without overwriting what the
 * adapter already established.
 *
 * The adapter knows things the report does not — which profile ran, how the
 * provider was resolved, the model label a human configured — so a report that
 * merely repeats them must not clobber them. It contributes what only it has:
 * the counts.
 */
export function applyHermesUsageReport(
  result: AdapterExecutionResult,
  report: HermesUsageReport | null,
): AdapterExecutionResult {
  if (!report) return result;
  return {
    ...result,
    usage: result.usage ?? report.usage,
    ...(result.model ? {} : report.model ? { model: report.model } : {}),
    ...(result.provider ? {} : report.provider ? { provider: report.provider } : {}),
    ...(result.costUsd === undefined || result.costUsd === null
      ? report.costUsd !== null
        ? { costUsd: report.costUsd }
        : {}
      : {}),
  };
}

/**
 * Add `--usage-file` to the Hermes invocation.
 *
 * `extraArgs` is the package's own escape hatch and is appended last, after
 * every flag it builds. Anything an operator already put there is preserved:
 * this appends, and it does not add a second `--usage-file` if one is already
 * configured, because Hermes takes the last one and an operator who pinned a
 * path meant it.
 */
export function withUsageFileArg(
  config: Record<string, unknown>,
  usageFilePath: string,
): Record<string, unknown> {
  const existing = Array.isArray(config.extraArgs)
    ? config.extraArgs.filter((value): value is string => typeof value === "string")
    : [];
  if (existing.includes("--usage-file")) return config;
  return { ...config, extraArgs: [...existing, "--usage-file", usageFilePath] };
}
