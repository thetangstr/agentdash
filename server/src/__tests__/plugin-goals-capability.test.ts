import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";

/**
 * Gate 5 asked for capability enforcement on `goals.create` / `goals.update`
 * at plugin dispatch. Reading the code, it is already there:
 * `createHostClientHandlers` wraps every handler in `gated(method, ...)`, and
 * `METHOD_CAPABILITY_MAP` maps both write methods to their capabilities.
 *
 * What was missing is this file. Nothing anywhere asserted it, so "enforced"
 * rested on a reading of the source rather than on a run — and the gate's own
 * rule is that a criterion which cannot be checked by running something is not
 * a criterion. Deleting the `gated()` wrapper from either goals write handler
 * used to break no test at all.
 *
 * The service layer is stubbed on purpose. What is under test is whether the
 * host REACHES it, not what it then does. A stub that records calls makes
 * "refused" and "allowed but a no-op" distinguishable, which asserting on the
 * thrown error alone would not.
 */

function makeServices() {
  const goals = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "goal-1", title: "Ship the thing" })),
    update: vi.fn(async () => ({ id: "goal-1", title: "Ship the thing" })),
  };
  // Only the goals namespace is exercised; the rest of HostServices is not
  // reached by these calls, so a cast keeps the fixture honest about its scope
  // rather than pretending to implement the whole surface.
  return { goals, services: { goals } as never };
}

function handlersFor(capabilities: string[]) {
  const { goals, services } = makeServices();
  const handlers = createHostClientHandlers({
    pluginId: "probe-plugin",
    capabilities: capabilities as never,
    services,
  });
  return { goals, handlers };
}

const CREATE_PARAMS = { companyId: "company-1", title: "Ship the thing" } as never;
const UPDATE_PARAMS = { companyId: "company-1", goalId: "goal-1", patch: { title: "x" } } as never;

describe("plugin host: goals writes are capability-gated", () => {
  it("refuses goals.create when the manifest does not declare it", async () => {
    // `goals.read` deliberately IS declared. A plugin that can read goals but
    // was never granted write is the case that matters — refusing a plugin
    // with no capabilities at all would prove much less.
    const { goals, handlers } = handlersFor(["goals.read"]);

    await expect(handlers["goals.create"](CREATE_PARAMS)).rejects.toThrow(
      /missing required capability "goals.create"/,
    );
    expect(goals.create, "the refusal must happen before the service is reached")
      .not.toHaveBeenCalled();
  });

  it("refuses goals.update when the manifest does not declare it", async () => {
    const { goals, handlers } = handlersFor(["goals.read", "goals.create"]);

    // Declaring create must not carry update with it.
    await expect(handlers["goals.update"](UPDATE_PARAMS)).rejects.toThrow(
      /missing required capability "goals.update"/,
    );
    expect(goals.update).not.toHaveBeenCalled();
  });

  it("allows goals.create when the manifest declares it", async () => {
    // The control case. Without it, a host that refused every goals write
    // would satisfy both assertions above.
    const { goals, handlers } = handlersFor(["goals.read", "goals.create"]);

    await expect(handlers["goals.create"](CREATE_PARAMS)).resolves.toBeTruthy();
    expect(goals.create).toHaveBeenCalledTimes(1);
  });

  it("allows goals.update when the manifest declares it", async () => {
    const { goals, handlers } = handlersFor(["goals.read", "goals.update"]);

    await expect(handlers["goals.update"](UPDATE_PARAMS)).resolves.toBeTruthy();
    expect(goals.update).toHaveBeenCalledTimes(1);
  });

  it("still allows reads to a plugin that cannot write", async () => {
    // Read and write are separate capabilities, and the read path must not
    // have been broken by the write gate.
    const { goals, handlers } = handlersFor(["goals.read"]);

    await expect(handlers["goals.list"]({ companyId: "company-1" } as never)).resolves.toBeDefined();
    expect(goals.list).toHaveBeenCalledTimes(1);
  });

  it("refuses reads too when the manifest declares no goals capability", async () => {
    const { goals, handlers } = handlersFor([]);

    await expect(handlers["goals.list"]({ companyId: "company-1" } as never)).rejects.toThrow(
      /missing required capability "goals.read"/,
    );
    expect(goals.list).not.toHaveBeenCalled();
  });
});
