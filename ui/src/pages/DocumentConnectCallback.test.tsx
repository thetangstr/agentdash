// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";

const mockDocumentsApi = vi.hoisted(() => ({
  getMicrosoft: vi.fn(),
  initiateMicrosoft: vi.fn(),
  completeMicrosoft: vi.fn(),
  revokeMicrosoft: vi.fn(),
}));
const mockCompany = vi.hoisted(() => ({
  value: { selectedCompanyId: "company-selected" as string | null, loading: false },
}));

vi.mock("../api/documents", () => ({ documentsApi: mockDocumentsApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => mockCompany.value }));

const { default: DocumentConnectCallback } = await import("./DocumentConnectCallback");
const { rememberPendingConnect, readPendingConnect } = await import("../lib/document-connect");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "M.C5-one-time-authorization-code";
const STATE = "conn-1.state-token";
const REDIRECT = "https://agentdash.example.test/connect/microsoft/callback";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const seen: { pathname: string; search: string }[] = [];

function LocationProbe() {
  const location = useLocation();
  seen.push({ pathname: location.pathname, search: location.search });
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(entry: string, { strict = false } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A query the callback must refresh once the connection exists.
  client.setQueryData(["myAgent", "documents", "company-1", "microsoft"], { configured: true, connection: null });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/connect/:provider/callback" element={<DocumentConnectCallback />} />
          <Route path="*" element={<div>landed</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function where(): string {
  return container.querySelector('[data-testid="where"]')?.textContent ?? "";
}

function cacheDump(): string {
  const queries = client.getQueryCache().getAll().map((query) => query.queryKey);
  const mutations = client.getMutationCache().getAll().map((mutation) => ({
    key: mutation.options.mutationKey,
    variables: mutation.state.variables,
  }));
  return JSON.stringify({ queries, mutations });
}

describe("DocumentConnectCallback", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    seen.length = 0;
    window.sessionStorage.clear();
    mockCompany.value = { selectedCompanyId: "company-selected", loading: false };
    rememberPendingConnect({
      provider: "microsoft",
      companyId: "company-1",
      redirectUri: REDIRECT,
      returnTo: "/ACME/my-agent",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("posts the code, state and redirect URI to the company the sign-in started in, then returns", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockDocumentsApi.completeMicrosoft.mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );

    await render(`/connect/microsoft/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}&session_state=abc`);
    await flush();

    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledTimes(1);
    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledWith("company-1", {
      code: CODE,
      state: STATE,
      redirectUri: REDIRECT,
    });
    // The code left the address bar before the server answered.
    expect(where()).toBe("/connect/microsoft/callback");
    expect(container.textContent).toContain("Finishing");

    await act(async () => {
      finish({ connection: { id: "conn-1", status: "active" } });
    });
    await flush();

    expect(where()).toBe("/ACME/my-agent");
    expect(readPendingConnect("microsoft")).toBeNull();
    expect(client.getQueryState(["myAgent", "documents", "company-1", "microsoft"])?.isInvalidated).toBe(true);

    // Only the very first render ever saw the code.
    expect(seen.filter((entry) => entry.search.includes("code=")).length).toBeLessThanOrEqual(1);
    expect(seen.at(-1)?.search).toBe("");
    expect(cacheDump()).not.toContain(CODE);
    expect(cacheDump()).not.toContain("state-token");
    expect(container.innerHTML).not.toContain(CODE);
  });

  it("posts once under StrictMode, so the one-time state is not spent twice", async () => {
    mockDocumentsApi.completeMicrosoft.mockResolvedValue({ connection: { id: "conn-1", status: "active" } });
    await render(`/connect/microsoft/callback?code=${CODE}&state=${STATE}`, { strict: true });
    await flush();
    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledTimes(1);
    expect(where()).toBe("/ACME/my-agent");
  });

  it("reports a declined sign-in to the server and says so, with the URL already clean", async () => {
    mockDocumentsApi.completeMicrosoft.mockRejectedValue(
      new ApiError("You declined the Microsoft sign-in, so nothing was connected.", 400, { code: "access_denied" }),
    );
    await render(
      `/connect/microsoft/callback?error=access_denied&error_description=${encodeURIComponent("The user cancelled")}&state=${STATE}`,
    );
    await flush();

    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledWith("company-1", {
      error: "access_denied",
      state: STATE,
      redirectUri: REDIRECT,
    });
    expect(container.textContent).toContain("You declined the Microsoft sign-in, so nothing was connected.");
    expect(container.querySelector('a[href="/ACME/my-agent"]')).not.toBeNull();
    expect(where()).toBe("/connect/microsoft/callback");
    expect(readPendingConnect("microsoft")).toBeNull();
  });

  it("forwards an admin-consent error code and shows the server's fixed message, never Microsoft's description", async () => {
    const description = "AADSTS65001: <b>Call 555-0100 to unlock</b>";
    mockDocumentsApi.completeMicrosoft.mockRejectedValue(
      new ApiError(
        "Your organization requires an administrator to approve AgentDash before you can connect. Ask your Microsoft 365 administrator to grant consent, then connect again.",
        403,
        { code: "admin_consent_required" },
      ),
    );
    await render(
      `/connect/microsoft/callback?error=consent_required&error_description=${encodeURIComponent(description)}&state=${STATE}`,
    );
    await flush();

    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledWith("company-1", {
      error: "consent_required",
      state: STATE,
      redirectUri: REDIRECT,
    });
    expect(container.textContent).toContain("requires an administrator to approve AgentDash");
    expect(container.textContent).not.toContain("declined");
    expect(container.textContent).not.toContain("555-0100");
    expect(where()).toBe("/connect/microsoft/callback");
  });

  it("shows the server's refusal without echoing the code", async () => {
    mockDocumentsApi.completeMicrosoft.mockRejectedValue(
      new ApiError("This sign-in link has expired or was already used. Start again from My Agent.", 400, null),
    );
    await render(`/connect/microsoft/callback?code=${CODE}&state=${STATE}`);
    await flush();
    expect(container.textContent).toContain("expired or was already used");
    expect(container.innerHTML).not.toContain(CODE);
    expect(where()).toBe("/connect/microsoft/callback");
  });

  it("posts nothing when the state is missing", async () => {
    await render(`/connect/microsoft/callback?code=${CODE}`);
    await flush();
    expect(mockDocumentsApi.completeMicrosoft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("incomplete");
    expect(where()).toBe("/connect/microsoft/callback");
  });

  it("falls back to the selected company and this origin when the tab forgot the sign-in", async () => {
    window.sessionStorage.clear();
    mockDocumentsApi.completeMicrosoft.mockResolvedValue({ connection: { id: "conn-1", status: "active" } });
    await render(`/connect/microsoft/callback?code=${CODE}&state=${STATE}`);
    await flush();
    expect(mockDocumentsApi.completeMicrosoft).toHaveBeenCalledWith("company-selected", {
      code: CODE,
      state: STATE,
      redirectUri: `${window.location.origin}/connect/microsoft/callback`,
    });
    expect(where()).toBe("/my-agent");
  });

  it("refuses a provider it does not know", async () => {
    await render(`/connect/google/callback?code=${CODE}&state=${STATE}`);
    await flush();
    expect(mockDocumentsApi.completeMicrosoft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not a document provider");
    expect(where()).toBe("/connect/google/callback");
  });
});
