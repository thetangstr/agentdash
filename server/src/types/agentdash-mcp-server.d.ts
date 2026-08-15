/**
 * Local declaration for the workspace MCP package.
 *
 * `@agentdash/mcp-server` resolves to its esbuild `dist/`, which carries no
 * declaration files, and its package.json is also the manifest of the tarball
 * this server hands to harnesses at /downloads — so pointing its `types` at
 * `src/` would put a dangling path into every future tarball. Declaring the
 * one consumed surface here keeps the published artefact untouched.
 *
 * Kept to exactly what the server imports, so drift in the package surfaces
 * as a type error at the import site rather than being silently widened.
 */
declare module "@agentdash/mcp-server" {
  import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

  export interface PaperclipMcpConfig {
    apiUrl: string;
    apiKey: string;
    companyId: string | null;
    agentId: string | null;
    runId: string | null;
  }

  export function createAgentDashServer(config: PaperclipMcpConfig): Server;
}
