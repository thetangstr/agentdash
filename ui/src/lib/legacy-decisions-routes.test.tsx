// @vitest-environment jsdom
// AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — the Inbox and
// Approvals list URLs redirect to Decisions for every company, so MK
// bookmarks (/inbox/mine, /approvals/pending) keep working.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompany = vi.hoisted(() => ({
  current: { selectedCompany: { id: "c-1", issuePrefix: "MK", productProfile: "agentdash_mk" } as Record<string, unknown> | null },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompany.current,
}));

const { LEGACY_DECISIONS_PATHS, legacyDecisionsRoutes } = await import("./legacy-decisions-routes");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

describe("legacy Decisions redirects", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function visit(path: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path=":companyPrefix">
              {legacyDecisionsRoutes()}
              <Route path="decisions" element={<Where />} />
              <Route path="approvals/:approvalId" element={<Where />} />
              <Route path="inbox/requests" element={<Where />} />
              <Route path="inbox/override" element={<Where />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
    });
    return container.querySelector('[data-testid="where"]')?.textContent;
  }

  it("covers the Inbox and Approvals list URLs", () => {
    for (const path of ["inbox", "inbox/mine", "inbox/recent", "inbox/unread", "inbox/all", "approvals", "approvals/pending", "approvals/all"]) {
      expect(LEGACY_DECISIONS_PATHS).toContain(path);
    }
  });

  it.each([
    "/MK/inbox",
    "/MK/inbox/mine",
    "/MK/inbox/unread",
    "/MK/inbox/company",
    "/MK/approvals",
    "/MK/approvals/pending",
    "/MK/approvals/all",
  ])("redirects %s to the company's /decisions", async (path) => {
    expect(await visit(path)).toBe("/MK/decisions");
  });

  it.each(["/MK/approvals/appr-1", "/MK/inbox/requests", "/MK/inbox/override"])(
    "leaves the live page %s alone",
    async (path) => {
      expect(await visit(path)).toBe(path);
    },
  );
});
