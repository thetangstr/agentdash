// @vitest-environment jsdom
// AgentDash (scan 3 lane L): stewardship is asked of /me/capabilities first,
// so a workspace without it is not probed for 404s.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCapabilities = vi.hoisted(() => vi.fn());
const mockInbox = vi.hoisted(() => vi.fn());
vi.mock("@/api/capabilities", () => ({ capabilitiesApi: { get: mockCapabilities } }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: { get: mockCapabilities } }));
vi.mock("@/api/stewardships", () => ({
  stewardshipsApi: { getMyInbox: mockInbox, getOverrideInbox: mockInbox, myFactRequests: mockInbox },
}));
vi.mock("../api/stewardships", () => ({
  stewardshipsApi: {
    getMyInbox: mockInbox,
    getOverrideInbox: mockInbox,
    myFactRequests: mockInbox,
  },
}));
vi.mock("../api/connector-send-executions", () => ({ connectorSendExecutionsApi: { listUnresolved: mockInbox } }));
vi.mock("../api/access", () => ({ accessApi: { listJoinRequests: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/inboxDismissals", () => ({ inboxDismissalsApi: { list: vi.fn().mockResolvedValue([]), dismiss: vi.fn() } }));

import { ApiError } from "../api/client";
import { fetchStewardshipOn, useStewardshipCapability } from "./useStewardshipCapability";
import { resetSourceFailureStreaks, useDecisionsOtherSources } from "./useDecisionsSources";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function capabilitiesWith(stewardship: boolean | null | undefined) {
  return {
    companyId: "c1",
    actorType: "board",
    membershipRole: "owner",
    isInstanceAdmin: false,
    capabilities: {},
    ...(stewardship === undefined ? {} : { features: { stewardship } }),
  };
}

function Probe() {
  return <span>{useStewardshipCapability("c1")}</span>;
}

function Sources() {
  const sources = useDecisionsOtherSources("c1", new Set());
  return <span>{sources.total}</span>;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("stewardship answered by /me/capabilities", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    mockCapabilities.mockReset();
    mockInbox.mockReset();
    resetSourceFailureStreaks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await settle();
  }

  it("is off without probing any gated route when the server says so", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(false));
    await render(
      <>
        <Probe />
        <Sources />
      </>,
    );
    expect(container.textContent).toContain("off");
    expect(mockInbox).not.toHaveBeenCalled();
  });

  it("is on without a probe when the server says so", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(true));
    await render(<Probe />);
    expect(container.textContent).toBe("on");
    expect(mockInbox).not.toHaveBeenCalled();
  });

  it("falls back to the probe when the server cannot say", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(null));
    mockInbox.mockRejectedValue(new ApiError("Company not found", 404, null));
    await render(<Probe />);
    expect(container.textContent).toBe("off");
    expect(mockInbox).toHaveBeenCalledTimes(1);
  });

  it("asks an absent source once per session, not once per mount", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(undefined));
    mockInbox.mockRejectedValue(new ApiError("Company not found", 404, null));
    await render(<Sources />);
    const firstRound = mockInbox.mock.calls.length;
    expect(firstRound).toBe(4); // steward inbox, override, fact requests, connector sends
    await render(null);
    await render(<Sources />);
    expect(mockInbox).toHaveBeenCalledTimes(firstRound);
  });

  it("re-asks a 403 source later in the session (a promotion shows without a reload), but not a 404", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(undefined));
    mockInbox.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await render(<Sources />);
    expect(mockInbox).toHaveBeenCalledTimes(4);
    // A later mount with an empty cache (the entry was collected): 403s are asked again.
    await render(null);
    client.clear();
    await render(<Sources />);
    expect(mockInbox).toHaveBeenCalledTimes(8);

    // Now the capability is off (404): remembered, not asked again.
    mockInbox.mockClear();
    mockInbox.mockRejectedValue(new ApiError("Company not found", 404, null));
    await render(null);
    client.clear();
    await render(<Sources />);
    expect(mockInbox).toHaveBeenCalledTimes(4);
    await render(null);
    client.clear();
    await render(<Sources />);
    expect(mockInbox).toHaveBeenCalledTimes(4);
  });

  it("does not ask the gated route before a write when the server says off", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(false));
    await expect(fetchStewardshipOn(client, "c1")).resolves.toBe(false);
    expect(mockInbox).not.toHaveBeenCalled();
  });

  it("still requires the gated route to answer before a write", async () => {
    mockCapabilities.mockResolvedValue(capabilitiesWith(true));
    mockInbox.mockResolvedValue({ stewardedAgent: null, stewardship: null, items: [] });
    await expect(fetchStewardshipOn(client, "c1")).resolves.toBe(true);
    expect(mockInbox).toHaveBeenCalledTimes(1);
  });
});
