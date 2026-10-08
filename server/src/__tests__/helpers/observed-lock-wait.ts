export type LockWaitRow = Record<string, unknown>;
export const companyLockQuery = /companies.*for (?:no key )?update/i;

// pg_stat_activity can briefly expose the preceding SET LOCAL while the blocker
// relation already exists. Require both pieces of evidence on the same row.
export async function observeExpectedWaiter(options: {
  sample: () => Promise<readonly LockWaitRow[]>;
  ownerPid: number;
  expectedQuery?: RegExp;
  expectedWaiterPid?: number;
  contender: Promise<unknown>;
  timeoutMs: number;
  label: string;
  pause?: () => Promise<void>;
}) {
  const deadline = Date.now() + options.timeoutMs;
  const sampled = new Map<string, LockWaitRow>();
  let settled = false;
  void options.contender.then(() => { settled = true; }, () => { settled = true; });
  const pause = options.pause ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  while (!settled && Date.now() < deadline) {
    const rows = await options.sample();
    for (const row of rows) {
      sampled.set(JSON.stringify(row), row);
      const pid = Number(row.pid);
      if (pid === options.ownerPid || (options.expectedWaiterPid !== undefined && pid !== options.expectedWaiterPid)) continue;
      if (!Array.isArray(row.blockers) || !row.blockers.some(pid => Number(pid) === options.ownerPid)) continue;
      if (settled || Date.now() >= deadline) continue;
      if (options.expectedQuery && !options.expectedQuery.test(String(row.query))) continue;
      return row;
    }
    if (!settled) await pause();
  }
  throw new Error(`No observed lock wait: ${options.label}; ownerPid=${options.ownerPid}; settled=${settled}; sampled=${JSON.stringify([...sampled.values()])}`);
}
