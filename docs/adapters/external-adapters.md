---
title: External adapters
summary: Package an adapter on its own and install it into a self-hosted AgentDash instance
---

An external adapter is a package outside the AgentDash source tree that the server loads at runtime. It runs agents the same way a built-in adapter does. An instance admin installs it from npm or from a local directory, and the server loads it again at every start.

Source: `server/src/adapters/plugin-loader.ts`, `server/src/services/adapter-plugin-store.ts`, `server/src/routes/adapters.ts`.

## Built-in and external

| | Built-in | External |
|---|---|---|
| Where it lives | `packages/adapters/*` or `server/src/adapters/` | Its own npm package or local directory |
| How it is registered | Imported in the server, UI and CLI registries | Loaded at server start from the adapter plugin store |
| Run transcript in the UI | Parser imported at build time | Optional `ui-parser.js`, fetched and run in a sandbox ([UI parser contract](/adapters/adapter-ui-parser)) |
| Config form in the UI | Hand-written React fields | Generated from `getConfigSchema()`, if the adapter provides it |
| Updates | Ship with an AgentDash release | Versioned on their own |

The type key must not be one of the [11 built-in types](/adapters/overview). `POST /api/adapters/install` refuses a package whose type is built in (409).

## Package layout

```
my-adapter/
  package.json
  tsconfig.json
  src/
    index.ts            # type, label, models, agentConfigurationDoc; re-exports createServerAdapter
    server/
      index.ts          # createServerAdapter()
      execute.ts        # runs the agent
      test.ts           # environment checks
    ui-parser.ts        # optional; see the UI parser contract
```

### package.json

```json
{
  "name": "my-agentdash-adapter",
  "version": "1.0.0",
  "type": "module",
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  },
  "files": ["dist"],
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@paperclipai/adapter-utils": "<version>"
  }
}
```

| Field | Purpose |
|---|---|
| `exports["."]` (or `main`) | The module the loader imports. It must export `createServerAdapter`. |
| `exports["./ui-parser"]` | Optional. The file served to the UI as the run-log parser. |
| `paperclip.adapterUiParser` | The UI parser contract version. The server supports major version `1`. |

Types and helpers come from `@paperclipai/adapter-utils` (`packages/adapter-utils` in the AgentDash repository). Build against the copy in your AgentDash checkout so the types match the server you install into.

## The server module

The loader imports the package entry, calls `createServerAdapter()`, and rejects the package if the result has no `type` (`validateAdapterModule` in `plugin-loader.ts`).

### src/index.ts

```ts
export const type = "my_agent";          // snake_case, unique on the instance
export const label = "My Agent (local)";
export const models = [{ id: "model-a", label: "Model A" }];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;

export { createServerAdapter } from "./server/index.js";
```

### src/server/index.ts

```ts
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter(): ServerAdapterModule {
  return { type, execute, testEnvironment, models, agentConfigurationDoc };
}
```

### src/server/execute.ts

