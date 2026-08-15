// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which address ends up in someone else's config file.
 *
 * The generated Claude and Codex snippets used `window.location.origin`, so the
 * address baked into `~/.codex/config.toml` was whichever URL happened to be in
 * the browser when Copy was pressed. Copy from a LAN address and that laptop
 * works in one office and silently fails in every other network — and the fix
 * then lives in a file on a colleague's machine.
 *
 * So the configured public URL wins when the operator has set one, and the
 * browser origin is the fallback rather than the source of truth.
 */

const mockAgentsApi = vi.hoisted(() => ({ createKey: vi.fn() }));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../../api/health", () => ({ healthApi: mockHealthApi }));

const { ConnectYourHarness } = await import("./ConnectYourHarness");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ConnectYourHarness agentId="agent-1" agentName="Chief" companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  // react-query resolves over several microtask turns, so a single flush reads
  // the pre-fetch render and reports the fallback no matter what the fix does.
  // Settle until the component stops changing.
  let previous = "";
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const current = container.textContent ?? "";
    if (current === previous && i > 1) break;
    previous = current;
  }
  return container.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe("ConnectYourHarness", () => {
  it("uses the configured public URL rather than the browser origin", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      publicBaseUrl: "http://mkmini.example.test:3103",
    });

    const text = await render();

    expect(text).toContain("http://mkmini.example.test:3103");
    // jsdom's origin is localhost; it must not reach the generated config.
    expect(text).not.toContain("http://localhost:3000");
  });

  it("says so when the config points somewhere other than the current address", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      publicBaseUrl: "http://mkmini.example.test:3103",
    });

    const text = await render();

    expect(text).toMatch(/not the address you are browsing/i);
  });

  /**
   * A single-network install has no configured URL, and must behave exactly as
   * it did before — otherwise this fix breaks the common case to serve the rare
   * one.
   */
  it("falls back to the browser origin when no public URL is configured", async () => {
    mockHealthApi.get.mockResolvedValue({ status: "ok" });

    const text = await render();

    expect(text).toContain(window.location.origin);
    expect(text).not.toMatch(/not the address you are browsing/i);
  });
});
