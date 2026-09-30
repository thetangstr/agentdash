// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import {
  CompanyProvider,
  resolveBootstrapCompanySelection,
  shouldClearStoredCompanySelection,
  useCompany,
} from "./CompanyContext";
import { useIssuePrefixes } from "./IssuePrefixesContext";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

const activeCompany = { id: "company-1", issuePrefix: "PAP" };
const secondActiveCompany = { id: "company-2", issuePrefix: "MKC" };
const archivedCompany = { id: "archived-company", issuePrefix: "ARC" };

function makeCompany(id: string): Company {
  return {
    id,
    name: "Paperclip",
    description: null,
    status: "active",
    productProfile: "default",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    newIssuesStartAsTodo: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function Probe({ onSelectedCompanyId }: { onSelectedCompanyId: (companyId: string | null) => void }) {
  const { selectedCompanyId } = useCompany();
  useEffect(() => {
    onSelectedCompanyId(selectedCompanyId);
  }, [onSelectedCompanyId, selectedCompanyId]);
  return <div data-selected-company-id={selectedCompanyId ?? ""} />;
}

describe("resolveBootstrapCompanySelection", () => {
  it("does not expose a stale stored company id before companies load", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [],
      sidebarCompanies: [],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBeNull();
  });

  it("replaces a stale stored company id with the first loaded company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid selected company ahead of stored bootstrap state", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: "company-1",
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid stored company id instead of falling back to the first company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: null,
      storedCompanyId: "company-2",
    })).toBe("company-2");
  });

  it("uses selectable sidebar companies before archived companies", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [archivedCompany, activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "archived-company",
    })).toBe("company-1");
  });

  // AgentDash: UX-7 follow-up — a company-prefixed deep link names the company
  // it is about; on a mixed-profile instance the stored/manual company must
  // not shadow it, or profile-gated routes read the wrong profile.
  it("selects the company named by a route prefix ahead of stored selection", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: null,
      storedCompanyId: "company-1",
      routeCompanyPrefix: "mkc",
    })).toBe("company-2");
  });

  it("selects the route-prefix company ahead of an existing selection", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: "company-1",
      storedCompanyId: "company-1",
      routeCompanyPrefix: "MKC",
    })).toBe("company-2");
  });

  it("lets an in-flight manual switch finish instead of re-selecting the route company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: "company-2",
      storedCompanyId: "company-1",
      routeCompanyPrefix: "PAP",
      selectionSource: "manual",
    })).toBe("company-2");
  });

  it("ignores a route prefix that matches no company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: null,
      storedCompanyId: "company-2",
      routeCompanyPrefix: "decisions",
    })).toBe("company-2");
  });

  it("does not select an archived company via its route prefix", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [archivedCompany, activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: null,
      routeCompanyPrefix: "ARC",
    })).toBe("company-1");
  });
});

describe("shouldClearStoredCompanySelection", () => {
  it("does not clear the stored company selection during an unauthorized company list response", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: true,
    })).toBe(false);
  });

  it("clears the stored company selection when an authorized company list is empty", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: false,
    })).toBe(true);
  });
});

describe("CompanyProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("does not expose a stale stored company id before companies load", async () => {
    localStorage.setItem("agentdash.selectedCompanyId", "stale-company");
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null]);
  });

  it("replaces a stale stored company id with the first loaded company", async () => {
    localStorage.setItem("agentdash.selectedCompanyId", "stale-company");
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [makeCompany("company-1")],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null, "company-1"]);
    expect(localStorage.getItem("agentdash.selectedCompanyId")).toBe("company-1");
  });

  // AgentDash: markdown scopes bare `PREFIX-123` links to these prefixes.
  describe("issue prefixes for markdown links", () => {
    function PrefixProbe({ onPrefixes }: { onPrefixes: (prefixes: readonly string[] | null) => void }) {
      const prefixes = useIssuePrefixes();
      useEffect(() => {
        onPrefixes(prefixes);
      }, [onPrefixes, prefixes]);
      return null;
    }

    it("supplies an empty list while companies load, so no bare identifier links yet", async () => {
      mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
      const seen: Array<readonly string[] | null> = [];

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CompanyProvider>
              <PrefixProbe onPrefixes={(prefixes) => seen.push(prefixes)} />
            </CompanyProvider>
          </QueryClientProvider>,
        );
      });

      expect(seen).toEqual([[]]);
    });

    it("supplies every loaded company's prefix, archived companies included", async () => {
      queryClient.setQueryData(queryKeys.companies.all, {
        companies: [
          { ...makeCompany("company-1"), issuePrefix: "ACME" },
          { ...makeCompany("company-2"), issuePrefix: "PAP" },
          { ...makeCompany("archived-company"), issuePrefix: "ARC", status: "archived" },
        ],
        unauthorized: false,
      });
      mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
      const seen: Array<readonly string[] | null> = [];

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CompanyProvider>
              <PrefixProbe onPrefixes={(prefixes) => seen.push(prefixes)} />
            </CompanyProvider>
          </QueryClientProvider>,
        );
      });

      expect(seen.at(-1)).toEqual(["ACME", "PAP", "ARC"]);
    });

    it("is null outside a CompanyProvider", async () => {
      const seen: Array<readonly string[] | null> = [];

      await act(async () => {
        root.render(<PrefixProbe onPrefixes={(prefixes) => seen.push(prefixes)} />);
      });

      expect(seen).toEqual([null]);
    });
  });
});
