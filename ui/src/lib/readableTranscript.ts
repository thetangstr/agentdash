// AgentDash: "Readable" run transcript presentation, modelled on how Claude Code
// shows a session. Pure helpers shared by RunTranscriptView (agent run detail)
// and the issue chat run blocks (issue thread, LiveRunWidget, ActiveAgentsPanel)
// so a run reads the same everywhere:
//   - assistant text is prominent markdown, streaming deltas merged;
//   - each tool call is one line: a verb plus the key argument;
//   - consecutive tool calls with no assistant text between them fold together;
//   - thinking / init / system / stderr / unparsed stdout sit behind one
//     "Details" disclosure, except anything that looks like an error;
//   - the result entry becomes a compact footer.
import { redactCommandText } from "@paperclipai/adapter-utils";
import type { TranscriptEntry } from "../adapters";
import { shouldHideNiceModeStderr, summarizeToolResult } from "./transcriptPresentation";

// ---------------------------------------------------------------------------
// Tool-call one-line summaries
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  /** Leading verb, e.g. "Read", "Ran", "MCP: create_issue". */
  verb: string;
  /** The key argument (path, command, pattern, url...), already shortened. */
  target: string | null;
  /** `verb target` as plain text, for titles and tests. */
  label: string;
  /** True for shell-style tools whose target is a command line. */
  isCommand: boolean;
  /**
   * The whole script, when `target` names it by one line rather than quoting
   * it (a multi-statement script). Absent when `target` already is the command.
   */
  script?: string;
}

const TARGET_MAX = 96;

const SHELL_NAMES = new Set(["bash", "zsh", "sh", "/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeToolKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip `bash -lc '...'`, `/bin/zsh -c "..."` and `cmd /c ...` wrappers. */
export function stripShellWrapper(command: string): string {
  return compactWhitespace(unwrapShell(command));
}

/** `stripShellWrapper` without collapsing whitespace, so a script keeps its lines. */
function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 2; i += 1) {
    const wrapped = current.match(
      /^(?:(?:\/usr)?\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/i,
    ) ?? current.match(/^cmd(?:\.exe)?(?:\s+\/[ds])*\s+\/c\s+([\s\S]+)$/i)
      ?? current.match(/^(?:pwsh|powershell)(?:\.exe)?(?:\s+-\w+)*\s+-c(?:ommand)?\s+([\s\S]+)$/i);
    if (!wrapped) break;
    current = wrapped[1].trim();
    const quoted = current.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) current = quoted[2].trim();
  }
  return current;
}

/** The command text with shell wrappers removed and line breaks kept. */
function rawCommandFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return unwrapShell(value);
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string");
    if (parts.length === 0) return null;
    // Codex shell tool: ["bash", "-lc", "<script>"]
    if (parts.length >= 3 && SHELL_NAMES.has(parts[0]) && /^-l?c$/.test(parts[1])) {
      return unwrapShell(parts.slice(2).join(" "));
    }
    return unwrapShell(parts.join(" "));
  }
  return null;
}

/**
 * Split a script into its statements: one per line, and lines further split on
 * `&&`, `||` and `;` outside quotes. Deliberately simple: it only has to find
 * a good label, never to run anything.
 */
function scriptStatements(script: string): string[] {
  const statements: string[] = [];
  for (const line of script.split(/\r?\n/)) {
    let current = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quote) {
        if (char === quote && line[i - 1] !== "\\") quote = null;
        current += char;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        current += char;
        continue;
      }
      // A comment runs to the end of the line.
      if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
      const pair = line.slice(i, i + 2);
      if (pair === "&&" || pair === "||") {
        statements.push(current);
        current = "";
        i += 1;
        continue;
      }
      if (char === ";") {
        statements.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    statements.push(current);
  }
  return statements.map((statement) => statement.trim()).filter(Boolean);
}

/** Set-up statements that say nothing about what a script is for. */
function isScriptPreamble(statement: string): boolean {
  // set -e, set -euo pipefail, set -o pipefail, set +x
  if (/^set\s+[-+]/.test(statement)) return true;
  if (/^(?:cd|pushd|popd)(?:\s|$)/.test(statement)) return true;
  if (/^(?:export|readonly|local|declare)(?:\s|$)/.test(statement)) return true;
  // A bare assignment (`BASE=…`, several at once) with no command after it.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(statement)) {
    const rest = statement.replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|\S*)\s*)+/,
      "",
    );
    return rest.trim() === "";
  }
  return false;
}

const HEADING_RULE = String.raw`(?:={2,}|-{3,}|#{2,}|\*{3,})`;
const HEADING_PATTERN = new RegExp(String.raw`^\s*${HEADING_RULE}\s*(.+?)\s*${HEADING_RULE}?\s*$`);

