// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const { useCapability, refusalMessage } = await import("./useCapability");

/**
 * The state that gets forgotten is "not yet known".
 *
 * A component that reads loading as "allowed" flashes an editor and snatches it
 * away; one that reads it as "denied" flashes a read-only page at the owner.
 * Both look broken, so `allowed` and `isLoading` stay separate and callers are
 * expected to handle three states, not two.
 */

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe({ companyId }: { companyId: string | null }) {
  const { allowed, isLoading } = useCapability(companyId, "direction:set");
  return (
    <>
      <span data-testid="state">{isLoading ? "loading" : allowed ? "allowed" : "denied"}</span>
      {/* `allowed` on its own. Reading it through the three-state string above
          hid a hook that reported allowed-while-loading, because that branch
          checks isLoading first — the test passed against a broken hook. */}
      <span data-testid="allowed">{String(allowed)}</span>
    </>
  );
}

async function render(companyId: string | null = "company-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe companyId={companyId} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return container.querySelector('[data-testid="state"]')?.textContent;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCapability", () => {
  it("reports allowed when the server says so", async () => {
    mockCapabilitiesApi.get.mockResolvedValue({ capabilities: { "direction:set": true } });
    expect(await render()).toBe("allowed");
  });

  it("reports denied when the server says so", async () => {
    mockCapabilitiesApi.get.mockResolvedValue({ capabilities: { "direction:set": false } });
    expect(await render()).toBe("denied");
  });

  it("is denied, never allowed, when the request fails", async () => {
    // Failing open would put an editable control in front of someone who will
    // then be refused by the API — the exact confusion this removes.
    mockCapabilitiesApi.get.mockRejectedValue(new Error("network"));
    expect(await render()).toBe("denied");
  });

  it("does not ask when there is no company yet", async () => {
    mockCapabilitiesApi.get.mockResolvedValue({ capabilities: { "direction:set": true } });
    await render(null);
    expect(mockCapabilitiesApi.get).not.toHaveBeenCalled();
  });

  it("never reports allowed before the answer arrives", async () => {
    // The anti-flash property, stated directly.
    let settle: (v: unknown) => void = () => {};
    mockCapabilitiesApi.get.mockReturnValue(new Promise((r) => { settle = r; }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    expect(
      container.querySelector('[data-testid="allowed"]')?.textContent,
      "allowed must be false until the server has answered",
    ).toBe("false");

    await act(async () => {
      settle({ capabilities: { "direction:set": true } });
      await new Promise((r) => setTimeout(r, 0));
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("allowed");
  });
});

describe("refusalMessage", () => {
  it("surfaces the server's own sentence rather than inventing one", () => {
    expect(refusalMessage({ error: "Only an owner, admin or operator can change company direction." }))
      .toMatch(/owner, admin or operator/);
    expect(refusalMessage(new Error("Agents cannot change company direction."))).toMatch(/Agents cannot/);
  });

  it("falls back to something human when there is nothing to surface", () => {
    expect(refusalMessage(null)).toMatch(/permission/i);
    expect(refusalMessage({})).toMatch(/permission/i);
  });
});
