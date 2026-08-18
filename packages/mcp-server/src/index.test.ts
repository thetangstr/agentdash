import { describe, expect, it } from "vitest";
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
});
