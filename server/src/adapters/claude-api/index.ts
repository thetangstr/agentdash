import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const claudeApiAdapter: ServerAdapterModule = {
  type: "claude_api",
  execute,
  testEnvironment,
  models: [
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-haiku-3-5-20241022", label: "Claude Haiku 3.5" },
  ],
};
