// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const mockHumanChannelsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  startPairing: vi.fn(),
  revoke: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock("@/api/human-channels", () => ({ humanChannelsApi: mockHumanChannelsApi }));

const { ChannelBindingsTable } = await import("./ChannelBindingsTable");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: "binding-1",
    companyId: "company-1",
    userId: "user-9",
    agentId: "agent-1",
    provider: "telegram",
    externalTenantId: null,
    externalUserId: "555",
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
        <ChannelBindingsTable companyId="company-1" />
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

describe("ChannelBindingsTable", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockHumanChannelsApi.listAll.mockResolvedValue({ bindings: [binding()] });
    mockHumanChannelsApi.revoke.mockResolvedValue({ binding: binding({ revokedAt: "2026-08-04T00:00:00.000Z" }) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists every company binding for an administrator with a revoke control", async () => {
    await render();

    expect(mockHumanChannelsApi.listAll).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("telegram");
    expect(container.textContent).toContain("555");

    const revoke = button(/revoke/i);
    expect(revoke, "an administrator must be offered a revoke control").toBeTruthy();

    await act(async () => {
      revoke!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockHumanChannelsApi.revoke).toHaveBeenCalledWith("company-1", "binding-1");
  });

  // T1c: a non-admin cannot see or revoke other users' bindings.
  it("shows a permission notice and no bindings when the list route refuses (403)", async () => {
    mockHumanChannelsApi.listAll.mockRejectedValue(
      new ApiError("Listing company channel bindings requires administrator access", 403, null),
    );

    await render();

    expect(container.textContent).toMatch(/permission|administrator/i);
    // No binding data and no revoke affordance leaked to a non-admin.
    expect(container.textContent).not.toContain("555");
    expect(button(/revoke/i)).toBeFalsy();
  });
});
