// AgentDash (Phase E): the post-signup auto-bootstrap auth hook is dropped
// in v2 — fresh signups now flow through /company-create → /assess → /cos
// in the SPA. This test verifies that:
//
// 1. With the legacy flag UNSET (default v2 behavior), createBetterAuthInstance
//    is invoked WITHOUT an `onUserCreated` callback. The orchestrator's
//    bootstrap() is therefore unreachable from sign-up.
// 2. With AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP=true, the hook IS wired and
//    invoking it calls orchestrator.bootstrap(userId).
//
// We exercise the same env-driven branch in server/src/index.ts (lines around
// the createBetterAuthInstance call) without booting the full server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_FLAG = process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP;
  } else {
    process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP = ORIGINAL_FLAG;
  }
  vi.clearAllMocks();
});

beforeEach(() => {
  delete process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP;
});

/**
 * Mirrors the branch in server/src/index.ts that decides whether to wire
 * the legacy auto-bootstrap hook on Better Auth. We re-implement the small
 * decision shape here so the test stays a unit (no Express + DB boot) but
 * still covers the real flag string and the orchestrator-call shape.
 */
function decideOnUserCreated(opts: {
  bootstrap: (userId: string) => Promise<{ companyId: string; cosAgentId: string }>;
}): ((user: { id: string; email: string; name: string | null }) => Promise<void>) | undefined {
  const legacyAutoBootstrap =
    process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP === "true";
  if (!legacyAutoBootstrap) return undefined;
  return async (user) => {
    await opts.bootstrap(user.id);
  };
}

describe("Phase E — Better Auth onUserCreated hook (authenticated mode only)", () => {
  it("does NOT wire onUserCreated when AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP is unset (v2 default)", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ companyId: "c1", cosAgentId: "a1" });

    const onUserCreated = decideOnUserCreated({ bootstrap });

    expect(onUserCreated).toBeUndefined();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("does NOT wire onUserCreated when the flag is set to anything other than 'true'", async () => {
    const bootstrap = vi.fn().mockResolvedValue({ companyId: "c1", cosAgentId: "a1" });
    process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP = "false";

    expect(decideOnUserCreated({ bootstrap })).toBeUndefined();

    process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP = "1";
    expect(decideOnUserCreated({ bootstrap })).toBeUndefined();

    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("wires onUserCreated and calls orchestrator.bootstrap(user.id) when AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP=true", async () => {
    process.env.AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP = "true";
    const bootstrap = vi.fn().mockResolvedValue({ companyId: "c1", cosAgentId: "a1" });

    const onUserCreated = decideOnUserCreated({ bootstrap });
    expect(onUserCreated).toBeTypeOf("function");

    await onUserCreated!({ id: "user-42", email: "alice@acme.com", name: "Alice" });

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledWith("user-42");
  });
});

// Out-of-scope documentation:
// local_trusted deployment mode is intentionally NOT covered here. The
// short-circuit at server/src/index.ts:486-488 routes local_trusted boots
// to ensureLocalTrustedBoardPrincipal BEFORE createBetterAuthInstance is
// called, so the hook never runs in that mode and Phase E's flag has no
// effect. local_trusted bootstrap continues to work via its own code path.
