// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profile page shows three separate token/spend figures, all derived from
 * the same empty table: a hero stat, a per-window column, and a fourteen-day
 * chart. On the live uat instance the owner has five completed issues and the
 * page said "0 tokens · $0.00 spent" — a confident claim about a colleague's
 * work, manufactured out of the fact that nothing meters anything here.
 *
 * These assert the page says which it is. The `measured: true` control cases
 * matter as much as the false ones: a page that simply never renders a number
 * would satisfy every "not measured" assertion on its own.
 */

const mockUserProfilesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/userProfiles", () => ({ userProfilesApi: mockUserProfilesApi }));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ userSlug: "dotta" }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: () => <span /> }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>loading</div> }));

const { UserProfile } = await import("./UserProfile");

function window_(key: "last7" | "last30" | "all", label: string, tokens: number, costCents: number) {
  return {
    key,
    label,
    touchedIssues: 5,
    createdIssues: 5,
    completedIssues: 5,
    assignedOpenIssues: 0,
    commentCount: 0,
    activityCount: 22,
    costCents,
    inputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    costEventCount: tokens > 0 ? 1 : 0,
  };
}

function payload(measured: boolean, tokens = 0, costCents = 0) {
  return {
    user: {
      id: "user-1",
      slug: "dotta",
      name: "Dotta",
      email: "dotta@example.com",
      image: null,
      membershipRole: "owner",
      membershipStatus: "active",
      joinedAt: new Date("2026-01-01"),
    },
    measured,
    stats: [
      window_("last7", "Last 7 days", tokens, costCents),
      window_("last30", "Last 30 days", tokens, costCents),
      window_("all", "All time", tokens, costCents),
    ],
    daily: Array.from({ length: 14 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      activityCount: 1,
      completedIssues: index % 3,
      costCents: 0,
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
    })),
    recentIssues: [],
    recentActivity: [],
    topAgents: [],
    topProviders: [],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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

async function render(body: ReturnType<typeof payload>) {
  mockUserProfilesApi.get.mockResolvedValue(body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UserProfile />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 20; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return container.textContent ?? "";
}

describe("UserProfile when nothing is metered", () => {
  it("does not report a token count", async () => {
    const text = await render(payload(false));
    expect(text).toContain("Not measured");
    // The specific lie: a formatted zero standing in for an unknown.
    expect(text, "no $0.00 anywhere on an unmetered profile").not.toContain("$0.00");
    expect(text).not.toContain("0 spent");
  });

  it("says so on every one of the three surfaces, not just the headline", async () => {
    // The last commit gated one of two spend figures on the costs page and
    // shipped a page reading "Not measured" beside "$0.00". Three windows plus
    // the hero stat means at least four occurrences here.
    const text = await render(payload(false));
    expect((text.match(/Not measured/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(text, "the 14-day chart total is the third surface").toContain("Tokens not measured");
  });

  it("still reports the work, which we do know", async () => {
    // "Not measured" is a statement about metering. Suppressing the completed
    // count as well would turn a cost gap into an erasure of the person's work.
    const text = await render(payload(false));
    expect(text).toContain("Completed");
    expect(text).toContain("22");
  });

  it("relabels the chart it is actually drawing", async () => {
    // Fourteen flat bars under a "tokens / day" legend is a fortnight-long
    // claim that nobody did anything.
    const text = await render(payload(false));
    expect(text).toContain("completions / day");
    expect(text).not.toContain("tokens / day");
  });
});

describe("UserProfile when spend is metered", () => {
  it("shows the real figures", async () => {
    const text = await render(payload(true, 1500, 4200));
    expect(text).not.toContain("Not measured");
    expect(text).toContain("tokens / day");
    expect(text).toMatch(/\$42\.00/);
  });

  it("shows a real zero as a zero", async () => {
    // Once the company meters, this person's zero is a fact about them, and
    // dressing it up as "not measured" is the opposite error.
    const text = await render(payload(true, 0, 0));
    expect(text).not.toContain("Not measured");
    expect(text).toContain("$0.00");
  });
});

describe("UserProfile against an older server", () => {
  it("falls to not-measured when the field is absent", async () => {
    // A payload without `measured` must not be read as measured. Failing the
    // other way puts a fabricated zero on screen during a rolling deploy.
    const body = payload(true) as Record<string, unknown>;
    delete body.measured;
    const text = await render(body as ReturnType<typeof payload>);
    expect(text).toContain("Not measured");
  });
});