/** `echo "=== Checking migrations ==="` gives "Checking migrations". */
function echoHeading(statement: string): string | null {
  const echo = statement.match(/^(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)*(['"]?)([\s\S]*)\1$/);
  if (!echo) return null;
  const body = echo[2].replace(/\\n/g, " ");
  const heading = body.match(HEADING_PATTERN);
  if (!heading) return null;
  const text = heading[1].trim();
  return /[A-Za-z0-9]/.test(text) ? text : null;
}

/**
 * A one-line name for a shell command. A single statement is its own name. A
 * multi-statement script is named by an `echo "=== X ==="` heading when it
 * has one, otherwise by its first statement that does real work, skipping
 * `set -e`, variable assignments, `cd`, and comments (rows used to read
 * "Ran set -e BASE=…").
 *
 * A heading is the agent's own words, not a command, so it is always marked
 * as such ("script: X", read as "Ran script: X"). A friendly heading cannot
 * pass for the command it sits above; the real script is one click away.
 */
export function commandLabel(command: string): string {
  const statements = scriptStatements(command);
  if (statements.length <= 1) return compactWhitespace(command);
  for (const statement of statements) {
    const heading = echoHeading(statement);
    if (heading) return `script: ${compactWhitespace(heading)}`;
  }
  const meaningful = statements.find((statement) => !isScriptPreamble(statement));
  return compactWhitespace(meaningful ?? statements[0]);
}

function unwrapInput(input: unknown): unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return input;
      }
    }
    return input;
  }
  // Issue chat wraps non-object tool inputs as { value: ... }.
  const record = asRecord(input);
  if (record && Object.keys(record).length === 1 && "value" in record) {
    return record.value;
  }
  return input;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return compactWhitespace(value);
  }
  return null;
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath", "target_file", "targetFile", "filename", "file"];
const GENERIC_KEYS = [
  ...PATH_KEYS,
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "skill",
  "name",
  "title",
  "issueId",
  "issue_id",
  "id",
  "target",
];

