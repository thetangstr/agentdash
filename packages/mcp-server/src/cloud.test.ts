// The cloud toolset (doc/plans/2026-10-31-cloud-mcp-toolset.md): the four
// tools, the stdio HTTP backend, and the in-place upgrade to the setup toolset
// after connect. The cloud API is faked at the backend or at fetch; cloud/
// tests the control plane behind it (cloud/src/__tests__/agent-cloud*.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CLOUD_PLAYBOOK, edgeDomainFor, httpCloudBackend, isWorkspaceApi, normalizeCloudUrl, type CloudBackend, type CloudOp } from "./cloud.js";
import { NO_INSTANCE_API_URL, readConfigFromEnv } from "./config.js";
import { AGENTDASH_TOOLSETS, createAgentDashServer, parseToolset } from "./index.js";

const HANDLE = `agdh_${"A".repeat(43)}`;
const BOX = "https://acme.agentdash.cloud";
const KEY = `pcp_board_${"ab".repeat(24)}`;
const CLOUD_TOOLS = ["agentdash_cloud_check_name", "agentdash_cloud_start", "agentdash_cloud_status", "agentdash_cloud_connect"];

function config() {
  return { apiUrl: NO_INSTANCE_API_URL, apiKey: "", companyId: null, agentId: null, runId: null };
}

/** A backend that records calls and answers from a script. */
function scripted(answers: Partial<Record<CloudOp, Array<{ status: number; body: Record<string, unknown> }>>>) {
  const calls: Array<{ op: CloudOp; input: Record<string, unknown> }> = [];
  const backend: CloudBackend = {
    async call(op, input) {
      calls.push({ op, input });
      const next = answers[op]?.shift();
      if (!next) throw new Error(`no scripted answer for ${op}`);
      return next;
    },
  };
  return { backend, calls };
}

async function connectClient(server: ReturnType<typeof createAgentDashServer>) {
  const client = new Client({ name: "cloud-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function body(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("cloud is a toolset, chosen by AGENTDASH_TOOLSET", () => {
    expect(AGENTDASH_TOOLSETS).toContain("cloud");
    expect(parseToolset(" Cloud ")).toBe("cloud");
  });

  it("needs no instance URL: a cloud session learns it at connect", () => {
    expect(() => readConfigFromEnv({})).toThrow(/PAPERCLIP_API_URL/);
    expect(readConfigFromEnv({}, { requireApiUrl: false }).apiUrl).toBe(NO_INSTANCE_API_URL);
    expect(new URL(NO_INSTANCE_API_URL).hostname.endsWith(".invalid")).toBe(true);
  });

  it("normalises the cloud URL: https only (http for localhost), no credentials, query or fragment", () => {
    expect(normalizeCloudUrl(undefined)).toBe("https://www.agentdash.cloud");
    expect(normalizeCloudUrl("https://www.agentdash.cloud/api/cloud/")).toBe("https://www.agentdash.cloud");
    expect(normalizeCloudUrl("https://staging.example.test/api")).toBe("https://staging.example.test");
    expect(normalizeCloudUrl("http://127.0.0.1:3200")).toBe("http://127.0.0.1:3200");
    expect(() => normalizeCloudUrl("http://www.agentdash.cloud")).toThrow(/https/);
    expect(() => normalizeCloudUrl("https://user:pw@www.agentdash.cloud")).toThrow(/credentials/);
    expect(() => normalizeCloudUrl("https://www.agentdash.cloud/?x=1")).toThrow(/query/);
    expect(() => normalizeCloudUrl("not a url")).toThrow(/not a URL/);
  });
});

