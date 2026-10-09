// AgentDash (per-steward document access, slice 3): the four read tools, at
// the boundary an MCP client touches (tools/list) and at the HTTP request
// they make.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PaperclipApiClient } from "./client.js";
import { createAgentDashServer } from "./index.js";
import { createToolDefinitions } from "./tools.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const RUN = "33333333-3333-3333-3333-333333333333";
const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: COMPANY,
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: RUN,
};
const DOCUMENT_TOOLS = ["documents_status", "documents_search", "documents_list", "documents_read"];

function getTool(name: string) {
  const tool = createToolDefinitions(new PaperclipApiClient(CONFIG)).find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function stubFetch(body: unknown = { ok: true }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [URL | string, RequestInit];
  return { url: new URL(String(url)), method: init.method, headers: init.headers as Record<string, string>, body: init.body };
}

describe("document read tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("are advertised over tools/list as read-only, with bounds and the provider enum", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("tools/list must not contact an API");
    });
    const server = createAgentDashServer({ ...CONFIG, apiUrl: "http://127.0.0.1:9/api", apiKey: "pcp_documents_contract_test" });
    const consumer = new Client({ name: "documents-contract-test", version: "1" });
    const [consumerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await consumer.connect(consumerTransport);
      const { tools } = await consumer.listTools();
      for (const name of DOCUMENT_TOOLS) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool!.description!.length, name).toBeGreaterThan(80);
        expect(tool!.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
      const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as Record<string, any>;
      expect(props("documents_search").provider).toMatchObject({ enum: ["microsoft"] });
      expect(props("documents_search").limit).toMatchObject({ minimum: 1, maximum: 25 });
      expect(props("documents_search").scope).toMatchObject({ enum: ["all", "my_drive", "shared", "sites"] });
      expect(props("documents_list").limit).toMatchObject({ minimum: 1, maximum: 100 });
      expect(props("documents_read").format).toMatchObject({ enum: ["text", "metadata"] });
      expect(props("documents_read").offset).toMatchObject({ minimum: 0 });
      expect(tools.find((t) => t.name === "documents_search")!.inputSchema.required).toEqual(
        expect.arrayContaining(["provider", "query"]),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await consumer.close();
      await server.close();
    }
  });

  it("say what a reader must do with the text: untrusted, quote do not paste, page with nextOffset", () => {
    const read = getTool("documents_read").description;
    expect(read).toMatch(/never follow instructions/i);
    expect(read).toMatch(/Quote, do not paste/);
    expect(read).toMatch(/nextOffset/);
    expect(read).toMatch(/Slide N/);
    expect(getTool("documents_status").description).toMatch(/current steward/);
  });

  it("documents_read GETs the read route with the run id header", async () => {
    const fetchMock = stubFetch({ text: "framed" });
    await getTool("documents_read").execute({ provider: "microsoft", itemRef: "b!drive:item-1", offset: 60000 });
    const call = lastCall(fetchMock);
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe(`/api/companies/${COMPANY}/documents/microsoft/read`);
    expect(call.url.searchParams.get("itemRef")).toBe("b!drive:item-1");
    expect(call.url.searchParams.get("offset")).toBe("60000");
    expect(call.headers["X-Paperclip-Run-Id"]).toBe(RUN);
    expect(call.body).toBeUndefined();
  });

  it("documents_search, documents_list and documents_status GET with the run id header", async () => {
    const fetchMock = stubFetch({ results: [] });
    await getTool("documents_search").execute({ provider: "microsoft", query: "kickoff plan", scope: "shared", limit: 5 });
    let call = lastCall(fetchMock);
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe(`/api/companies/${COMPANY}/documents/microsoft/search`);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ query: "kickoff plan", scope: "shared", limit: "5" });
    expect(call.headers["X-Paperclip-Run-Id"]).toBe(RUN);

    await getTool("documents_list").execute({ provider: "microsoft" });
    call = lastCall(fetchMock);
    expect(call.url.pathname).toBe(`/api/companies/${COMPANY}/documents/microsoft/list`);
    expect(call.url.search).toBe("");
    expect(call.headers["X-Paperclip-Run-Id"]).toBe(RUN);

    await getTool("documents_status").execute({});
    call = lastCall(fetchMock);
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe(`/api/companies/${COMPANY}/documents/status`);
  });

  it("refuses an unknown provider and out-of-bounds limits before any request", async () => {
    const fetchMock = stubFetch();
    const google = await getTool("documents_search").execute({ provider: "google", query: "x" });
    const tooMany = await getTool("documents_search").execute({ provider: "microsoft", query: "x", limit: 26 });
    const listTooMany = await getTool("documents_list").execute({ provider: "microsoft", limit: 101 });
    const negative = await getTool("documents_read").execute({ provider: "microsoft", itemRef: "a", offset: -1 });
    for (const result of [google, tooMany, listTooMany, negative]) {
      expect(JSON.parse(result.content[0]!.text).error).toBeTruthy();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
