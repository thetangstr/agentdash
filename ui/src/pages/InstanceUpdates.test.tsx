// @vitest-environment jsdom
//
// What these tests protect is honesty, not layout.
//
// The page's job is to never look more certain than the server is. So the cases
// below are all about refusing to overstate: the button is disabled when the
// server says it cannot apply, the unsigned-provenance notice is always on
// screen, and a release that migrates the database must say that rolling back
// restores code only. Each of those is a sentence someone would act on.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OtaUpdateStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockOtaApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  requestApproval: vi.fn(),
  decide: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("@/api/ota", () => ({ otaApi: mockOtaApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { InstanceUpdates } = await import("./InstanceUpdates");

function statusFixture(overrides: Partial<OtaUpdateStatus> = {}): OtaUpdateStatus {
  return {
    mode: "source-release",
    channel: "stable",
    servingFromReleaseDir: true,
    installed: {
      tag: "v2026.827.1",
      version: "2026.827.1",
      commit: "e912d614c8f81498c842b154182bb764a98d0164",
      channel: "stable",
      releaseDir: "/releases/v2026.827.1-e912d614",
      installedAt: "2026-08-27T09:00:00Z",
    },
    available: {
      tag: "v2026.827.2",
      version: "2026.827.2",
      commit: "4637abd727dfe98b4865bec30a39cd772c484749",
      channel: "stable",
      publishedAt: "2026-08-27T11:27:59Z",
      notes: "Fixes the thing that was broken.",
      url: "https://example.invalid/releases/v2026.827.2",
    },
    upToDate: false,
    compatibility: {
      verdict: "compatible",
      pendingMigrations: [],
      irreversibleMigrations: [],
      reasons: ["No pending migrations. Rolling back is a checkout and nothing else."],
    },
    diff: {
      commitCount: 3,
      filesChanged: 7,
      insertions: 120,
      deletions: 15,
      commitSubjects: ["fix: stop the thing", "chore: tidy"],
      truncated: false,
      migrationsAdded: [],
    },
    rollback: {
      targetCommit: "e912d614c8f81498c842b154182bb764a98d0164",
      targetTag: "v2026.827.1",
      targetReleaseDir: "/releases/v2026.827.1-e912d614",
      codeOnly: true,
      requiresDatabaseRestore: false,
      dataLossWindow: null,
      steps: ["Point 'current' back at /releases/v2026.827.1-e912d614."],
    },
    approval: null,
    canApply: true,
    blockedReasons: [],
    checkedAt: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(status: OtaUpdateStatus) {
  mockOtaApi.getStatus.mockResolvedValue(status);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <InstanceUpdates />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  // react-query resolves across several microtask turns; one flush leaves the
  // component still showing its loading state and every assertion below then
  // compares against "Loading…".
  for (let attempt = 0; attempt < 30 && container.textContent?.includes("Loading"); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function updateButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Update this instance"),
  ) as HTMLButtonElement | undefined;
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

describe("InstanceUpdates", () => {
  it("shows the installed and available versions", async () => {
    await render(statusFixture());
    expect(container.textContent).toContain("2026.827.1");
    expect(container.textContent).toContain("2026.827.2");
    expect(container.textContent).toContain("Fixes the thing that was broken.");
    expect(container.textContent).toContain("3 commits");
  });

  // Always on screen, never behind a disclosure.
  it("always states that signatures are not verified", async () => {
    await render(statusFixture());
    expect(container.textContent).toContain("Release signatures are not verified");
  });

  it("enables the update button when the server says it can apply", async () => {
    await render(statusFixture());
    expect(updateButton()?.disabled).toBe(false);
  });

  it("disables the update button and shows the server's reasons when blocked", async () => {
    await render(
      statusFixture({
        canApply: false,
        servingFromReleaseDir: false,
        blockedReasons: ["This instance is not running from an immutable release directory."],
      }),
    );
    expect(container.textContent).toContain("not running from an immutable release directory");
    expect(container.textContent).toContain("a developer checkout — not updatable");
    expect(updateButton()?.disabled).toBe(true);
  });

  it("disables the button when already up to date", async () => {
    await render(statusFixture({ upToDate: true, available: null, canApply: false, blockedReasons: ["Already on the newest release."] }));
    expect(updateButton()?.disabled).toBe(true);
    expect(container.textContent).toContain("newest release");
  });

  // The sentence someone would act on.
  it("says a migrating release cannot be rolled back by code alone", async () => {
    await render(
      statusFixture({
        compatibility: {
          verdict: "forward_only",
          pendingMigrations: [{ id: "0123_x", name: "0123_x", reversible: false }],
          irreversibleMigrations: [{ id: "0123_x", name: "0123_x", reversible: false }],
          reasons: ["1 of 1 pending migration(s) cannot be reversed by a down-migration."],
        },
        rollback: {
          targetCommit: "e912d614",
          targetTag: "v2026.827.1",
          targetReleaseDir: "/releases/v2026.827.1-e912d614",
          codeOnly: false,
          requiresDatabaseRestore: true,
          dataLossWindow: "Everything written between the update and the rollback.",
          steps: ["Restore the database from the pre-update backup."],
        },
      }),
    );
    expect(container.textContent).toContain("One-way database changes");
    expect(container.textContent).toContain("0123_x");
    expect(container.textContent).toContain("needs a database restore");
    expect(container.textContent).toContain("Everything written between the update and the rollback.");
  });

  it("reports an unknown database impact rather than implying it is fine", async () => {
    await render(
      statusFixture({
        canApply: false,
        compatibility: {
          verdict: "unknown",
          pendingMigrations: [],
          irreversibleMigrations: [],
          reasons: ["The migration inventory could not be read."],
        },
        blockedReasons: ["The migration inventory could not be read."],
      }),
    );
    expect(container.textContent).toContain("Database impact unknown");
    expect(container.textContent).toContain("could not be read");
  });

  it("shows an existing approval and does not offer to approve again", async () => {
    await render(
      statusFixture({
        approval: {
          id: "approval-1",
          tag: "v2026.827.2",
          commit: "4637abd727dfe98b4865bec30a39cd772c484749",
          channel: "stable",
          status: "approved",
          requestedByUserId: "u1",
          requestedAt: "2026-09-02T00:00:00Z",
          decidedByUserId: "u1",
          decidedAt: "2026-09-02T00:01:00Z",
          approvedVerdict: "compatible",
        },
      }),
    );
    expect(container.textContent).toContain("Withdraw approval");
    expect(updateButton()?.disabled).toBe(true);
  });

  it("requires an explicit confirmation before recording approval", async () => {
    await render(statusFixture());
    // Clicking the page button opens the dialog; it must not approve on its own.
    await act(async () => {
      updateButton()?.click();
    });
    expect(mockOtaApi.requestApproval).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Update to 2026.827.2?");
  });
});