describe("the stdio backend", () => {
  it("POSTs JSON to /api/cloud/agent/<op>; the handle travels only in the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: "email_pending" }), { status: 200 }));
    const backend = httpCloudBackend("https://www.agentdash.cloud", { fetch: fetchMock as unknown as typeof fetch });
    const result = await backend.call("status", { handle: HANDLE });
    expect(result).toEqual({ status: 200, body: { state: "email_pending" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.agentdash.cloud/api/cloud/agent/status");
    expect(url).not.toContain(HANDLE);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ handle: HANDLE });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("error");
  });

  it("reports an unreachable cloud instead of throwing, and survives a non-JSON answer", async () => {
    const down = httpCloudBackend("https://www.agentdash.cloud", { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await down.call("check-name", { slug: "acme" })).toMatchObject({ status: 0, body: { code: "cloud_unreachable" } });
    const html = httpCloudBackend("https://www.agentdash.cloud", { fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch });
    expect(await html.call("check-name", { slug: "acme" })).toMatchObject({ status: 502, body: { error: expect.any(String) } });
  });
});

describe("the cloud toolset", () => {
  it("lists exactly the four cloud tools, with the cloud playbook and only the playbook resource", async () => {
    const { backend } = scripted({});
    const client = await connectClient(createAgentDashServer(config(), { toolset: "cloud", cloud: { backend } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(CLOUD_TOOLS);
    expect(client.getInstructions()).toBe(CLOUD_PLAYBOOK);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["agentdash://playbook"]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    await expect(client.readResource({ uri: "agentdash://agents" })).rejects.toThrow();
    const start = tools.find((t) => t.name === "agentdash_cloud_start")!;
    expect(start.inputSchema.required).toEqual(expect.arrayContaining(["email", "slug", "acceptTerms"]));
    expect(tools.find((t) => t.name === "agentdash_cloud_status")!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("validates input before calling the cloud: terms must be accepted, handles must look like handles", async () => {
    const { backend, calls } = scripted({});
    const client = await connectClient(createAgentDashServer(config(), { toolset: "cloud", cloud: { backend } }));
    const noTerms = await client.callTool({ name: "agentdash_cloud_start", arguments: { email: "founder@acme.test", slug: "acme", acceptTerms: false } });
    expect(noTerms.isError).toBe(true);
    const badHandle = await client.callTool({ name: "agentdash_cloud_status", arguments: { handle: "pcp_board_nope" } });
    expect(badHandle.isError).toBe(true);
    expect(body(badHandle).issues).toEqual([expect.stringContaining("handle")]);
    expect(calls).toHaveLength(0);
  });

  it("passes the cloud's answer through, and marks a refusal as an error", async () => {
    const { backend, calls } = scripted({
      start: [{ status: 201, body: { handle: HANDLE, state: "email_pending", nextSteps: "check your email" } }],
      "check-name": [{ status: 429, body: { error: "Too many checks.", code: "rate_limited" } }],
    });
    const client = await connectClient(createAgentDashServer(config(), { toolset: "cloud", cloud: { backend } }));
    const started = await client.callTool({
      name: "agentdash_cloud_start",
      arguments: { email: "Founder@Acme.test", slug: "Acme", admissionCode: "AGD-HOST-X", acceptTerms: true },
    });
    expect(started.isError).toBeFalsy();
    expect(body(started)).toMatchObject({ handle: HANDLE, state: "email_pending" });
    expect(calls[0]).toEqual({ op: "start", input: { email: "Founder@Acme.test", slug: "acme", admissionCode: "AGD-HOST-X", acceptTerms: true } });
    const limited = await client.callTool({ name: "agentdash_cloud_check_name", arguments: { slug: "acme" } });
    expect(limited.isError).toBe(true);
    expect(body(limited)).toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("over stdio, a delivered connect upgrades the session in place: the setup tools appear and talk to the box with the key", async () => {
    const { backend } = scripted({
      connect: [
        { status: 200, body: { state: "approval_pending", approvalUrl: `${BOX}/cli-auth/x?token=t` } },
        { status: 200, body: { state: "connected", boxUrl: BOX, apiUrl: `${BOX}/api`, apiKey: KEY } },
      ],
    });
    // A stdio session: no backend override means the server owns the upgrade.
    const server = createAgentDashServer(config(), { toolset: "cloud", cloud: { cloudUrl: "https://www.agentdash.cloud" } });
    // Swap the HTTP backend's fetch for the scripted cloud, and fake the box.
    const boxCalls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://www.agentdash.cloud/api/cloud/agent/")) {
        const op = url.split("/").pop() as CloudOp;
        const r = await backend.call(op, JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url.startsWith(`${BOX}/api/`)) {
        boxCalls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/api/health")) return new Response(JSON.stringify({ status: "ok", bootstrapStatus: "ready", adapterReady: false }), { status: 200 });
        if (url.endsWith("/api/companies")) return new Response("[]", { status: 200 });
      }
      return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 599 });
    }));
    const client = await connectClient(server);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void (changed += 1));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CLOUD_TOOLS);

    const pending = await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle: HANDLE } });
    expect(body(pending)).toMatchObject({ state: "approval_pending" });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CLOUD_TOOLS);

    const connected = await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle: HANDLE } });
    expect(body(connected)).toMatchObject({ state: "connected", sessionUpgraded: true, nextAction: "agentdash_setup_status" });
    await vi.waitFor(() => expect(changed).toBe(1));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.slice(0, 4)).toEqual(CLOUD_TOOLS);
    expect(names).toEqual(expect.arrayContaining(["agentdash_setup_status", "agentdash_start_interview", "agentdash_interview_turn", "agentdash_confirm_plan"]));

    const status = await client.callTool({ name: "agentdash_setup_status", arguments: {} });
    expect(body(status)).toMatchObject({ serverHealthy: true, apiKeyConfigured: true, phase: "setup_adapter" });
    expect(boxCalls.find((c) => c.url === `${BOX}/api/companies`)?.auth).toBe(`Bearer ${KEY}`);
    expect(boxCalls.find((c) => c.url === `${BOX}/api/health`)).toBeTruthy();
  });

  it("never re-points the session at a URL that is not the https workspace's own /api", async () => {
    expect(isWorkspaceApi(BOX, `${BOX}/api`)).toBe(true);
    expect(isWorkspaceApi("https://acme.evil.example", "https://acme.evil.example/api")).toBe(false);
    expect(isWorkspaceApi("https://a.b.agentdash.cloud", "https://a.b.agentdash.cloud/api")).toBe(false);
    expect(isWorkspaceApi("https://acme.agentdash.cloud:8443", "https://acme.agentdash.cloud:8443/api")).toBe(false);
    expect(isWorkspaceApi("https://acme.staging.test", "https://acme.staging.test/api", "staging.test")).toBe(true);
    expect(edgeDomainFor("https://www.agentdash.cloud")).toBe("agentdash.cloud");
    expect(edgeDomainFor("http://127.0.0.1:3200")).toBe("agentdash.cloud");
    expect(edgeDomainFor("https://www.agentdash.cloud", "Staging.Test")).toBe("staging.test");
    expect(isWorkspaceApi("http://acme.agentdash.cloud", "http://acme.agentdash.cloud/api")).toBe(false);
    expect(isWorkspaceApi(BOX, "https://evil.example/api")).toBe(false);
    expect(isWorkspaceApi(`${BOX}/x`, `${BOX}/x/api`)).toBe(false);
    const { backend } = scripted({ connect: [{ status: 200, body: { state: "connected", boxUrl: BOX, apiUrl: "https://evil.example/api", apiKey: KEY } }] });
    const server = createAgentDashServer(config(), { toolset: "cloud", cloud: { cloudUrl: "https://www.agentdash.cloud" } });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const r = await backend.call("connect", JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }));
    const client = await connectClient(server);
    const r = await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle: HANDLE } });
    expect(body(r)).toMatchObject({ sessionUpgraded: false });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CLOUD_TOOLS);
  });

  it("over the hosted endpoint (a backend passed in), connect returns the answer and never upgrades", async () => {
    const { backend } = scripted({ connect: [{ status: 200, body: { state: "connected", boxUrl: BOX, apiUrl: `${BOX}/api`, apiKey: KEY } }] });
    const client = await connectClient(createAgentDashServer(config(), { toolset: "cloud", cloud: { backend } }));
    const connected = await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle: HANDLE } });
    expect(body(connected)).toEqual({ state: "connected", boxUrl: BOX, apiUrl: `${BOX}/api`, apiKey: KEY });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(CLOUD_TOOLS);
  });

  it("the playbook keeps the person's secrets out of the agent's hands", () => {
    expect(CLOUD_PLAYBOOK).toMatch(/never see their verification link, their claim link, their password or a browser session/i);
    expect(CLOUD_PLAYBOOK).toMatch(/NEVER invent one/);
  });
});
