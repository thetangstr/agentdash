import { afterEach, describe, expect, it, vi } from 'vitest';
import { companyLockQuery, observeExpectedWaiter } from './observed-lock-wait.js';

const ownerPid = 10;
const stale = { pid: 20, blockers: [ownerPid], query: "SET LOCAL statement_timeout = '8s'" };
const matching = { ...stale, query: 'select id from companies for no key update' };
const pending = new Promise(() => {});
function observe(sample: () => Promise<Record<string, unknown>[]>, contender = pending, expectedWaiterPid?: number) {
  return observeExpectedWaiter({ sample, ownerPid, expectedQuery: companyLockQuery, contender, expectedWaiterPid, timeoutMs: 100, label: 'synthetic contender', pause: async () => { vi.advanceTimersByTime(25); } });
}

describe('lock wait observation', () => {
  afterEach(() => vi.useRealTimers());
  it('waits past stale SET LOCAL even when the owner already blocks the waiter', async () => {
    vi.useFakeTimers();
    const sample = vi.fn().mockResolvedValueOnce([stale]).mockResolvedValue([matching]);
    expect(await observe(sample)).toEqual(matching);
    expect(sample).toHaveBeenCalledTimes(2);
  });
  it('examines all rows instead of accepting an unrelated first waiter', async () => {
    vi.useFakeTimers();
    expect(await observe(async () => [stale, { ...matching, pid: 30 }])).toMatchObject({ pid: 30 });
  });
  it('does not combine owner evidence and query evidence from different rows', async () => {
    vi.useFakeTimers();
    await expect(observe(async () => [stale, { ...matching, pid: 30, blockers: [99] }])).rejects.toThrow(/sampled=.*SET LOCAL.*companies/);
  });
  it('rejects wrong-query-only observations with PID and query diagnostics', async () => {
    vi.useFakeTimers();
    await expect(observe(async () => [stale])).rejects.toThrow(/ownerPid=10; settled=false; sampled=.*20.*SET LOCAL/);
  });
  it('rejects an early-settled contender and preserves the last sample', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const contender = new Promise<void>(resolve => { finish = resolve; });
    const sample = vi.fn(async () => { finish(); return [stale]; });
    await expect(observe(sample, contender)).rejects.toThrow(/settled=true; sampled=.*SET LOCAL/);
    expect(sample).toHaveBeenCalledTimes(1);
  });
  it('does not accept a sample arriving after contender settlement', async () => {
    vi.useFakeTimers();
    await expect(observe(async () => [matching], Promise.resolve())).rejects.toThrow(/settled=true/);
  });
  it('supports intentional blocker-only assertions separately', async () => {
    expect(await observeExpectedWaiter({ sample: async () => [stale], ownerPid, contender: pending, timeoutMs: 100, label: 'blocker only' })).toEqual(stale);
  });
  it('rejects a matching query from a different captured waiter or the owner itself', async () => {
    vi.useFakeTimers();
    await expect(observe(async () => [matching, { ...matching, pid: ownerPid }], pending, 40)).rejects.toThrow(/No observed lock wait/);
  });
});
