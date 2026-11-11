// @vitest-environment jsdom
// Instance general settings save explicitly: each section's controls change a
// draft, and that section's "Save changes" sends only the changed fields.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/api/health", () => ({ healthApi: { get: vi.fn(async () => ({ status: "ok" })) } }));
vi.mock("@/api/auth", () => ({ authApi: { signOut: vi.fn() } }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const { InstanceGeneralSettings } = await import("./InstanceGeneralSettings");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const SAVED = {
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
  feedbackDataSharingPreference: "prompt",
  backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockInstanceSettingsApi.getGeneral.mockResolvedValue(SAVED);
  mockInstanceSettingsApi.updateGeneral.mockResolvedValue(SAVED);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <InstanceGeneralSettings />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const byTestId = <T extends Element = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const buttonByText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(text))!;

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("InstanceGeneralSettings", () => {
  it("flipping a switch sends nothing; Save sends only that field", async () => {
    await render();
    const save = byTestId<HTMLButtonElement>("instance-general-shortcuts-save")!;
    expect(save.disabled).toBe(true);
    await click(byLabel("Toggle keyboard shortcuts"));
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();
    expect(byLabel("Toggle keyboard shortcuts").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("instance-general-shortcuts-state")!.textContent).toBe("Unsaved changes");
    // The other sections keep their own drafts.
    expect(byTestId<HTMLButtonElement>("instance-general-censor-save")!.disabled).toBe(true);
    await click(save);
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledTimes(1);
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledWith({ keyboardShortcuts: true });
  });

  it("backup retention: choosing presets is a draft, saved in one request", async () => {
    await render();
    await click(buttonByText("14 days"));
    await click(buttonByText("6 months"));
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();
    expect(buttonByText("14 days").getAttribute("aria-pressed")).toBe("true");
    await click(byTestId("instance-general-retention-save")!);
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledTimes(1);
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledWith({
      backupRetention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 },
    });
  });

  it("choosing the saved preset again leaves nothing to save", async () => {
    await render();
    await click(buttonByText("14 days"));
    await click(buttonByText("7 days"));
    expect(byTestId<HTMLButtonElement>("instance-general-retention-save")!.disabled).toBe(true);
  });

  it("Discard resets the draft without sending", async () => {
    await render();
    await click(buttonByText("Always allow"));
    expect(buttonByText("Always allow").getAttribute("aria-pressed")).toBe("true");
    await click(byTestId("instance-general-feedback-discard")!);
    expect(buttonByText("Always allow").getAttribute("aria-pressed")).toBe("false");
    expect(byTestId<HTMLButtonElement>("instance-general-feedback-save")!.disabled).toBe(true);
    expect(mockInstanceSettingsApi.updateGeneral).not.toHaveBeenCalled();
  });

  it("a failed save shows the error and keeps the draft", async () => {
    mockInstanceSettingsApi.updateGeneral.mockRejectedValueOnce(new Error("Instance admin required"));
    await render();
    await click(byLabel("Toggle username log censoring"));
    await click(byTestId("instance-general-censor-save")!);
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledWith({ censorUsernameInLogs: true });
    expect(byTestId("instance-general-censor-error")!.textContent).toBe("Instance admin required");
    expect(byLabel("Toggle username log censoring").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("instance-general-censor-state")!.textContent).toBe("Unsaved changes");
  });
});