`execute` receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult` (both in `packages/adapter-utils/src/types.ts`).

```ts
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const cwd = asString(config.cwd, process.cwd());
  const command = asString(config.command, "my-agent");

  // PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL
  const env = buildPaperclipEnv(agent);
  // Present only when the module sets supportsLocalAgentJwt: true
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  env.PAPERCLIP_RUN_ID = runId;

  const prompt = renderTemplate(asString(config.promptTemplate, "Continue your work."), {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    agent,
    context,
  });

  const proc = await runChildProcess(runId, command, [prompt], {
    cwd,
    env,
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 15),
    onLog,
  });

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: proc.exitCode === 0 ? null : `exited with code ${proc.exitCode}`,
  };
}
```

Helpers from `@paperclipai/adapter-utils/server-utils` (`packages/adapter-utils/src/server-utils.ts`):

| Helper | Purpose |
|---|---|
| `runChildProcess(runId, command, args, opts)` | Spawn with timeout, grace period and streamed logs. Returns `exitCode`, `signal`, `timedOut`, `stdout`, `stderr`. |
| `buildPaperclipEnv(agent)` | `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL` |
| `renderTemplate(template, data)` | `{{path.to.value}}` substitution |
| `asString`, `asNumber`, `asBoolean`, `asStringArray`, `parseObject` | Read config values safely. Each scalar helper takes a fallback. |

### src/server/test.ts

`testEnvironment` returns checks with a `code`, a `level` (`info`, `warn`, `error`) and a `message`, plus optional `hint` and `detail`. The overall `status` is `pass`, `warn` or `fail`.

```ts
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const cwd = String(ctx.config.cwd ?? "");
  if (!cwd.startsWith("/")) {
    checks.push({
      code: "invalid_cwd",
      level: "error",
      message: `Working directory must be absolute: "${cwd}"`,
    });
  }
  return {
    adapterType: ctx.adapterType,
    status: checks.some((c) => c.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
```

## Optional hooks

All optional fields of `ServerAdapterModule` are available to external adapters:

| Field | Use |
|---|---|
| `sessionCodec` | Validate, store and label session state for resume. See [Creating an adapter](/adapters/creating-an-adapter). |
| `sessionManagement` | Session compaction policy. If you omit it, the server uses the registry's policy for your type, if any. |
| `listSkills`, `syncSkills` | Report and install the agent's skills. The UI shows a skills tab when either is set. |
| `listModels`, `refreshModels`, `modelProfiles`, `listModelProfiles` | Model discovery |
| `detectModel` | Read the default model from the runtime's local config |
| `getConfigSchema` | Declarative form fields for the agent config UI |
| `onHireApproved` | Called when a hire for an agent on this adapter is approved |
| `getQuotaWindows` | Report provider quota windows |
| Capability flags | `supportsLocalAgentJwt`, `supportsInstructionsBundle`, `instructionsPathKey`, `requiresMaterializedRuntimeSkills`. See [Creating an adapter](/adapters/creating-an-adapter#capability-flags). |

## Installing

Adapter management is for an instance admin. The install, remove, reload and toggle routes call `assertInstanceAdmin`: the caller must be a board user with instance admin, or the implicit local board in `local_trusted` mode. Listing adapters and reading a config schema or UI parser only needs board access (`assertBoardOrgAccess`).

### From the UI

**Instance settings → Adapters** (`/instance/settings/adapters`) installs a package by npm name or by local path, and can enable, disable, reload, reinstall or remove it.

### From the API

```sh
# From npm (optionally pin a version)
curl -X POST {{instanceUrl}}/api/adapters/install \
  -H "Authorization: Bearer <board-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "my-agentdash-adapter", "version": "1.0.0"}'

# From a local directory on the server host
curl -X POST {{instanceUrl}}/api/adapters/install \
  -H "Authorization: Bearer <board-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "/home/me/my-adapter", "isLocalPath": true}'
```

An npm package is installed with `npm install --no-save` into `$PAPERCLIP_HOME/adapter-plugins/`. A local directory is loaded in place; nothing is copied. Either way the record goes into `$PAPERCLIP_HOME/adapter-plugins.json` (`PAPERCLIP_HOME` defaults to `~/.paperclip`), and the server loads it at every start.

| Route | What it does |
|---|---|
| `GET /api/adapters` | List built-in and external adapters, with `source`, `disabled`, version and capabilities |
| `POST /api/adapters/install` | Install from npm or a local path |
| `PATCH /api/adapters/:type` | `{ "disabled": true }` hides an adapter from agent creation; existing agents keep working |
| `POST /api/adapters/:type/reload` | Re-import the package from disk without a restart |
| `POST /api/adapters/:type/reinstall` | Pull the latest npm version and reload. Not for local-path installs. |
| `DELETE /api/adapters/:type` | Unregister an external adapter (and `npm uninstall` it). Built-ins cannot be removed. |
| `GET /api/adapters/:type/config-schema` | The adapter's `getConfigSchema()` result (`{ "fields": [] }` when it has none) |
| `GET /api/adapters/:type/ui-parser.js` | The adapter's UI parser, if it ships one |

## Security

- Installing an adapter runs its code inside the AgentDash server process. Install only packages you trust.
- Treat agent output as untrusted. Parse it; never evaluate it.
- Pass secrets through environment variables, not prompts.
- Always enforce a timeout and a grace period.
- The UI parser runs in a locked-down Web Worker in the browser. See the [UI parser contract](/adapters/adapter-ui-parser).

## Next steps

- [UI parser contract](/adapters/adapter-ui-parser)
- [Creating an adapter](/adapters/creating-an-adapter)
- [How agents work](/guides/agent-developer/how-agents-work)
