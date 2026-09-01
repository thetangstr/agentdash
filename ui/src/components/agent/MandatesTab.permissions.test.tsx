// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Granting a mandate authorises one agent to act on another's behalf. That is
 * company direction by any reading, so a member reads the list and cannot grant.
 *
 * The list stays visible on purpose: a colleague should be able to see what
 * their agent has been authorised to do. Only the granting is withheld.
 */

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const mockMandatesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listAttestations: vi.fn(),
  create: vi.fn(),
  runAttestation: vi.fn(),
}));
vi.mock("../../api/mandates", () => ({ mandatesApi: mockMandatesApi }));

// `agents` is a prop, not a fetch — a second agent is needed so there is an
// eligible grantor and the form renders for the owner control case.
const AGENTS = [
  { id: "agent-1", name: "CoS", role: "chief_of_staff" },
  { id: "agent-2", name: "Analyst", role: "analyst" },
] as never;

const { MandatesTab } = await import("./MandatesTab");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockMandatesApi.list.mockResolvedValue([]);
  mockMandatesApi.listAttestations.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function capabilities(directionSet: boolean) {
  mockCapabilitiesApi.get.mockResolvedValue({
    companyId: "company-1",
    actorType: "board",
    membershipRole: directionSet ? "owner" : "member",
    isInstanceAdmin: false,
    capabilities: { "direction:set": directionSet },
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MandatesTab companyId="company-1" agentId="agent-1" agents={AGENTS} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 15; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe("MandatesTab permissions", () => {
  it("does not offer the grant form to a member", async () => {
    capabilities(false);
    await render();

    expect(container.textContent).not.toContain("Grant a mandate");
    expect(container.querySelector("form")).toBeNull();
  });

  it("explains who may grant instead of just hiding it", async () => {
    // A form that vanishes with no reason reads as a missing feature.
    capabilities(false);
    await render();
    expect(container.textContent).toMatch(/owner, admin or operator/i);
  });

  it("still shows the granted mandates list to a member", async () => {
    // The point of the read-only model: see what your agent may do.
    capabilities(false);
    await render();
    expect(container.textContent).toContain("Granted mandates");
  });

  it("offers the grant form to an owner", async () => {
    // The control case. Without it, a component that never renders the form
    // would satisfy every assertion above.
    capabilities(true);
    await render();
    expect(container.textContent).toContain("Grant a mandate");
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("does not offer it while the answer is still unknown", async () => {
    mockCapabilitiesApi.get.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.querySelector("form")).toBeNull();
  });
});
