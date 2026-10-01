import { runServer } from "./index.js";

void runServer().catch((error: unknown) => {
  console.error(process.env.AGENTDASH_TOOLSET?.trim().toLowerCase() === "human"
    ? "Failed to start human MCP: verify the named board-key connection and API base URL"
    : "Failed to start AgentDash MCP server", process.env.AGENTDASH_TOOLSET?.trim().toLowerCase() === "human" ? "" : error);
  process.exit(1);
});
