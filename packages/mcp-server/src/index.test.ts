import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PaperclipApiClient } from "./client.js";
import { createAgentDashServer } from "./index.js";
import { createJourneyToolDefinitions } from "./journey.js";
import { toolInputSchema } from "./schema.js";
import { createToolDefinitions } from "./tools.js";

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: null,
  agentId: null,
  runId: null,
};

describe("unified server composition", () => {
  const client = new PaperclipApiClient(CONFIG);
  const tools = [...createToolDefinitions(client), ...createJourneyToolDefinitions(client)];

  it("exposes both toolsets with unique names", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    // The core tools are unprefixed now — the MCP server name is the
    // namespace. Nothing should carry the old Paperclip branding.
    expect(names.some((name) => name.startsWith("paperclip"))).toBe(false);
    expect(names).toContain("whoami");
    expect(names).toContain("list_issues");
    expect(names).toContain("update_agent");
    expect(names).toContain("report_issue");
    expect(names).toContain("agentdash_setup_status");
    expect(names).toContain("agentdash_install_checklist");
    expect(names).toContain("agentdash_sign_up");
    expect(names).toContain("agentdash_start_interview");
    expect(names).toContain("agentdash_interview_turn");
    expect(names).toContain("agentdash_get_plan");
    expect(names).toContain("agentdash_confirm_plan");
    expect(names).toContain("agentdash_revise_plan");
    expect(names).toContain("agentdash_request_approval");
    expect(names).toContain("agentdash_check_approval");
    expect(names).toContain("agentdash_list_agents");
    expect(names).toContain("agentdash_list_tasks");
    expect(names).toContain("agentdash_create_task");
    expect(names).toContain("agentdash_get_dashboard");
    expect(names).toContain("agentdash_pause_agent");
    expect(names).toContain("agentdash_resume_agent");
    // Full approvals surface from the paperclip layer.
    expect(names).toContain("list_approvals");
    expect(names).toContain("create_approval");
    expect(names).toContain("get_approval");
    expect(names).toContain("approval_decision");
    expect(names).toContain("add_approval_comment");
    expect(names).toContain("link_issue_approval");
  });

  it("converts every tool schema to a JSON object schema without throwing", () => {
    for (const tool of tools) {
      const inputSchema = toolInputSchema(tool.schema);
      expect(inputSchema.type, `tool ${tool.name}`).toBe("object");
      expect(inputSchema.properties, `tool ${tool.name}`).toBeTypeOf("object");
    }
  });

  it("constructs the MCP server from a config", () => {
    const server = createAgentDashServer(CONFIG);
    expect(server).toBeDefined();
  });

  it("advertises bridge argument descriptions and numeric bounds to an MCP client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("tools/list must not contact an API");
    });
    const server = createAgentDashServer({ ...CONFIG, apiUrl: "http://127.0.0.1:9/api", apiKey: "bridge-contract-test" });
    const consumer = new Client({ name: "schema-contract-test", version: "1" });
    const [consumerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await consumer.connect(consumerTransport);
      const { tools: advertised } = await consumer.listTools();
      const propose = advertised.find((tool) => tool.name === "inbox_propose")!;
      const sync = advertised.find((tool) => tool.name === "inbox_sync")!;
      expect(propose.inputSchema).toEqual({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["assign_work", "set_cadence"] },
          items: {
            type: "array", description: "For assign_work: who, and what they should do",
            items: {
              type: "object",
              properties: {
                agent: { type: "string" },
                work: { type: "string", description: "Short name for the job; becomes the issue title" },
                description: { type: "string", description: "The full brief: context, what done looks like, constraints" },
              },
              required: ["agent", "work"],
            },
          },
          minutes: { type: "integer", description: "For set_cadence: 30 or 60" },
        },
        required: ["kind"],
      });
      expect(sync.inputSchema).toEqual({
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
          includeDigest: { type: "boolean" },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await consumer.close();
      await server.close();
      fetchSpy.mockRestore();
    }
  });

  it("serves a steward playbook that directs the MCP consumer to the mandate reader", async () => {
    const server = createAgentDashServer({ ...CONFIG, apiUrl: "http://127.0.0.1:9/api", apiKey: "pcp_contract_test", agentId: "00000000-0000-4000-8000-000000000001" });
    const consumer = new Client({ name: "steward-contract-test", version: "1" });
    const [consumerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await consumer.connect(consumerTransport);
      const instructions = consumer.getInstructions();
      expect(instructions).toContain("`agentdashGetMyMandate` returns it");
      expect(instructions).toContain("`agentdashGetAgentDirectives` reads your steward's directives");
      expect(instructions).not.toContain("`agentdashGetAgentDirectives` returns it");
      const resource = await consumer.readResource({ uri: "agentdash://playbook" });
      expect(resource.contents[0].text).toBe(instructions);
      const { tools: advertised } = await consumer.listTools();
      expect(advertised.some((tool) => tool.name === "agentdashGetMyMandate")).toBe(true);
      expect(advertised.some((tool) => tool.name === "agentdashGetAgentDirectives")).toBe(true);
    } finally {
      await consumer.close();
      await server.close();
    }
  });
});
