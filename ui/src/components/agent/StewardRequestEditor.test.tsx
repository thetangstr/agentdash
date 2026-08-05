// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  AGENT_POLICY_REVISION_CONFLICT,
  type AgentGovernancePolicy,
  collectCeilingViolations,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import type { AgentGovernanceRecord } from "../../api/agent-governance";

const mockGovernanceApi = vi.hoisted(() => ({
  updateRequest: vi.fn(),
}));

vi.mock("../../api/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-governance")>();
  return { ...actual, agentGovernanceApi: mockGovernanceApi };
});

const { StewardRequestEditor } = await import("./StewardRequestEditor");

// A ceiling that constrains every dimension class so an over-ceiling request is
// expressible for each one (list overflow, budget, destructive rank, approval rank).
const CEILING: AgentGovernancePolicy = {
  permissions: ["read"],
  monthlyBudgetCents: 10_000,
  destructiveActions: "approval_required",
  dataScopes: ["crm"],
  providers: ["hubspot"],
  minimumApproval: "steward",
};

// A request that sits comfortably inside the ceiling.
const REQUEST: AgentGovernancePolicy = {
  permissions: ["read"],
  monthlyBudgetCents: 5_000,
  destructiveActions: "approval_required",
  dataScopes: ["crm"],
  providers: ["hubspot"],
  minimumApproval: "steward",
};

function makeRecord(overrides: Partial<AgentGovernanceRecord> = {}): AgentGovernanceRecord {
  return {
    id: "policy-1",
    companyId: "company-1",
    agentId: "agent-1",
    ownerCeiling: CEILING,
    stewardRequest: REQUEST,
    effectivePolicy: REQUEST,
    revision: 4,
    ownerCeilingUpdatedByUserId: null,
    stewardRequestUpdatedByUserId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** Build the exact body the real route returns for an over-ceiling request. */
function ceilingErrorBody(requested: AgentGovernancePolicy) {
  const violations = collectCeilingViolations(CEILING, requested);
  return {
    error: "Requested agent configuration exceeds the owner ceiling",
    details: { code: AGENT_POLICY_CEILING_EXCEEDED, violations },
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(props: {
  policy: AgentGovernanceRecord;
  canEdit: boolean;
}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <StewardRequestEditor
          companyId="company-1"
          agentId="agent-1"
          policy={props.policy}
          canEdit={props.canEdit}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findButton(pattern: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    pattern.test(button.textContent ?? ""),
  );
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function setInput(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!el) throw new Error(`no field for ${selector}`);
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("StewardRequestEditor", () => {
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

  // T2c
  it("offers no edit affordance when the viewer is not the configuring steward", async () => {
    await render({ policy: makeRecord(), canEdit: false });

    // Authority is resolved server-side; the UI must not paint an edit control
    // for a viewer the server would refuse.
    expect(findButton(/edit request/i)).toBeUndefined();
    expect(container.querySelector('[aria-label="Requested permissions"]')).toBeNull();
  });

  // T2a
  it("submits the steward's edited request within the ceiling and reflects the new effective policy", async () => {
    mockGovernanceApi.updateRequest.mockResolvedValue({
      policy: makeRecord({
        stewardRequest: { ...REQUEST, monthlyBudgetCents: 8_000 },
        effectivePolicy: { ...REQUEST, monthlyBudgetCents: 8_000 },
        revision: 5,
      }),
    });

    await render({ policy: makeRecord(), canEdit: true });
    await click(findButton(/edit request/i)!);

    setInput('[aria-label="Requested monthly budget"]', "8000");
    await click(findButton(/save request/i)!);

    expect(mockGovernanceApi.updateRequest).toHaveBeenCalledWith("company-1", "agent-1", {
      policy: { ...REQUEST, monthlyBudgetCents: 8_000 },
      revision: 4,
    });
    // The returned record's effective policy is shown in place, not the old one.
    expect(container.textContent).toContain("$80.00/mo");
    // Edit mode closes on success.
    expect(findButton(/save request/i)).toBeUndefined();
  });

  // T2b — a G4 case per dimension class, asserted against the real error body.
  const overCeilingCases: Array<{
    name: string;
    field: keyof AgentGovernancePolicy;
    mutate: (draft: AgentGovernancePolicy) => AgentGovernancePolicy;
    edit: () => void;
    expected: string;
  }> = [
    {
      name: "list overflow (permissions)",
      field: "permissions",
      mutate: (d) => ({ ...d, permissions: ["read", "write"] }),
      edit: () => setInput('[aria-label="Requested permissions"]', "read, write"),
      expected: "read",
    },
    {
      name: "budget",
      field: "monthlyBudgetCents",
      mutate: (d) => ({ ...d, monthlyBudgetCents: 50_000 }),
      edit: () => setInput('[aria-label="Requested monthly budget"]', "50000"),
      expected: "$100.00/mo",
    },
    {
      name: "destructive-mode rank",
      field: "destructiveActions",
      mutate: (d) => ({ ...d, destructiveActions: "allowed" }),
      edit: () => setInput('[aria-label="Requested destructive actions"]', "allowed"),
      expected: "approval_required",
    },
    {
      name: "approval-mode rank",
      field: "minimumApproval",
      mutate: (d) => ({ ...d, minimumApproval: "none" }),
      edit: () => setInput('[aria-label="Requested minimum approval"]', "none"),
      expected: "steward",
    },
  ];

  for (const testCase of overCeilingCases) {
    it(`renders the named ceiling next to the offending field: ${testCase.name}`, async () => {
      const requested = testCase.mutate(REQUEST);
      mockGovernanceApi.updateRequest.mockRejectedValue(
        new ApiError(
          "Requested agent configuration exceeds the owner ceiling",
          422,
          ceilingErrorBody(requested),
        ),
      );

      await render({ policy: makeRecord(), canEdit: true });
      await click(findButton(/edit request/i)!);
      testCase.edit();
      await click(findButton(/save request/i)!);

      const fieldRegion = container.querySelector(`[data-field="${testCase.field}"]`);
      expect(fieldRegion, `no region for ${testCase.field}`).not.toBeNull();
      expect(fieldRegion!.textContent).toContain(testCase.expected);
    });
  }

  // T2d
  it("does not lose an update on a stale revision: surfaces the conflict and reloads", async () => {
    mockGovernanceApi.updateRequest.mockRejectedValue(
      new ApiError("Agent governance policy changed; reload and retry", 409, {
        error: "Agent governance policy changed; reload and retry",
        details: {
          code: AGENT_POLICY_REVISION_CONFLICT,
          expectedRevision: 4,
          currentRevision: 6,
        },
      }),
    );

    await render({ policy: makeRecord({ revision: 4 }), canEdit: true });
    await click(findButton(/edit request/i)!);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    setInput('[aria-label="Requested monthly budget"]', "9000");
    await click(findButton(/save request/i)!);

    // The stale revision was sent, the server refused, and the write did not land.
    expect(mockGovernanceApi.updateRequest).toHaveBeenCalledWith("company-1", "agent-1", {
      policy: { ...REQUEST, monthlyBudgetCents: 9_000 },
      revision: 4,
    });
    expect(container.textContent?.toLowerCase()).toContain("reload");
    // Reload = refetch the governance record so the next edit carries a fresh revision.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.myAgent.governance("company-1", "agent-1"),
    });
  });
});
