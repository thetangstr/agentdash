import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";

const isProjectVisible = vi.fn(async () => true);
vi.mock("../routes/visibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/visibility.js")>()),
  isProjectVisible: (...args: unknown[]) => (isProjectVisible as (...a: unknown[]) => Promise<boolean>)(...args),
  seesEverything: () => false,
}));

const { createLiveEventVisibility } = await import("../realtime/live-event-visibility.js");

/**
 * AgentDash (GH #708): invalidateActor() while a decision is being computed
 * (here: during the company-projects load) must keep that decision, made from
 * the pre-invalidation actor, out of the cache.
 */
describe("live event visibility: invalidateActor races an in-flight decision", () => {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const event: LiveEvent = {
    id: 1,
    companyId,
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: { entityType: "project", entityId: projectId },
  };

  let onProjectsLoad: (() => void) | null = null;
  const rows = [{ id: projectId, companyId, visibility: "restricted", createdByUserId: null }];
  const fakeDb = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (err: unknown) => unknown) => {
          onProjectsLoad?.();
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return chain;
    },
  };

  function filterFor() {
    const visibility = createLiveEventVisibility(fakeDb as never);
    return visibility.createSubscriberFilter({ companyId, loadActor: async () => ({ type: "board" }) as never });
  }

  beforeEach(() => {
    isProjectVisible.mockClear();
    onProjectsLoad = null;
  });

  it("caches a decision when nothing invalidates (control)", async () => {
    const shouldDeliver = filterFor();
    await shouldDeliver(event);
    await shouldDeliver(event);
    expect(isProjectVisible).toHaveBeenCalledTimes(1);
  });

  it("does not cache a decision made across an invalidation", async () => {
    const shouldDeliver = filterFor();
    onProjectsLoad = () => {
      onProjectsLoad = null;
      shouldDeliver.invalidateActor();
    };
    await shouldDeliver(event);
    await shouldDeliver(event);
    expect(isProjectVisible).toHaveBeenCalledTimes(2);
  });
});
