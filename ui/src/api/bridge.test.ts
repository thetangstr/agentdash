// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({ api: mockApi }));

const { bridgeApi, BRIDGE_READ } = await import("./bridge");

describe("bridgeApi enrolment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({});
  });

  /**
   * The security-relevant property of this whole surface.
   *
   * `bridge:read` means an agent may ask this machine a question.
   * `bridge:act` means it may change something on it — gated behind a per-task
   * approval, but a far larger grant. Enrolling a laptop so its owner can be
   * reached needs only the first, and nothing in the UI should be able to hand
   * over the second as a side effect of a button labelled "connect".
   */
  it("requests read capability only, never act", async () => {
    await bridgeApi.requestEnrollment("company-1", "My Mac");

    expect(mockApi.post).toHaveBeenCalledWith("/companies/company-1/me/bridge/endpoints", {
      label: "My Mac",
      capabilities: [BRIDGE_READ],
    });
    const sent = mockApi.post.mock.calls[0][1] as { capabilities: string[] };
    expect(sent.capabilities).toEqual(["bridge:read"]);
    expect(sent.capabilities).not.toContain("bridge:act");
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
