---
title: Adapter UI parser contract
summary: Ship a run-log parser with an external adapter so the AgentDash UI renders its output as a transcript
---

The web UI turns each line of an agent's stdout into transcript entries: assistant text, thinking, tool calls, tool results, system lines. Built-in adapters have parsers compiled into the UI. An external adapter can ship its own as `ui-parser.js`. Without one, the UI uses the generic `process` parser, which shows the output as plain lines.

Source: `server/src/adapters/plugin-loader.ts` (server side), `ui/src/adapters/dynamic-loader.ts` and `ui/src/adapters/sandboxed-parser-worker.ts` (browser side), `TranscriptEntry` in `packages/adapter-utils/src/types.ts`.

## How it loads

1. **Package.** The adapter's `package.json` points `exports["./ui-parser"]` at a built JavaScript file.
2. **Server.** When the plugin loader loads the adapter (at start, install, reload or reinstall), it reads that file and caches the text in memory. On a cache miss it reads it again on demand. A path that resolves outside the package directory is skipped.
3. **Route.** `GET /api/adapters/:type/ui-parser.js` serves the cached text. It returns 404 when the adapter ships no parser.
4. **Browser.** The first time the UI parses output for that adapter type, it fetches the file and starts a dedicated Web Worker. Until the worker is ready, lines go through the fallback parser (the generic one, or the built-in parser when the external adapter overrides a built-in type).
5. **Parsing.** Each line is posted to the worker. Results come back asynchronously, are cached per line, and the transcript re-renders. A line can appear a frame late.

## Contract: package.json

```json
{
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  }
}
```

| Server supports | Adapter declares | Result |
|---|---|---|
| `1.x` | `1.0.0` | Parser served |
| `1.x` | `2.0.0` | Warning logged; no parser served |
| `1.x` | nothing | Parser served, with an info log |

## Contract: module format

The worker does not import your file as an ES module. It evaluates the text as the body of a function:

```js
new Function("exports", "module", "self", "globalThis", '"use strict";\n{\n' + source + "\n}")
```

So:

- **No `import` or `export` statements.** They are a syntax error in a function body, and the parser fails to load.
- **Assign your functions to `exports` or `module.exports`.** If `module.exports` has keys, it wins; otherwise `exports` is used.
- `self` and `globalThis` are `undefined` inside your code.

Compiling `ui-parser.ts` with TypeScript's `"module": "commonjs"` produces this shape (`exports.parseStdoutLine = ...`). Keep the file free of runtime dependencies; nothing else is loaded with it.

## Contract: exports

Export at least one of:

**`parseStdoutLine(line: string, ts: string): TranscriptEntry[]`.** Called for each stdout line. If present, it is used.

**`createStdoutParser(): { parseLine(line, ts): TranscriptEntry[] }`.** Used only when `parseStdoutLine` is absent. The worker calls it once and keeps that one instance for its lifetime, so state carries across all lines the worker sees. `reset()` is not called.

```js
"use strict";
let counter = 0;

function parseStdoutLine(line, ts) {
  const text = line.trim();
  if (!text) return [];
  if (text.startsWith("[my-agent]")) return [{ kind: "system", ts, text }];
  if (text.startsWith("[tool-done]")) {
    const id = "tool-" + ++counter;
    return [
      { kind: "tool_call", ts, name: "shell", input: {}, toolUseId: id },
      { kind: "tool_result", ts, toolUseId: id, content: text, isError: false },
    ];
  }
  return [{ kind: "assistant", ts, text }];
}

exports.parseStdoutLine = parseStdoutLine;
```

## Contract: TranscriptEntry

Each entry is one of these shapes (`packages/adapter-utils/src/types.ts`):

```ts
{ kind: "assistant"; ts: string; text: string; delta?: boolean }
{ kind: "thinking"; ts: string; text: string; delta?: boolean }
{ kind: "user"; ts: string; text: string }
{ kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
{ kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
{ kind: "init"; ts: string; model: string; sessionId: string }
{ kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
{ kind: "stderr"; ts: string; text: string }
{ kind: "system"; ts: string; text: string }
{ kind: "stdout"; ts: string; text: string }
{ kind: "diff"; ts: string; changeType: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation"; text: string }
```

Pair a `tool_call` with its `tool_result` through the same `toolUseId`. Set `isError: true` on a failed tool result.

## The sandbox

The worker removes network, storage and escape APIs before it evaluates your code: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `Worker`, `SharedWorker`, `Blob`, `URL.createObjectURL`, `navigator.sendBeacon`, `BroadcastChannel`, `indexedDB` and others. There is no DOM. Your code can only compute.

Write the parser so that:

- it never throws. A line whose parse throws comes back as no entries, so it vanishes from the transcript. Return `[{ kind: "stdout", ts, text: line }]` for anything you cannot parse.
- the same `(line, ts)` gives the same output. Results are cached per line.
- module-level code only declares and exports functions.

## Failure behavior

| Failure | What happens |
|---|---|
| No `./ui-parser` export, or the route returns 404 | Fallback parser. The type is marked failed and not fetched again. |
| Contract major version not `1` | The server serves no parser. Same as 404. |
| Syntax error, or no usable export | Worker init fails. Fallback parser; marked failed. |
| Worker not ready within 5 seconds | Same as an init failure. |
| A single line throws | That line yields no entries. The parser stays loaded. |

A failed type stays failed until the browser page reloads, or until an admin reloads or reinstalls the adapter from **Instance settings → Adapters**.

## Testing

Run the built file the way the worker does:

```js
// test-parser.mjs
import fs from "node:fs";

const source = fs.readFileSync("./dist/ui-parser.js", "utf8");
const exports = {};
const module = { exports };
new Function("exports", "module", "self", "globalThis", '"use strict";\n{\n' + source + "\n}")(
  exports, module, undefined, undefined,
);
const mod = Object.keys(module.exports).length > 0 ? module.exports : exports;

for (const line of ["[my-agent] start", "[tool-done] ls", "All done."]) {
  console.log(mod.parseStdoutLine(line, new Date().toISOString()));
}
```

```sh
node test-parser.mjs
```

## Skipping the parser

If your adapter prints plain text, leave out `exports["./ui-parser"]`. The generic parser shows each line as output.

## Next steps

- [External adapters](/adapters/external-adapters)
- [Creating an adapter](/adapters/creating-an-adapter)
