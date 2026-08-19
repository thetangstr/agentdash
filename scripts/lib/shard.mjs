/**
 * Deterministic work splitting for `run-vitest-stable.mjs`.
 *
 * The runner starts one Vitest process per non-server project, one for the
 * server bulk, and one per serialized route suite — 93 processes on the current
 * tree, 76 of them a single file at a time. That serialization is deliberate:
 * those suites share ports and database state, and the runner's own comments
 * record what happened when they did not.
 *
 * What does not have to stay is doing all of it on one machine. The units are
 * independent of one another, so CI can spread them across parallel jobs and
 * pay the slowest shard instead of the sum.
 *
 * Lives in its own module so it can be tested without importing the runner,
 * which executes the whole suite on import.
 */

/** Read shard settings from the environment. `SHARD_INDEX` is 1-based. */
export function resolveShardConfig(env = process.env) {
  const count = Math.max(1, Number.parseInt(env.SHARD_COUNT ?? "1", 10) || 1);
  const rawIndex = Number.parseInt(env.SHARD_INDEX ?? "1", 10) || 1;
  return { count, index: Math.min(Math.max(1, rawIndex), count) };
}

/**
 * Deal units round-robin over their existing order.
 *
 * Deterministic on purpose: the same commit must produce the same split on
 * every shard. A non-deterministic split can run a suite twice, or run it
 * nowhere — and running it nowhere looks exactly like passing.
 */
export function selectShard(units, { index = 1, count = 1 } = {}) {
  if (count <= 1) return [...units];
  return units.filter((_unit, position) => position % count === index - 1);
}

/**
 * Every unit exactly once across every shard, none duplicated.
 *
 * Exported so the test can state the property rather than a handful of
 * examples.
 */
export function shardsCoverEverything(units, count) {
  const seen = [];
  for (let index = 1; index <= count; index += 1) {
    seen.push(...selectShard(units, { index, count }));
  }
  return seen.length === units.length && new Set(seen).size === new Set(units).size;
}
