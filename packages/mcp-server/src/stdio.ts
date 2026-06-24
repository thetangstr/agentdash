import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error("Failed to start AgentDash MCP server:", error);
  process.exit(1);
});
