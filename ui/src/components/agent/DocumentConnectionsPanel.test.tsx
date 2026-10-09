// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";

const mockDocumentsApi = vi.hoisted(() => ({
  getMicrosoft: vi.fn(),
  initiateMicrosoft: vi.fn(),
  completeMicrosoft: vi.fn(),
  revokeMicrosoft: vi.fn(),
}));
const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../api/documents", () => ({ documentsApi: mockDocumentsApi }));
vi.mock("../../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const { DocumentConnectionsPanel } = await import("./DocumentConnectionsPanel");
const documentConnect = await import("../../lib/document-connect");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    account: "person.a@example.test",
    scopes: ["User.Read", "Files.Read.All", "Sites.Read.All"],
    writeScopes: [],
    tier: "read",
    status: "active",
    lastError: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

function capabilities(isInstanceAdmin: boolean) {
  return {
    companyId: "company-1",
    actorType: "user",
    membershipRole: "member",
    isInstanceAdmin,
    capabilities: {},
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DocumentConnectionsPanel companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}" in: ${container.textContent}`);
  return match as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

describe("DocumentConnectionsPanel", () => {
  let assign: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/ACME/my-agent");
    mockCapabilitiesApi.get.mockResolvedValue(capabilities(false));
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: true, connection: null });
    mockDocumentsApi.initiateMicrosoft.mockResolvedValue({
      authorizationUrl: "https://login.example.test/authorize?client_id=x&state=conn-1.opaque",
      connectionId: "conn-1",
    });
    mockDocumentsApi.revokeMicrosoft.mockResolvedValue({ connectionId: "conn-1", revoked: true });
    assign = vi.spyOn(documentConnect.browserNavigation, "assign").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    assign.mockRestore();
  });

  it("renders nothing when the capability route answers 404", async () => {
    mockDocumentsApi.getMicrosoft.mockRejectedValue(new ApiError("Not found", 404, null));
    await render();
    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders nothing for a member when the instance has no Microsoft sign-in", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: false, connection: null });
    await render();
    expect(container.textContent).toBe("");
  });

  it("tells an instance admin the instance is not configured, with no Connect button", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: false, connection: null });
    mockCapabilitiesApi.get.mockResolvedValue(capabilities(true));
    await render();
    expect(container.textContent).toContain("not configured on this instance");
    expect(container.querySelector("button")).toBeNull();
  });

  it("still lets a member disconnect a stored connection while the instance has no Microsoft sign-in", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValueOnce({ configured: false, connection: connection() });
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: false, connection: null });
    await render();

    expect(container.textContent).toContain("person.a@example.test");
    expect(container.textContent).toContain("stops reading your documents once its current Microsoft access expires");
    // Nothing that would start a sign-in the instance cannot finish.
    expect(container.textContent).not.toContain("Connect Microsoft 365");
    expect(container.textContent).not.toContain("Reconnect");
    // The operator note is for instance admins only.
    expect(container.textContent).not.toContain("ENTRA_CLIENT_ID");

    await click("Disconnect");
    expect(mockDocumentsApi.revokeMicrosoft).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toBe("");
  });

  it("shows an instance admin both the stored connection's Disconnect and the configuration note", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({
      configured: false,
      connection: connection({ status: "pending", tier: null, account: null, scopes: [] }),
    });
    mockCapabilitiesApi.get.mockResolvedValue(capabilities(true));
    await render();

    expect(container.textContent).toContain("not configured on this instance");
    expect(button("Disconnect")).toBeTruthy();
    expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim())).toEqual([
      "Disconnect",
    ]);
  });

  it("re-enables Connect when the browser restores the page from the back/forward cache", async () => {
    await render();
    await click("Connect Microsoft 365");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(button("Opening Microsoft…").disabled).toBe(true);

    // Back from Microsoft's sign-in page: the old React state comes back.
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(restored);
    });
    await flush();

    expect(button("Connect Microsoft 365").disabled).toBe(false);
  });

  it("says Microsoft will ask for edit permission even though AgentDash only adds files", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: true, connection: connection() });
    await render();
    expect(container.textContent).toContain("Microsoft will ask for permission to edit your files");
    expect(container.textContent).toContain("only ever creates new files, after your approval.");
  });

  it("starts a read-only sign-in and remembers where to come back to", async () => {
    await render();
    expect(container.textContent).toContain("Microsoft 365");
    await click("Connect Microsoft 365");

    expect(mockDocumentsApi.initiateMicrosoft).toHaveBeenCalledWith("company-1", {
      redirectUri: `${window.location.origin}/connect/microsoft/callback`,
      tier: "read",
    });
    expect(assign).toHaveBeenCalledWith(
      "https://login.example.test/authorize?client_id=x&state=conn-1.opaque",
    );
    const pending = documentConnect.readPendingConnect("microsoft");
    expect(pending).toMatchObject({
      provider: "microsoft",
      companyId: "company-1",
      redirectUri: `${window.location.origin}/connect/microsoft/callback`,
      returnTo: "/ACME/my-agent",
    });
    // The authorization URL carries the state; nothing about it is stored.
    expect(window.sessionStorage.getItem("agentdash.documentConnect.pending")).not.toContain("opaque");
  });

  it("shows the connected account, tier and status, and offers the write tier", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: true, connection: connection() });
    await render();

    expect(container.textContent).toContain("person.a@example.test");
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Connect Microsoft 365");

    await click("Reconnect with write access");
    expect(mockDocumentsApi.initiateMicrosoft).toHaveBeenCalledWith("company-1", {
      redirectUri: `${window.location.origin}/connect/microsoft/callback`,
      tier: "read_propose",
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("does not offer the write tier again once it is granted", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({
      configured: true,
      connection: connection({
        tier: "read_propose",
        scopes: ["User.Read", "Files.Read.All", "Sites.Read.All", "Files.ReadWrite", "User.ReadBasic.All"],
        writeScopes: ["Files.ReadWrite"],
      }),
    });
    await render();
    expect(container.textContent).toContain("Read, and propose new files");
    expect(container.textContent).not.toContain("Reconnect with write access");
  });

  it("shows the last error and reconnects at the tier the person already had", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({
      configured: true,
      connection: connection({
        status: "error",
        tier: "read_propose",
        writeScopes: ["Files.ReadWrite"],
        lastError: {
          reason: "invalid_grant",
          message: "Microsoft refused the stored sign-in. Reconnect Microsoft.",
          at: "2026-10-09T01:00:00.000Z",
        },
      }),
    });
    await render();

    expect(container.textContent).toContain("Needs reconnecting");
    expect(container.textContent).toContain("Microsoft refused the stored sign-in. Reconnect Microsoft.");
    await click("Reconnect");
    expect(mockDocumentsApi.initiateMicrosoft).toHaveBeenCalledWith("company-1", {
      redirectUri: `${window.location.origin}/connect/microsoft/callback`,
      tier: "read_propose",
    });
  });

  it("treats an unfinished sign-in as not connected", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({
      configured: true,
      connection: connection({ status: "pending", tier: null, account: null, scopes: [] }),
    });
    await render();
    expect(container.textContent).toContain("sign-in was started but not finished");
    expect(button("Connect Microsoft 365")).toBeTruthy();
  });

  it("disconnects and reloads the connection", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValueOnce({ configured: true, connection: connection() });
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: true, connection: null });
    await render();

    await click("Disconnect");
    expect(mockDocumentsApi.revokeMicrosoft).toHaveBeenCalledWith("company-1");
    expect(mockDocumentsApi.getMicrosoft).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Connect Microsoft 365");
  });

  it("says why a sign-in could not start and does not leave the page", async () => {
    mockDocumentsApi.initiateMicrosoft.mockRejectedValue(
      new ApiError("redirectUri must be on this instance's own address", 400, null),
    );
    await render();
    await click("Connect Microsoft 365");
    expect(container.textContent).toContain("redirectUri must be on this instance's own address");
    expect(assign).not.toHaveBeenCalled();
    expect(documentConnect.readPendingConnect("microsoft")).toBeNull();
  });

  it("never puts anything but company and provider in its query key", async () => {
    mockDocumentsApi.getMicrosoft.mockResolvedValue({ configured: true, connection: connection() });
    await render();
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(["myAgent", "documents", "company-1", "microsoft"]);
  });
});
