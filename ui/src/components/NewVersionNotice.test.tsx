// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFreshness = vi.hoisted(() => ({
  isStale: vi.fn(async () => false),
  looksLikeStaleAssetError: vi.fn((reason: unknown) =>
    String((reason as Error)?.message ?? reason).includes("dynamically imported"),
  ),
  FRESHNESS_POLL_MS: 300_000,
}));

vi.mock("@/lib/build-freshness", () => mockFreshness);

const { NewVersionNotice } = await import("./NewVersionNotice");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(<NewVersionNotice />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockFreshness.isStale.mockResolvedValue(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("NewVersionNotice", () => {
  it("says nothing when the build matches", async () => {
    await render();
    expect(container.textContent).not.toContain("AgentDash has been updated");
  });

  /**
   * The window this closes: a chunk 404s on the next navigation, which would
   * otherwise be a blank screen until the five-minute poll came round.
   */
  it("appears immediately when a chunk fails to load", async () => {
    await render();
    expect(container.textContent).not.toContain("AgentDash has been updated");

    await act(async () => {
      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    });

    expect(container.textContent).toContain("AgentDash has been updated");
    // It did not need to confirm against index.html to know something broke.
    expect(mockFreshness.isStale).toHaveBeenCalledTimes(1); // the initial check only
  });

  it("cancels the preload error so the app does not crash instead", async () => {
    await render();
    const event = new Event("vite:preloadError", { cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("appears on an unhandled rejection that names a missing chunk", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("Failed to fetch dynamically imported module: /assets/index-OLD.js"),
        }),
      );
    });
    expect(container.textContent).toContain("AgentDash has been updated");
  });

  it("ignores an unrelated rejection", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("Request failed with status 500"),
        }),
      );
    });
    expect(container.textContent).not.toContain("AgentDash has been updated");
  });

  it("still catches staleness by polling for a tab that never navigates", async () => {
    mockFreshness.isStale.mockResolvedValue(true);
    await render();
    expect(container.textContent).toContain("AgentDash has been updated");
  });

  /** Someone mid-edit must be able to silence it and finish. */
  it("can be dismissed", async () => {
    mockFreshness.isStale.mockResolvedValue(true);
    await render();
    const dismiss = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Not now",
    )!;
    await act(async () => {
      dismiss.click();
    });
    expect(container.textContent).not.toContain("AgentDash has been updated");
  });

  it("never reloads on its own", async () => {
    mockFreshness.isStale.mockResolvedValue(true);
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      configurable: true,
    });
    await render();
    expect(reload).not.toHaveBeenCalled();
  });
});
