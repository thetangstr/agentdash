interface LowLevelCaller {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

export interface ClockchainClient {
  attest(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const textBlock = result.content?.find((b) => b.type === "text" && typeof b.text === "string");
  if (!textBlock?.text) return {};
  try {
    const parsed = JSON.parse(textBlock.text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function makeClockchainClient(caller: LowLevelCaller): ClockchainClient {
  return {
    attest: async (tool, args) => parseToolResult(await caller.callTool({ name: tool, arguments: args })),
  };
}

// Real connection (Streamable HTTP MCP). Used by the orchestrator only.
export async function connectClockchain(): Promise<{ client: ClockchainClient; close: () => Promise<void> }> {
  const url = process.env.CLOCKCHAIN_MCP_URL || "https://mcp.clockchain.network/mcp";
  const token = process.env.CLOCKCHAIN_MCP_TOKEN;
  if (!token) throw new Error("CLOCKCHAIN_MCP_TOKEN unset");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { "x-api-key": token } },
  });
  const mcp = new Client({ name: "atlas-wire", version: "1.0.0" });
  await mcp.connect(transport);
  return {
    client: makeClockchainClient({ callTool: (req) => mcp.callTool(req) as never }),
    close: () => mcp.close(),
  };
}
