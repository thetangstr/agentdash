import { sql, type SQLWrapper } from "drizzle-orm";
import { heartbeatRunEvents } from "@paperclipai/db";

/**
 * Codex reports gross input, including its cached subset. Other adapters can
 * report exclusive input; provider/model and the agent's current adapter are
 * not historical provenance. Keep unknown rows additive rather than guess.
 *
 * New runFacts retain the producing adapter even after event retention. Old
 * rows qualify only when every retained invocation identifies Codex. Retries
 * are aggregated in a scalar subquery so they never multiply token counts.
 */
export function runTokenTotalSql(input: {
  inputTokens: SQLWrapper;
  cachedInputTokens: SQLWrapper;
  outputTokens: SQLWrapper;
  runId: SQLWrapper;
  companyId: SQLWrapper;
  agentId: SQLWrapper;
  runFacts: SQLWrapper;
}) {
  const includesCached = sql`case
    when nullif(${input.runFacts} ->> 'adapterType', '') is not null
      then ${input.runFacts} ->> 'adapterType' = 'codex_local'
    else coalesce((
      select bool_and(coalesce(${heartbeatRunEvents.payload} ->> 'adapterType', '') = 'codex_local')
      from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${input.companyId}
        and ${heartbeatRunEvents.runId} = ${input.runId}
        and ${heartbeatRunEvents.agentId} = ${input.agentId}
        and ${heartbeatRunEvents.eventType} = 'adapter.invoke'
    ), false)
  end`;
  const grossInput = sql`coalesce(${input.inputTokens}, 0)`;
  const cached = sql`coalesce(${input.cachedInputTokens}, 0)`;
  return sql<number>`(
    case when ${includesCached}
      then greatest(${grossInput}, ${cached})
      else ${grossInput} + ${cached}
    end + coalesce(${input.outputTokens}, 0)
  )`;
}
