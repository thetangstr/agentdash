interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface LowLevelCaller {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
}

export interface ClockchainClient {
  attest(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function parseToolResult(result: ToolResult): Record<string, unknown> {
  const textBlock = result.content?.find((b) => b.type === "text" && typeof b.text === "string");
  // A tool-level error must not be swallowed into an empty receipt — surface it
  // so the orchestrator records the failure instead of writing a receiptless event.
  if (result.isError) {
    throw new Error(`clockchain tool error: ${textBlock?.text ?? "unknown"}`);
  }
  // Prefer the text block: this server emits the full-fidelity receipt JSON
  // (nested `anchor` with blockHeight) there; structuredContent is a flatter
  // summary. Fall back to structuredContent only when no JSON text is present.
  if (textBlock?.text) {
    try {
      const parsed = JSON.parse(textBlock.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through to structuredContent */
    }
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  return {};
}

export function makeClockchainClient(caller: LowLevelCaller): ClockchainClient {
  return {
    attest: async (tool, args) => parseToolResult(await caller.callTool({ name: tool, arguments: args })),
  };
}

export interface NormalizedReceipt {
  ledgerId?: string;
  blockHeight?: string;
  clockchainTime?: string;
  eventHash?: string;
}

// Map a Clockchain `clockchain.receipt/v1` payload (eventHash at top level, the
// anchor fields nested under `anchor`) onto our flat columns. Falls back to
// top-level keys so flat shapes (and unit tests) still resolve.
export function normalizeReceipt(raw: unknown): NormalizedReceipt {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const anchor = (r.anchor && typeof r.anchor === "object" ? r.anchor : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;
  return {
    ledgerId: str(anchor.ledgerId) ?? str(r.ledgerId),
    blockHeight: str(anchor.blockHeight) ?? str(r.blockHeight),
    clockchainTime: str(anchor.recordedAt) ?? str(anchor.consensusTime) ?? str(r.clockchainTime),
    eventHash: str(r.eventHash),
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
