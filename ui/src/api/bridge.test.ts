// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({ api: mockApi }));

const { bridgeApi, BRIDGE_READ, BRIDGE_INBOX } = await import("./bridge");

describe("bridgeApi enrolment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({});
  });

  /**
   * The security-relevant property of this whole surface.
   *
   * `bridge:act` means an agent may change something on this machine. It is
   * gated behind a per-task approval, but it is a far larger grant than being
   * asked a question, and nothing in the UI should be able to hand it over as
   * a side effect of a button labelled "connect".
   */
  it("never requests act", async () => {
    await bridgeApi.requestEnrollment("company-1", "My Mac");

    const sent = mockApi.post.mock.calls[0][1] as { capabilities: string[] };
    expect(sent.capabilities).not.toContain("bridge:act");
  });

  /**
   * The capability the documented flow cannot work without.
   *
   * This assertion previously read `toEqual(["bridge:read"])`, which is how
   * the defect survived: `stewardInboxService` rejects `/api/bridge/inbox/*`
   * for any endpoint without `bridge:inbox`, so every key this call has ever
   * minted got 403 from the `SessionStart` hook `inbox-init` installs. In
   * production all seven enrolled endpoints are in that state and
   * `steward_inbox_events` has never been read by anything. The test was
   * pinning the broken behaviour in place.
   *
   * This is not a widening. The inbox is the signed-in person's own, and the
   * endpoint is one they enrolled and can revoke.
   */
  it("requests the inbox capability, or the inbox returns 403 forever", async () => {
    await bridgeApi.requestEnrollment("company-1", "My Mac");

    expect(mockApi.post).toHaveBeenCalledWith("/companies/company-1/me/bridge/endpoints", {
      label: "My Mac",
      capabilities: [BRIDGE_READ, BRIDGE_INBOX],
    });
    const sent = mockApi.post.mock.calls[0][1] as { capabilities: string[] };
    expect(sent.capabilities).toContain("bridge:inbox");
    expect(sent.capabilities).toContain("bridge:read");
  });

  it("approves by endpoint id, which is what mints the token", async () => {
    await bridgeApi.approve("company-1", "endpoint-9");

    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/bridge/endpoints/endpoint-9/approve",
      {},
    );
  });

  it("lists only the caller's own endpoints", async () => {
    mockApi.get.mockResolvedValue({ endpoints: [] });

    await bridgeApi.listMyEndpoints("company-1");

    // The `me/` segment is load-bearing: the company-wide endpoint list is a
    // different route with different authorization, and reading it here would
    // show one person every colleague's machines.
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/me/bridge/endpoints");
  });

  it("revokes by endpoint id", async () => {
    await bridgeApi.revoke("company-1", "endpoint-9");

    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/bridge/endpoints/endpoint-9/revoke",
      {},
    );
  });
});
