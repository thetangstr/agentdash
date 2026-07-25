import { runServer } from "./index.js";

void runServer().catch((error: unknown) => {
  console.error("Failed to start AgentDash MCP server:", error);
  process.exit(1);
});
