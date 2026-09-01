// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";

const mockHumanChannelsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  startPairing: vi.fn(),
  revoke: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock("../../api/human-channels", () => ({ humanChannelsApi: mockHumanChannelsApi }));

const { MyChannels } = await import("./MyChannels");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function connectedBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1",
    companyId: "company-1",
    userId: "user-1",
    agentId: "agent-1",
    provider: "telegram",
    externalTenantId: null,
    externalUserId: "111",
    externalConversationId: null,
    metadata: null,
    verifiedAt: "2026-08-01T00:00:00.000Z",
    revokedAt: null,
    revokedByUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MyChannels companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: RegExp) {
  return Array.from(container.querySelectorAll("button")).find((element) =>
    label.test(element.textContent ?? ""),
  );
}

describe("MyChannels", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockHumanChannelsApi.listMine.mockResolvedValue({ bindings: [] });
    mockHumanChannelsApi.startPairing.mockResolvedValue({
      deepLink: "https://t.me/agentdash_test_bot?start=tok",
      expiresAt: "2026-08-04T12:00:00.000Z",
    });
    mockHumanChannelsApi.revoke.mockResolvedValue({ binding: connectedBinding({ revokedAt: "2026-08-04T00:00:00.000Z" }) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // T1a
  it("pairs Telegram end to end and never mints a link until asked", async () => {
    await render();

    expect(container.textContent).toContain("Channels");
    expect(container.textContent).toContain("Telegram");
    // Minting spends the one outstanding challenge — never on page load.
    expect(mockHumanChannelsApi.startPairing).not.toHaveBeenCalled();

    const connect = button(/connect telegram/i);
    expect(connect, "no Connect Telegram control rendered").toBeTruthy();

    await act(async () => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Calls the real route through the client — identity is never in the body.
    expect(mockHumanChannelsApi.startPairing).toHaveBeenCalledWith("company-1", "telegram");
    const link = Array.from(container.querySelectorAll("a")).find((anchor) =>
      anchor.getAttribute("href")?.startsWith("https://t.me/"),
    );
    expect(link, "the minted deep link was not shown").toBeTruthy();
  });

  // T1b
  it("flips a connected channel to revoked and tolerates an idempotent repeat", async () => {
    mockHumanChannelsApi.listMine.mockResolvedValueOnce({ bindings: [connectedBinding()] });
    // Server is idempotent: after the first revoke it keeps returning the
    // already-revoked binding, and the UI must render that without erroring.
    mockHumanChannelsApi.listMine.mockResolvedValue({
      bindings: [connectedBinding({ revokedAt: "2026-08-04T00:00:00.000Z" })],
    });

    await render();
    expect(container.textContent).toContain("Connected");

    const disconnect = button(/disconnect/i);
    expect(disconnect).toBeTruthy();

    await act(async () => {
      disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockHumanChannelsApi.revoke).toHaveBeenCalledWith("company-1", "binding-1");
    // Row flipped: the connected state is gone and pairing is offered again.
    expect(container.textContent).not.toContain("Connected");
    expect(button(/connect telegram/i)).toBeTruthy();
    // No error surfaced by a repeat that returns the same revoked row.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // T1d
  it("renders the WhatsApp 24-hour window caveat", async () => {
    await render();

    expect(container.textContent).toContain("WhatsApp");
    expect(container.textContent).toMatch(/24-hour|24 hour|24h/i);
  });

  // Build requirement: Teams renders "not available" on the 503, row stays.
  it("renders Teams as not available on a 503 without hiding the row", async () => {
    mockHumanChannelsApi.startPairing.mockRejectedValue(
      new ApiError("Teams pairing is not configured: TEAMS_BOT_APP_ID is unset", 503, null),
    );

    await render();
    expect(container.textContent).toContain("Teams");

    const connect = button(/connect teams/i);
    expect(connect, "Teams row must stay visible with a control").toBeTruthy();

    await act(async () => {
      connect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Teams");
    expect(container.textContent).toMatch(/not available/i);
  });
});
