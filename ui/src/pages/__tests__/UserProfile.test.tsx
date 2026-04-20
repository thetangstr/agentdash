// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserProfile } from "../../api/user-profile";

const getMeMock = vi.fn<() => Promise<UserProfile | null>>();
const setBreadcrumbsMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("../../api/user-profile", () => ({
  userProfileApi: {
    getMe: () => getMeMock(),
  },
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LS_KEY = "agentdash.user.preferences";

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: "user-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function renderPage(container: HTMLDivElement, Component: () => ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Component />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("UserProfile page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getMeMock.mockReset();
    setBreadcrumbsMock.mockReset();
    pushToastMock.mockReset();
    window.localStorage.removeItem(LS_KEY);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    window.localStorage.removeItem(LS_KEY);
  });

  it("renders identity section with user name and email", async () => {
    getMeMock.mockResolvedValue(makeUser());

    const { UserProfile } = await import("../UserProfile");
    const root = renderPage(container, UserProfile);
    await act(async () => {
      await flush();
    });

    expect(getMeMock).toHaveBeenCalled();
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("Profile");

    act(() => {
      root.unmount();
    });
  });

  it("sets breadcrumbs to Profile on mount", async () => {
    getMeMock.mockResolvedValue(makeUser());

    const { UserProfile } = await import("../UserProfile");
    const root = renderPage(container, UserProfile);
    await act(async () => {
      await flush();
    });

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Profile" }]);

    act(() => {
      root.unmount();
    });
  });

  it("persists preferences to localStorage when timezone changes", async () => {
    getMeMock.mockResolvedValue(makeUser());

    const { UserProfile } = await import("../UserProfile");
    const root = renderPage(container, UserProfile);
    await act(async () => {
      await flush();
    });

    const tzSelect = container.querySelector<HTMLSelectElement>(
      'select[data-testid="profile-timezone-select"]',
    );
    expect(tzSelect).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!;
      setter.call(tzSelect, "America/Los_Angeles");
      tzSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    const stored = window.localStorage.getItem(LS_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as Record<string, unknown>;
    expect(parsed.timezone).toBe("America/Los_Angeles");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("toggles email notifications preference and persists to localStorage", async () => {
    getMeMock.mockResolvedValue(makeUser());

    const { UserProfile } = await import("../UserProfile");
    const root = renderPage(container, UserProfile);
    await act(async () => {
      await flush();
    });

    const toggle = container.querySelector<HTMLInputElement>(
      'input[data-testid="profile-email-notifications"]',
    );
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle!.click();
      await flush();
    });

    const stored = window.localStorage.getItem(LS_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as Record<string, unknown>;
    expect(typeof parsed.emailNotifications).toBe("boolean");

    act(() => {
      root.unmount();
    });
  });

  it("renders danger zone with disabled delete button and admin contact copy", async () => {
    getMeMock.mockResolvedValue(makeUser());

    const { UserProfile } = await import("../UserProfile");
    const root = renderPage(container, UserProfile);
    await act(async () => {
      await flush();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[data-testid="profile-delete-account"]',
    );
    expect(deleteButton).toBeTruthy();
    expect(deleteButton!.disabled).toBe(true);
    expect(container.textContent?.toLowerCase()).toContain("contact");

    act(() => {
      root.unmount();
    });
  });
});
