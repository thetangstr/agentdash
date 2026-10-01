---
title: Creating an adapter
summary: Build an adapter that connects AgentDash to another agent runtime
---

An adapter connects AgentDash to an agent runtime. Build one when none of the [built-in types](/adapters/overview) runs your agent.

The repository has a skill for this at `.agents/skills/create-agent-adapter`. If you work on AgentDash with a coding agent, point it at that skill.

## Two paths

| | Built-in | External |
|---|---|---|
| Where it lives | `packages/adapters/<name>/` in the AgentDash repository | Its own npm package or local directory |
| Registration | Edit the server, UI and CLI registries | Installed by an instance admin; loaded at server start |
| UI | React config fields and a parser compiled into the UI | Optional `ui-parser.js` and `getConfigSchema()` |
| Ships with | An AgentDash release | Its own version |

For most adapters, build an **external adapter**. It needs no change to AgentDash. See [External adapters](/adapters/external-adapters) for packaging and installation. The rest of this page covers what both paths share.

## Package structure

```
packages/adapters/<name>/     # built-in
  ── or ──
my-adapter/                   # external
  package.json
  src/
    index.ts            # type, label, models, agentConfigurationDoc
    server/
      index.ts          # server exports (createServerAdapter for external)
      execute.ts        # runs the agent
      parse.ts          # output parsing
      test.ts           # environment checks
    ui/                 # built-in only
      index.ts
      parse-stdout.ts   # stdout line -> TranscriptEntry[]
      build-config.ts   # form values -> adapterConfig
    ui-parser.ts        # external only; see the UI parser contract
    cli/                # built-in only
      index.ts
      format-event.ts   # terminal output for `paperclipai heartbeat run`
```

## Step 1: root metadata

`src/index.ts` is imported by the server, the UI and the CLI. Keep it free of dependencies.

```ts
export const type = "my_agent";          // snake_case, unique
export const label = "My Agent (local)";
export const models = [{ id: "model-a", label: "Model A" }];
export const agentConfigurationDoc = `# my_agent agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;
```

`agentConfigurationDoc` is the adapter's field reference. The server serves it at `/llms/agent-configuration/<type>.txt` (`server/src/routes/llms.ts`). Every built-in adapter has one; read `packages/adapters/claude-local/src/index.ts` for a full example.

## Step 2: execute

`execute(ctx)` receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult`. Both are defined in `packages/adapter-utils/src/types.ts`.

What it usually does:

1. Read config with `asString`, `asNumber`, `asBoolean`, `asStringArray`, `parseObject`.
2. Build the environment with `buildPaperclipEnv(agent)`. Add `PAPERCLIP_API_KEY` from `ctx.authToken` when present, and `PAPERCLIP_RUN_ID`.
3. Read resume state from `ctx.runtime.sessionParams`.
4. Render the prompt with `renderTemplate(template, data)`.
5. Run the agent with `runChildProcess(runId, command, args, opts)`, or call it with `fetch()`.
6. Parse output for usage, cost, session id and errors.
7. If a resume fails because the session is gone, retry fresh and return `clearSession: true`.

All of these helpers come from `@paperclipai/adapter-utils/server-utils` (`packages/adapter-utils/src/server-utils.ts`). The package root, `@paperclipai/adapter-utils`, exports the types.

### AdapterExecutionContext (main fields)

```ts
interface AdapterExecutionContext {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterType: string | null; adapterConfig: unknown };
  runtime: {
    sessionId: string | null;            // legacy
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
  config: Record<string, unknown>;       // the agent's adapterConfig, secrets resolved
  context: Record<string, unknown>;      // task, wake reason, directives, and so on
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  authToken?: string;                    // set when supportsLocalAgentJwt is true
}
```

### AdapterExecutionResult (main fields)

```ts
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  usage?: UsageSummary;
  sessionParams?: Record<string, unknown> | null;   // stored for the next wake
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
  clearSession?: boolean;                            // start fresh next time
}
```

## Step 3: environment test

`testEnvironment(ctx)` validates the config before a run and powers the **Test** button in the agent's configuration form. Return checks with a `code`, a `level` and a `message`:

| Level | Meaning |
|---|---|
| `error` | The setup cannot work. Overall status `fail`. |
| `warn` | Something may go wrong. Overall status `warn`. |
| `info` | A passing check. |

