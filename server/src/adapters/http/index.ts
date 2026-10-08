import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds; a finite number takes precedence over timeoutMs; 0 or negative means none
- timeoutMs (number, optional): legacy timeout in milliseconds, used when timeoutSec is absent or not a finite number
- Positive timeout delays are capped at 2147483647 milliseconds (the Node timer maximum)
`,
};
