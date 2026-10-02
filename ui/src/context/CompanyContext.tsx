import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import type { CompanySelectionSource } from "../lib/company-selection";
import { IssuePrefixesContext } from "./IssuePrefixesContext";
import { useBoardSessionState } from "../hooks/useBoardSessionReady";
type CompanySelectionOptions = { source?: CompanySelectionSource };
type CompanyListResult = { companies: Company[]; unauthorized: boolean };
const EMPTY_COMPANY_LIST: CompanyListResult = { companies: [], unauthorized: false };
const SIGNED_OUT_COMPANY_LIST: CompanyListResult = { companies: [], unauthorized: true };

interface CompanyContextValue {
  companies: Company[];
  selectedCompanyId: string | null;
  selectedCompany: Company | null;
  selectionSource: CompanySelectionSource;
  loading: boolean;
  error: Error | null;
  setSelectedCompanyId: (companyId: string, options?: CompanySelectionOptions) => void;
  reloadCompanies: () => Promise<void>;
  createCompany: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => Promise<Company>;
}

const STORAGE_KEY = "agentdash.selectedCompanyId";
const LEGACY_STORAGE_KEY = "paperclip.selectedCompanyId";

// One-time migration of the legacy paperclip.* key. Runs at module init so the
// first localStorage read in the provider sees the migrated value.
if (typeof window !== "undefined") {
  try {
    if (!localStorage.getItem(STORAGE_KEY)) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        localStorage.setItem(STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  } catch {
    // localStorage can throw in privacy-mode iframes; the migration is best-effort.
  }
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function resolveBootstrapCompanySelection(input: {
  companies: Array<Pick<Company, "id" | "issuePrefix">>;
  sidebarCompanies: Array<Pick<Company, "id" | "issuePrefix">>;
  selectedCompanyId: string | null;
  storedCompanyId: string | null;
  routeCompanyPrefix?: string | null;
  selectionSource?: CompanySelectionSource;
}) {
  if (input.companies.length === 0) return null;

  const selectableCompanies = input.sidebarCompanies.length > 0
    ? input.sidebarCompanies
    : input.companies;
  // A company-prefixed deep link names the company it is about; select it
  // rather than whichever company happened to be stored, so profile-gated
  // route switches read the right profile on a mixed-profile instance. A
  // manual switch wins while its remembered-path navigation is in flight —
  // same guard as shouldSyncCompanySelectionFromRoute.
  const manualSwitchInFlight =
    input.selectionSource === "manual" &&
    input.selectedCompanyId !== null &&
    selectableCompanies.some((company) => company.id === input.selectedCompanyId);
  if (input.routeCompanyPrefix && !manualSwitchInFlight) {
    const routeCompany = selectableCompanies.find(
      (company) => company.issuePrefix.toUpperCase() === input.routeCompanyPrefix!.toUpperCase(),
    );
    if (routeCompany) return routeCompany.id;
  }
  if (input.selectedCompanyId && selectableCompanies.some((company) => company.id === input.selectedCompanyId)) {
    return input.selectedCompanyId;
  }
  if (input.storedCompanyId && selectableCompanies.some((company) => company.id === input.storedCompanyId)) {
    return input.storedCompanyId;
  }
  return selectableCompanies[0]?.id ?? null;
}

export function shouldClearStoredCompanySelection(input: {
  companies: Array<Pick<Company, "id">>;
  isLoading: boolean;
  unauthorized: boolean;
}) {
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);

  // AgentDash (scan 4, lane O2): no company list for a signed-out visitor.
  // While the session is being checked the list counts as loading (so a stored
  // selection is not cleared); once it is known to be absent it counts as
  // unauthorized, the same answer a 401 from the list gives.
  const sessionState = useBoardSessionState();
  const { data: queriedCompaniesResult, isLoading: companiesLoading, error } = useQuery<CompanyListResult>({
    enabled: sessionState === "ready",
    queryKey: queryKeys.companies.all,
    queryFn: async () => {
      try {
        return { companies: await companiesApi.list(), unauthorized: false };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return { companies: [], unauthorized: true };
        }
        throw err;
      }
    },
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
  const companiesResult: CompanyListResult =
    sessionState === "signed_out"
      ? SIGNED_OUT_COMPANY_LIST
      : queriedCompaniesResult ?? EMPTY_COMPANY_LIST;
  const isLoading = companiesLoading || (sessionState === "pending" && !queriedCompaniesResult);
  const companies = companiesResult.companies;
  const companyListUnauthorized = companiesResult.unauthorized;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );

  // Auto-select first company when list loads
  useEffect(() => {
    if (isLoading) return;
    if (companies.length === 0) {
      if (shouldClearStoredCompanySelection({ companies, isLoading: false, unauthorized: companyListUnauthorized })) {
        if (selectedCompanyId !== null) {
          setSelectedCompanyIdState(null);
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      return;
    }

    const next = resolveBootstrapCompanySelection({
      companies,
      sidebarCompanies,
      selectedCompanyId,
      storedCompanyId: localStorage.getItem(STORAGE_KEY),
      // Read at effect time so a cold deep link's prefix is current; a first
      // segment that matches no issuePrefix falls through to stored/first.
      routeCompanyPrefix: window.location.pathname.split("/").filter(Boolean)[0] ?? null,
      selectionSource,
    });
    if (next === null || next === selectedCompanyId) return;
    setSelectedCompanyIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [companies, companyListUnauthorized, isLoading, selectedCompanyId, selectionSource, sidebarCompanies]);

  const setSelectedCompanyId = useCallback((companyId: string, options?: CompanySelectionOptions) => {
    setSelectedCompanyIdState(companyId);
    setSelectionSource(options?.source ?? "manual");
    localStorage.setItem(STORAGE_KEY, companyId);
  }, []);

  const reloadCompanies = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) =>
      companiesApi.create(data),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(company.id);
    },
  });

  const createCompany = useCallback(
    async (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  // AgentDash: every visible company's prefix (archived included, their issues still
  // resolve), so markdown only links `PREFIX-123` tokens that can name an issue.
  // An empty list while companies load means "link no bare identifiers yet", so a
  // hard reload does not fetch `GPT-4` before the prefixes arrive.
  const issuePrefixes = useMemo(
    () => companies.map((company) => company.issuePrefix),
    [companies],
  );

  const value = useMemo(
    () => ({
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      loading: isLoading,
      error: error as Error | null,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    }),
    [
      companies,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      isLoading,
      error,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    ],
  );

  return (
    <CompanyContext.Provider value={value}>
      <IssuePrefixesContext.Provider value={issuePrefixes}>{children}</IssuePrefixesContext.Provider>
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error("useCompany must be used within CompanyProvider");
  }
  return ctx;
}
