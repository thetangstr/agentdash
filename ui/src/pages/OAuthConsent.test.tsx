// @vitest-environment jsdom
// AgentDash (GH #793, UX-12): the consent screen explains what the
// assistant can do, in the assistant's own name.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthConsent } from "./OAuthConsent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const consentView = {
  requestId: "req-1",
  clientName: "Muse",
  redirectHost: "muse.meta.example",
  requestedScopes: ["agentdash:read", "agentdash:work"],
  resource: "http://localhost:3100/api/mcp/assistant",
  companies: [{ id: "c1", name: "Paperclip" }],
};

describe("OAuthConsent", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => consentView,
      })),
    );
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  it("explains in the assistant's name what connecting allows", async () => {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/oauth/consent?request=req-1"]}>
            <OAuthConsent />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(container.textContent).toContain(
      "Muse can ask your agents for work, tell you what shipped, and bring you their decisions.",
    );
    expect(container.textContent).toContain("Allow Muse");
  });

  async function renderWith(view: typeof consentView & { companies: Array<{ id: string; name: string; adminBatchesAvailable?: boolean }> }) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => view })));
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/oauth/consent?request=req-1"]}>
            <OAuthConsent />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("admin powers (part 5): batch changes as an admin is labelled, never pre-checked, and says how to get it", async () => {
    await renderWith({ ...consentView, requestedScopes: ["agentdash:read", "agentdash:admin"], companies: [{ id: "c1", name: "Paperclip", adminBatchesAvailable: true }] });
    const row = container.querySelector('[data-testid="consent-scope-agentdash:admin"]')!;
    expect(row.textContent).toContain("Batch changes as an admin");
    expect(row.textContent).toContain("Nothing changes until you open the preview in AgentDash and give your assistant the code shown there.");
    const box = row.querySelector("input")!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(row.textContent).toContain("An assistant you connected before gets this only if you connect it again.");
  });

  it("admin powers (part 5): disabled with the plain reason where it is not available", async () => {
    await renderWith({ ...consentView, requestedScopes: ["agentdash:read", "agentdash:admin"], companies: [{ id: "c1", name: "Paperclip", adminBatchesAvailable: false }] });
    const row = container.querySelector('[data-testid="consent-scope-agentdash:admin"]')!;
    const box = row.querySelector("input")!;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(row.textContent).toContain("you are not an admin of this company, or it has not turned on batch changes");
  });
});