function patchFiles(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
    const file = match[1]?.trim();
    if (file && !files.includes(file)) files.push(file);
  }
  if (files.length === 0) {
    for (const match of text.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
      const file = match[1]?.trim();
      if (file && file !== "/dev/null" && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

function patchTarget(input: unknown): string | null {
  const record = asRecord(input);
  let text: string | null = typeof input === "string" ? input : null;
  for (const key of ["input", "patch", "diff", "content"]) {
    if (text) break;
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) text = value;
  }
  let files = text ? patchFiles(text) : [];
  if (files.length === 0 && record) {
    const changes = asRecord(record.changes);
    if (changes) files = Object.keys(changes);
    else if (Array.isArray(record.changes)) {
      files = record.changes
        .map((change) => firstString(asRecord(change), PATH_KEYS))
        .filter((file): file is string => Boolean(file));
    }
  }
  if (files.length === 0) return firstString(record, PATH_KEYS);
  if (files.length === 1) return files[0];
  return `${files[0]} +${files.length - 1} more`;
}

function countItems(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

type VerbRule = {
  keys: string[];
  verb: string;
  target: (input: unknown, record: Record<string, unknown> | null) => string | null;
  isCommand?: boolean;
};

const pathTarget: VerbRule["target"] = (input, record) =>
  typeof input === "string" ? compactWhitespace(input) : firstString(record, PATH_KEYS);

const rawCommandTarget = (input: unknown, record: Record<string, unknown> | null): string | null =>
  rawCommandFromValue(input) ??
  rawCommandFromValue(record?.command) ??
  rawCommandFromValue(record?.cmd) ??
  rawCommandFromValue(record?.script);

const commandTarget: VerbRule["target"] = (input, record) => {
  const raw = rawCommandTarget(input, record);
  return raw === null ? null : compactWhitespace(raw);
};

const VERB_RULES: VerbRule[] = [
  { keys: ["read", "readfile", "view", "viewfile", "cat", "openfile"], verb: "Read", target: pathTarget },
  {
    keys: ["edit", "multiedit", "editfile", "strreplace", "strreplaceeditor", "strreplacebasededittool", "notebookedit", "searchreplace"],
    verb: "Edit",
    target: pathTarget,
  },
  { keys: ["write", "writefile", "createfile", "newfile"], verb: "Write", target: pathTarget },
  { keys: ["applypatch", "patch", "filechange"], verb: "Patched", target: (input) => patchTarget(input) },
  {
    keys: ["bash", "shell", "zsh", "commandexecution", "execcommand", "localshell", "shelltoolcall", "runterminalcmd", "runcommand", "terminal", "exec", "powershell"],
    verb: "Ran",
    target: commandTarget,
    isCommand: true,
  },
  {
    keys: ["grep", "rg", "ripgrep", "search", "searchfiles", "grepsearch", "codebasesearch", "searchcode"],
    verb: "Searched",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["pattern", "query", "regex", "q"]),
  },
  {
    keys: ["glob", "findfiles", "filesearch", "find"],
    verb: "Found files",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["pattern", "glob", "query", "name"]),
  },
  { keys: ["ls", "listdir", "listdirectory", "listfiles"], verb: "Listed", target: pathTarget },
  {
    keys: ["webfetch", "fetch", "fetchurl", "browse", "openurl"],
    verb: "Fetched",
    target: (input, record) => (typeof input === "string" ? compactWhitespace(input) : firstString(record, ["url", "uri", "href"])),
  },
  {
    keys: ["websearch", "searchweb", "googlesearch"],
    verb: "Searched web",
    target: (input, record) => (typeof input === "string" ? compactWhitespace(input) : firstString(record, ["query", "q", "search"])),
  },
  {
    keys: ["task", "agent", "dispatchagent", "spawnagent", "subagent"],
    verb: "Delegated",
    target: (input, record) =>
      typeof input === "string" ? compactWhitespace(input) : firstString(record, ["description", "subagent_type", "prompt"]),
  },
  {
    keys: ["todowrite", "todoread", "updateplan", "updatetodos", "todo"],
    verb: "Updated plan",
    target: (_input, record) => {
      const count = countItems(record, ["todos", "plan", "items"]);
      return count === null ? null : `${count} item${count === 1 ? "" : "s"}`;
    },
  },
  { keys: ["skill"], verb: "Skill", target: (input, record) => (typeof input === "string" ? input : firstString(record, ["skill", "name", "command"])) },
  { keys: ["bashoutput", "readshelloutput"], verb: "Checked shell output", target: () => null },
  { keys: ["killshell", "killbash"], verb: "Stopped shell", target: () => null },
];

const VERB_BY_KEY = new Map<string, VerbRule>();
for (const rule of VERB_RULES) {
  for (const key of rule.keys) VERB_BY_KEY.set(key, rule);
}

function finalize(verb: string, target: string | null, isCommand: boolean): ToolCallSummary {
  const shortTarget = target ? truncate(compactWhitespace(target), TARGET_MAX) : null;
  return {
    verb,
    target: shortTarget,
    label: shortTarget ? `${verb} ${shortTarget}` : verb,
    isCommand,
  };
}

// ---------------------------------------------------------------------------
// AgentDash (scan 4 lane O1): readable single commands, never secrets
// ---------------------------------------------------------------------------

const SENSITIVE_HEADER_RE =
  /(\b(?:Proxy-)?Authorization\s*:\s*|\bX-(?:Api-Key|Auth-Token|Paperclip-Token|Agentdash-Token)\s*:\s*|\bCookie\s*:\s*)[^"'\\\n]+/gi;

/**
 * Hide credentials in command text shown to people: Authorization / API-key /
 * Cookie header values, `--token x` style options, `FOO_TOKEN=x` assignments,
 * and well-known key shapes. Applied to every command the readable transcript
 * shows, collapsed or expanded.
 */
export function redactSecrets(text: string): string {
  return redactCommandText(text.replace(SENSITIVE_HEADER_RE, "$1***REDACTED***"));
}

/**
 * Shell-style words of one statement, quotes removed. Stops at an unquoted
 * pipe or redirect: only the command itself matters for a label.
 */
export function shellWords(statement: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < statement.length) current += statement[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && i + 1 < statement.length) {
      current += statement[++i];
      started = true;
      continue;
    }
    if (char === "|" || char === ">" || char === "<") break;
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command"]);
/** Tools whose first positional argument says what they did (`git status`, `pnpm build`). */
const SUBCOMMAND_TOOLS = new Set([
  "git", "gh", "pnpm", "npm", "yarn", "npx", "bun", "deno", "docker", "kubectl", "cargo", "go", "make", "brew",
  "pip", "pip3", "uv", "poetry", "agentdash", "paperclipai",
]);

/** The program a statement runs and its arguments, past env assignments and `sudo`/`env` prefixes. */
function programWords(statement: string): string[] {
  const words = shellWords(statement);
  let index = 0;
  while (index < words.length && (ENV_ASSIGNMENT_RE.test(words[index]) || COMMAND_PREFIXES.has(words[index]))) {
    index += 1;
  }
  return words.slice(index);
}

function basename(word: string): string {
  const parts = word.split("/");
  return parts[parts.length - 1] || word;
}

/** "git status", "pnpm build", "curl", "python3": what a command is, without its arguments. */
export function commandName(statement: string): string {
  const words = programWords(statement);
  if (words.length === 0) return compactWhitespace(statement);
  const program = basename(words[0]);
  if (SUBCOMMAND_TOOLS.has(program)) {
    const sub = words.slice(1).find((word) => !word.startsWith("-"));
    if (sub && /^[A-Za-z0-9][\w:.-]*$/.test(sub)) return `${program} ${sub}`;
  }
  return program;
}

const READABLE_COMMAND_MAX = 60;

/**
 * A single command, as a row label. Short, plain commands read fine as they are
 * ("git status", "pnpm test:run"). Anything long, carrying a URL, or carrying
 * a credential is named by its program instead ("Ran curl"); the full
 * (redacted) command is one click away.
 */
function readableCommand(statement: string): string {
  const compact = compactWhitespace(statement);
  const noisy =
    compact.length > READABLE_COMMAND_MAX
    || /\bhttps?:\/\//i.test(compact)
    || /\/api\//.test(compact)
    || redactSecrets(compact) !== compact;
  return noisy ? commandName(compact) : compact;
}

export interface AgentDashApiCall {
  method: string;
  /** Route template, e.g. "/api/issues/:id/comments". */
  route: string;
  /** An issue key such as "WHI-1", when the URL used one. */
  issueRef: string | null;
  /** Plain-language action such as "Updated issue"; null for routes without one. */
  action: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_REF_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const VARIABLE_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
const PLACEHOLDER_AFTER: Record<string, string> = {
  issues: ":id",
  companies: ":companyId",
  agents: ":agentId",
  comments: ":commentId",
  documents: ":key",
  "work-products": ":workProductId",
  approvals: ":approvalId",
  projects: ":projectId",
  goals: ":goalId",
  runs: ":runId",
};

const AGENTDASH_ACTIONS: Record<string, string> = {
  "GET /api/issues/:id": "Read issue",
  "PATCH /api/issues/:id": "Updated issue",
  "GET /api/issues/:id/comments": "Read the comments on issue",
  "POST /api/issues/:id/comments": "Commented on issue",
  "POST /api/issues/:id/checkout": "Started work on issue",
  "POST /api/issues/:id/release": "Released issue",
  "GET /api/issues/:id/documents": "Read the documents on issue",
  "GET /api/issues/:id/documents/:key": "Read a document on issue",
  "PUT /api/issues/:id/documents/:key": "Saved a document on issue",
  "POST /api/issues/:id/documents/:key": "Saved a document on issue",
  "GET /api/issues/:id/work-products": "Read the results on issue",
  "POST /api/issues/:id/work-products": "Recorded a result on issue",
  "GET /api/issues/:id/heartbeat-context": "Read the brief for issue",
  "POST /api/issues/:id/children": "Created a sub-task under issue",
  "GET /api/agents/me": "Checked its own profile",
  "GET /api/agents/me/inbox-lite": "Checked its inbox",
  "GET /api/agents/me/inbox/mine": "Checked its inbox",
  "GET /api/companies/:companyId/issues": "Listed issues",
  "POST /api/companies/:companyId/issues": "Created an issue",
  "GET /api/companies/:companyId/agents": "Listed the team",
};

const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-o", "--output", "-u", "--user", "-w", "--write-out", "-m", "--max-time", "-b", "--cookie",
  "-c", "--cookie-jar", "-A", "--user-agent", "-e", "--referer", "--connect-timeout", "--retry", "-T",
  "--upload-file", "--cacert", "--cert", "--key", "-x", "--proxy", "--resolve", "-K", "--config",
]);
const CURL_DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form"]);

function isAgentDashBase(base: string): boolean {
  if (base.startsWith("$")) return /PAPERCLIP|AGENTDASH/i.test(base);
  const host = base.replace(/^https?:\/\//i, "").replace(/:\d+$/, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]") return true;
  if (typeof window !== "undefined" && window.location?.hostname) {
    return host === window.location.hostname.toLowerCase();
  }
  return false;
}

/**
 * A `curl` call to the AgentDash API, read back as what it did. Null for
 * anything else (another host, a non-curl command, an unparseable URL).
 */
export function parseAgentDashApiCall(statement: string): AgentDashApiCall | null {
  const words = programWords(statement);
  if (words.length === 0 || basename(words[0]) !== "curl") return null;
  let method: string | null = null;
  let hasData = false;
  let head = false;
  let url: string | null = null;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (word === "-X" || word === "--request") {
      method = words[i + 1]?.toUpperCase() ?? null;
      i += 1;
    } else if (/^-X[A-Za-z]+$/.test(word)) {
      method = word.slice(2).toUpperCase();
    } else if (word.startsWith("--request=")) {
      method = word.slice("--request=".length).toUpperCase();
    } else if (CURL_DATA_FLAGS.has(word)) {
      hasData = true;
      i += 1;
    } else if (/^--(?:data|json|form)[\w-]*=/.test(word)) {
      hasData = true;
    } else if (word === "--url") {
      url = words[i + 1] ?? null;
      i += 1;
    } else if (word === "-I" || word === "--head") {
      head = true;
    } else if (CURL_VALUE_FLAGS.has(word)) {
      i += 1;
    } else if (!word.startsWith("-") && url === null) {
      url = word;
    }
  }
  if (!url) return null;
  const match = url.match(/^(https?:\/\/[^/\s]+|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)(\/api(?:\/[^?#\s]*)?)/i);
  if (!match || !isAgentDashBase(match[1])) return null;
  const segments = match[2].split("/").filter(Boolean);
  let issueRef: string | null = null;
  const template = segments.map((segment, index) => {
    const previous = segments[index - 1] ?? "";
    if (previous === "issues" && ISSUE_REF_RE.test(segment)) issueRef = segment;
    const dynamic =
      UUID_RE.test(segment) || VARIABLE_RE.test(segment) || ISSUE_REF_RE.test(segment) || /^\d+$/.test(segment)
      || previous === "documents";
    if (!dynamic) return segment;
    return PLACEHOLDER_AFTER[previous] ?? ":id";
  });
  const finalMethod = method ?? (head ? "HEAD" : hasData ? "POST" : "GET");
  const route = `/${template.join("/")}`;
  return { method: finalMethod, route, issueRef, action: AGENTDASH_ACTIONS[`${finalMethod} ${route}`] ?? null };
}

function agentDashCallSummary(call: AgentDashApiCall, rawCommand: string): ToolCallSummary {
  const summary = call.action
    ? finalize(call.action, call.action.endsWith("issue") ? call.issueRef : null, true)
    : finalize("Called AgentDash:", `${call.method} ${call.route}`, true);
  return { ...summary, script: redactSecrets(rawCommand.trim()) };
}

/** A shell command's summary: named by `commandLabel`, keeping the script when the name abbreviates it. */
function finalizeCommand(verb: string, rawCommand: string | null): ToolCallSummary {
  if (rawCommand === null) return finalize(verb, null, true);
  const label = commandLabel(rawCommand);
  const isHeading = label.startsWith("script: ");
  if (!isHeading) {
    const call = parseAgentDashApiCall(label);
    if (call) return agentDashCallSummary(call, rawCommand);
  }
  const readable = isHeading ? label : readableCommand(label);
  const summary = finalize(verb, readable, true);
  return readable === compactWhitespace(rawCommand)
    ? summary
    : { ...summary, script: redactSecrets(rawCommand.trim()) };
}

/**
 * One-line summary of a tool call: a verb plus the key argument, derived from
 * the tool name and input. Covers Claude Code tools (Read, Edit, Write, Bash,
 * Grep, Glob, WebFetch, Task, mcp__*), Codex (shell, apply_patch,
 * command_execution) and falls back to the humanized tool name.
 */
export function summarizeToolCall(name: string, rawInput: unknown): ToolCallSummary {
  const toolName = (name || "tool").trim();
  const input = unwrapInput(rawInput);
  const record = asRecord(input);

  if (/^mcp__/i.test(toolName)) {
    const segments = toolName.split("__").filter(Boolean);
    const tool = segments.length >= 3 ? segments.slice(2).join("__") : segments[1] ?? toolName;
    return finalize(`MCP: ${tool}`, firstString(record, GENERIC_KEYS), false);
  }

  const rule = VERB_BY_KEY.get(normalizeToolKey(toolName));
  if (rule) {
    if (rule.isCommand) return finalizeCommand(rule.verb, rawCommandTarget(input, record));
    return finalize(rule.verb, rule.target(input, record), false);
  }

  // Unknown tool that still carries a shell command.
  const command = rawCommandFromValue(record?.command) ?? rawCommandFromValue(record?.cmd);
  if (command) return finalizeCommand("Ran", command);

  const target = typeof input === "string" ? compactWhitespace(input) : firstString(record, GENERIC_KEYS);
  return finalize(humanizeLabel(toolName), target || null, false);
}

// ---------------------------------------------------------------------------
// Tool outcome
// ---------------------------------------------------------------------------

/**
 * "no_result" is a call whose run finished (or stopped streaming) without a
 * tool_result: shown neutral, never as a success.
 */
export type ReadableToolStatus = "running" | "completed" | "error" | "no_result";

/** Status-line text for a tool result: first meaningful line or a short summary. */
export function summarizeToolOutcome(result: string | undefined, status: ReadableToolStatus): string {
  if (status === "running") return result ? summarizeToolResult(result, false, "compact") : "Running…";
  if (status === "no_result") return "No result";
  if (!result || !result.trim()) return status === "error" ? "Failed" : "Done";
  return summarizeToolResult(result, status === "error", "compact");
}

// ---------------------------------------------------------------------------
// Error-looking text (stderr lines that should stay visible)
// ---------------------------------------------------------------------------

export function isErrorLikeText(text: string): boolean {
  const normalized = compactWhitespace(text);
  if (!normalized) return false;
  if (/\b(?:0|no) (?:errors?|failures?)\b/i.test(normalized)) return false;
  if (/^\s*(?:warn(?:ing)?|info|debug|notice)\b[:\]]/i.test(normalized)) return false;
  return /\b(?:error|fatal|exception|traceback|panic(?:ked)?|failed|failure|denied|unauthori[sz]ed|forbidden|segmentation fault)\b/i.test(normalized)
    || /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b/.test(normalized);
}

// ---------------------------------------------------------------------------
// Readable transcript model
// ---------------------------------------------------------------------------

export interface ReadableToolItem {
  key: string;
  ts: string;
  endTs?: string;
  name: string;
  input: unknown;
  summary: ToolCallSummary;
  result?: string;
  status: ReadableToolStatus;
}

export type ReadableDetailKind = "thinking" | "init" | "system" | "stderr" | "stdout";

export interface ReadableDetailLine {
  ts: string;
  kind: ReadableDetailKind;
  text: string;
}

export interface ReadableResultFooter {
  ts: string;
  isError: boolean;
  outcome: string;
  /** Result text, only when it adds something beyond the final assistant message. */
  text: string | null;
  errors: string[];
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export type ReadableBlock =
  | { type: "message"; key: string; role: "assistant" | "user"; ts: string; text: string; streaming: boolean }
  | { type: "tools"; key: string; ts: string; items: ReadableToolItem[] }
  | {
      type: "diff";
      key: string;
      ts: string;
      filePath?: string;
      hunks: Array<{ changeType: Extract<TranscriptEntry, { kind: "diff" }>["changeType"]; text: string }>;
    }
  | { type: "error"; key: string; ts: string; lines: string[] };

export interface ReadableTranscript {
  blocks: ReadableBlock[];
  details: ReadableDetailLine[];
  footer: ReadableResultFooter | null;
}

function joinText(previous: string, next: string): string {
  return previous.endsWith("\n") || next.startsWith("\n") ? `${previous}${next}` : `${previous}\n${next}`;
}

/** Streaming deltas are fragments of one message and concatenate without a separator. */
function appendMessage(previous: string, next: string, delta: boolean): string {
  return delta ? `${previous}${next}` : joinText(previous, next);
}

function parseTime(ts: string | undefined): number | null {
  if (!ts) return null;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

function toolCallId(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of ["toolUseId", "tool_use_id", "callId", "call_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

interface BuilderToolItem extends ReadableToolItem {
  /** toolUseId when the adapter supplied one. */
  id?: string;
  /** True once a tool_result has been matched to this call. */
  resolved: boolean;
}

/**
 * Incremental readable-transcript builder. Entries are pushed one at a time
 * (each push is O(1) apart from merging text), so a streaming run only pays
 * for its new entries; `snapshot()` returns a fresh view of the model.
 *
 * Tool results attach by exact toolUseId first. Only when that fails (an
 * id-less result, or an id no call carries) do they fall back to the most
 * recent call that has no result yet and no id of its own; stdout attaches
 * only to the most recent call, and only while it is an unresolved shell
 * command. Nothing scans backwards through the transcript.
 */
export class ReadableTranscriptBuilder {
  private readonly blocks: ReadableBlock[] = [];
  private readonly details: ReadableDetailLine[] = [];
  private footer: ReadableResultFooter | null = null;
  private readonly toolsById = new Map<string, BuilderToolItem>();
  /** Calls without a tool_result, oldest first. */
  private readonly pending: BuilderToolItem[] = [];
  private lastTool: BuilderToolItem | null = null;
  private lastAssistantText = "";
  private blockSeq = 0;
  private firstTs: number | null = null;
  private count = 0;

  constructor(private readonly streaming: boolean) {}

  get entryCount(): number {
    return this.count;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  private nextKey(prefix: string) {
    return `${prefix}-${this.blockSeq++}`;
  }

  private lastBlock() {
    return this.blocks[this.blocks.length - 1];
  }

  private pushTool(item: BuilderToolItem) {
    const previous = this.lastBlock();
    if (previous?.type === "tools") previous.items.push(item);
    else this.blocks.push({ type: "tools", key: this.nextKey("tools"), ts: item.ts, items: [item] });
    this.lastTool = item;
  }

  private takePending(item: BuilderToolItem) {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i] === item) {
        this.pending.splice(i, 1);
        return;
      }
    }
  }

  private fallbackPending(): BuilderToolItem | undefined {
    // Most recent unresolved call that has no id of its own; calls with an id
    // wait for their exact match.
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (!this.pending[i].id) return this.pending[i];
    }
    return undefined;
  }

  push(entry: TranscriptEntry): void {
    const index = this.count;
    this.count += 1;
    if (this.firstTs === null) this.firstTs = parseTime(entry.ts);

    switch (entry.kind) {
      case "assistant":
      case "user": {
        const previous = this.lastBlock();
        const delta = entry.kind === "assistant" && entry.delta === true;
        const isStreaming = this.streaming && delta;
        if (previous?.type === "message" && previous.role === entry.kind) {
          previous.text = appendMessage(previous.text, entry.text, delta);
          previous.ts = entry.ts;
          previous.streaming = previous.streaming || isStreaming;
        } else {
          this.blocks.push({ type: "message", key: this.nextKey("msg"), role: entry.kind, ts: entry.ts, text: entry.text, streaming: isStreaming });
        }
        if (entry.kind === "assistant") {
          const current = this.lastBlock();
          if (current?.type === "message") this.lastAssistantText = current.text;
        }
        return;
      }
      case "thinking": {
        const previous = this.details[this.details.length - 1];
        if (previous?.kind === "thinking" && entry.delta === true) {
          previous.text += entry.text;
          previous.ts = entry.ts;
        } else {
          this.details.push({ ts: entry.ts, kind: "thinking", text: entry.text });
        }
        return;
      }
      case "tool_call": {
        const id = entry.toolUseId ?? toolCallId(entry.input);
        const item: BuilderToolItem = {
          key: id ? `tool-${id}` : `tool-idx-${index}`,
          id,
          resolved: false,
          ts: entry.ts,
          name: entry.name,
          input: entry.input,
          summary: summarizeToolCall(entry.name, entry.input),
          status: "running",
        };
        if (id) this.toolsById.set(id, item);
        this.pending.push(item);
        this.pushTool(item);
        return;
      }
      case "tool_result": {
        const exact = entry.toolUseId ? this.toolsById.get(entry.toolUseId) : undefined;
        const matched = exact ?? this.fallbackPending();
        if (matched) {
          matched.result = entry.content;
          matched.status = entry.isError ? "error" : "completed";
          matched.endTs = entry.ts;
          matched.resolved = true;
          this.takePending(matched);
        } else {
          const name = entry.toolName ?? "tool";
          this.pushTool({
            key: `tool-result-${entry.toolUseId || "idx"}-${index}`,
            resolved: true,
            ts: entry.ts,
            endTs: entry.ts,
            name,
            input: null,
            summary: summarizeToolCall(name, null),
            result: entry.content,
            status: entry.isError ? "error" : "completed",
          });
        }
        return;
      }
      case "diff": {
        const previous = this.lastBlock();
        if (previous?.type === "diff") {
          if (entry.changeType === "file_header") previous.filePath = entry.text;
          previous.hunks.push({ changeType: entry.changeType, text: entry.text });
        } else {
          this.blocks.push({
            type: "diff",
            key: this.nextKey("diff"),
            ts: entry.ts,
            filePath: entry.changeType === "file_header" ? entry.text : undefined,
            hunks: [{ changeType: entry.changeType, text: entry.text }],
          });
        }
        return;
      }
      case "init":
        this.details.push({
          ts: entry.ts,
          kind: "init",
          text: `model ${entry.model}${entry.sessionId ? ` • session ${entry.sessionId}` : ""}`,
        });
        return;
      case "system":
        if (compactWhitespace(entry.text).toLowerCase() === "turn started") return;
        this.details.push({ ts: entry.ts, kind: "system", text: entry.text });
        return;
      case "stderr": {
        if (shouldHideNiceModeStderr(entry.text)) return;
        if (isErrorLikeText(entry.text)) {
          const previous = this.lastBlock();
          if (previous?.type === "error") previous.lines.push(entry.text);
          else this.blocks.push({ type: "error", key: this.nextKey("err"), ts: entry.ts, lines: [entry.text] });
        } else {
          this.details.push({ ts: entry.ts, kind: "stderr", text: entry.text });
        }
        return;
      }
      case "stdout": {
        // Output streamed while the latest call is an unresolved shell command
        // belongs to that command.
        const last = this.lastTool;
        if (last && !last.resolved && last.summary.isCommand) {
          last.result = last.result ? joinText(last.result, entry.text) : entry.text;
          return;
        }
        const previous = this.details[this.details.length - 1];
        if (previous?.kind === "stdout") {
          previous.text = joinText(previous.text, entry.text);
          previous.ts = entry.ts;
        } else {
          this.details.push({ ts: entry.ts, kind: "stdout", text: entry.text });
        }
        return;
      }
      case "result": {
        const endTs = parseTime(entry.ts);
        const text = entry.text.trim();
        const firstTs = this.firstTs;
        this.footer = {
          ts: entry.ts,
          isError: entry.isError,
          outcome: entry.isError ? "Failed" : "Completed",
          text: text && compactWhitespace(text) !== compactWhitespace(this.lastAssistantText) ? text : null,
          errors: entry.errors ?? [],
          durationMs: firstTs !== null && endTs !== null && endTs >= firstTs ? endTs - firstTs : null,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedTokens: entry.cachedTokens,
          costUsd: entry.costUsd,
        };
        return;
      }
      default:
        return;
    }
  }

  /**
   * A fresh view of the model. Once the run has a result entry, or is no
   * longer streaming, calls still waiting for a result are closed as
   * "no_result" so groups never read "Running N tools" forever.
   */
  snapshot(): ReadableTranscript {
    const closeRunning = this.footer !== null || !this.streaming;
    const toView = (item: ReadableToolItem): ReadableToolItem => {
      const { key, ts, endTs, name, input, summary, result } = item;
      const status = closeRunning && item.status === "running" ? "no_result" : item.status;
      return { key, ts, endTs, name, input, summary, result, status };
    };
    const blocks = this.blocks.map((block): ReadableBlock => {
      if (block.type === "tools") return { ...block, items: block.items.map(toView) };
      if (block.type === "error") return { ...block, lines: [...block.lines] };
      if (block.type === "diff") return { ...block, hunks: [...block.hunks] };
      return { ...block, streaming: block.streaming && !closeRunning };
    });
    return {
      blocks,
      details: this.details.map((line) => ({ ...line })),
      footer: this.footer ? { ...this.footer, errors: [...this.footer.errors] } : null,
    };
  }
}

export function buildReadableTranscript(entries: readonly TranscriptEntry[], streaming = false): ReadableTranscript {
  const builder = new ReadableTranscriptBuilder(streaming);
  for (const entry of entries) builder.push(entry);
  return builder.snapshot();
}

function entryFingerprint(entry: TranscriptEntry | undefined): string {
  if (!entry) return "";
  const body =
    entry.kind === "tool_call"
      ? `${entry.name}:${entry.toolUseId ?? ""}`
      : entry.kind === "tool_result"
        ? `${entry.toolUseId}:${entry.isError}:${entry.content.length}`
        : entry.kind === "init"
          ? `${entry.model}:${entry.sessionId}`
          : entry.kind === "result"
            ? `${entry.isError}:${entry.text.length}`
            : `${entry.text.length}:${entry.text.slice(-32)}`;
  return `${entry.kind}|${entry.ts}|${body}`;
}

export interface ReadableTranscriptCache {
  builder: ReadableTranscriptBuilder;
  first: string;
  last: string;
}

/**
 * Feed only the entries added since the cached build when the new list
 * extends the old one (same first entry, same entry at the old end); otherwise
 * rebuild. The live transcript hooks re-parse chunks into fresh objects on each
 * poll, so the check compares entry fingerprints, not identity, and costs O(1).
 */
export function updateReadableTranscript(
  cache: ReadableTranscriptCache | null,
  entries: readonly TranscriptEntry[],
  streaming: boolean,
): { cache: ReadableTranscriptCache; transcript: ReadableTranscript } {
  const previousCount = cache?.builder.entryCount ?? 0;
  const canExtend =
    cache !== null
    && cache.builder.isStreaming === streaming
    && previousCount > 0
    && entries.length >= previousCount
    && entryFingerprint(entries[0]) === cache.first
    && entryFingerprint(entries[previousCount - 1]) === cache.last;
  const builder = canExtend ? cache.builder : new ReadableTranscriptBuilder(streaming);
  for (let i = canExtend ? previousCount : 0; i < entries.length; i += 1) builder.push(entries[i]);
  return {
    cache: {
      builder,
      first: entryFingerprint(entries[0]),
      last: entryFingerprint(entries[entries.length - 1]),
    },
    transcript: builder.snapshot(),
  };
}

export function formatRunDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Group header for folded consecutive tool calls, e.g. "Ran 6 tools". */
export function toolGroupLabel(items: readonly Pick<ReadableToolItem, "status">[]): string {
  const running = items.some((item) => item.status === "running");
  const count = items.length;
  return `${running ? "Running" : "Ran"} ${count} tool${count === 1 ? "" : "s"}`;
}