```ts
return {
  adapterType: ctx.adapterType,
  status: "warn",                      // "pass" | "warn" | "fail"
  checks: [
    { code: "cli_detected", level: "info", message: "my-agent CLI found" },
    { code: "no_key", level: "warn", message: "No API key found", hint: "Set MY_AGENT_API_KEY" },
  ],
  testedAt: new Date().toISOString(),
};
```

## Step 4: UI (built-in only)

- `src/ui/parse-stdout.ts` turns stdout lines into `TranscriptEntry[]` for the run view.
- `src/ui/build-config.ts` turns form values into `adapterConfig`.
- `ui/src/adapters/<name>/config-fields.tsx` and `index.ts` hold the React form and register the UI module.
- `ui/src/adapters/adapter-display-registry.ts` sets the label, icon and picker flags.

An external adapter ships a `ui-parser.js` instead (see the [UI parser contract](/adapters/adapter-ui-parser)), and can return form fields from `getConfigSchema()`.

## Step 5: CLI (built-in only)

`src/cli/format-event.ts` prints a stdout line for `paperclipai heartbeat run`. The built-in adapters use `picocolors`.

```ts
import pc from "picocolors";

export function printMyAgentStreamEvent(line: string, debug: boolean): void {
  if (line.startsWith("[tool-done]")) console.log(pc.green(`  ${line}`));
  else console.log(`  ${line}`);
}
```

## Step 6: register (built-in only)

1. Add the type to `server/src/adapters/builtin-adapter-types.ts` and the module to `server/src/adapters/registry.ts`.
2. Add the UI module to `ui/src/adapters/registry.ts`.
3. Add the formatter to `cli/src/adapters/registry.ts`.

An external adapter registers itself when it is installed.

## Sessions

If the runtime can continue a conversation across heartbeats:

1. Return `sessionParams` from `execute()`, for example `{ sessionId, cwd }`.
2. Read `ctx.runtime.sessionParams` on the next wake and resume.
3. Implement a `sessionCodec` to validate stored state and label it in the UI.

```ts
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return typeof r.sessionId === "string" ? { sessionId: r.sessionId } : null;
  },
  serialize(params) {
    return params?.sessionId ? { sessionId: String(params.sessionId) } : null;
  },
  getDisplayId(params) {
    return params?.sessionId ? String(params.sessionId) : null;
  },
};
```

The built-in CLI adapters store the `cwd` with the session and start fresh when it changes. Copy that if your runtime's sessions are tied to a directory.

## Capability flags

Optional fields on `ServerAdapterModule` that tell the server and UI which features apply to agents on this adapter (`packages/adapter-utils/src/types.ts`):

| Flag | Type | Default | What it controls |
|---|---|---|---|
| `supportsLocalAgentJwt` | boolean | `false` | The heartbeat mints a local agent JWT and passes it as `ctx.authToken`. |
| `supportsInstructionsBundle` | boolean | `false` | The managed instructions bundle (`AGENTS.md`, the agent's [mandate](/concepts/mandates-directives-and-the-agent-bundle)) and its editor in the UI |
| `instructionsPathKey` | string | `"instructionsFilePath"` | The `adapterConfig` key that holds the instructions file path |
| `requiresMaterializedRuntimeSkills` | boolean | `false` | Skill files are written to disk before the run |

`GET /api/adapters` returns these in a `capabilities` object, with two derived flags: `supportsSkills` (true when `listSkills` or `syncSkills` is set) and `supportsModelProfiles`. An external adapter that omits a flag gets `false`.

```ts
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "my_agent",
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}
```

## Skills

Make the agent's skills visible to the runtime without writing into its working directory. The built-in adapters do one of:

1. **A temp directory passed by flag.** `claude_local` builds a per-company bundle and passes it with `--add-dir`.
2. **The runtime's global skills directory.** `codex_local` links into `$CODEX_HOME/skills`; `gemini_local` into `~/.gemini/skills`.
3. **The prompt.** Include skill content in the prompt when the runtime has no skills mechanism.

## Security

- Treat agent output as untrusted. Parse it; never evaluate it.
- Pass secrets through environment variables, not prompts.
- Always enforce a timeout and a grace period.
- An external UI parser runs in a locked-down Web Worker and must have no imports. See the [UI parser contract](/adapters/adapter-ui-parser).

## Next steps

- [External adapters](/adapters/external-adapters)
- [UI parser contract](/adapters/adapter-ui-parser)
- [Heartbeats and runs](/concepts/heartbeats-and-runs)
- [How agents work](/guides/agent-developer/how-agents-work)
