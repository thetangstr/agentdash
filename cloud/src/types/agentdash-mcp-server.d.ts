// The one surface cloud-control uses from the workspace MCP package (the
// cloud toolset, doc/plans/2026-10-31-cloud-mcp-toolset.md).
//
// `@agentdash/mcp-server` resolves at runtime to its esbuild `dist/`, which
// carries no declarations a fresh checkout has built; server/ declares its own
// slice the same way (server/src/types/agentdash-mcp-server.d.ts). tsconfig's
// `paths` points the import here, so drift in the package surfaces as a type
// error at the import site. vitest.config.ts aliases the same import to the
// package's source, so the tests run the real code.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type CloudOp = "check-name" | "start" | "status" | "connect";

export interface CloudCallResult {
  status: number;
  body: Record<string, unknown>;
}

export interface CloudBackend {
  call(op: CloudOp, input: Record<string, unknown>): Promise<CloudCallResult>;
}

export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

export type AgentDashToolset = "setup" | "agent" | "assistant" | "human" | "cloud";

export declare const NO_INSTANCE_API_URL: string;
export declare const CLOUD_OPS: readonly CloudOp[];

export declare function createAgentDashServer(
  config: PaperclipMcpConfig,
  options?: { toolset?: AgentDashToolset; cloud?: { backend?: CloudBackend; cloudUrl?: string } },
): Server;
