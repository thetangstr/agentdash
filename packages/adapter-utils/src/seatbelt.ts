import { accessSync, constants } from "node:fs";

/**
 * macOS Seatbelt containment, shared by every path that runs agent-authored code.
 *
 * This lived in `cli/src/bridge/sandbox.ts` and was reachable only from the
 * bridge worker — the server's own execution path ran agents with no
 * confinement at all. It moved here rather than being copied, because a
 * security check with two copies is one that will eventually disagree with
 * itself, and the disagreement is discovered by the person it failed.
 *
 * The profile is not a guess. It is the shape a containment spike validated on
 * macOS 26.6 (16/16 tests, see
 * `doc/plans/2026-07-31-bridge-containment-spike.md`). Three facts from that
 * spike are load-bearing and must survive any edit here:
 *
 *   1. Whole-filesystem `(deny default)` starves dyld and the process dies on
 *      SIGABRT before `main`. The deployable shape inverts it: allow the
 *      system, deny the human, re-open the workspace.
 *   2. Later rules win in SBPL. The workspace allow MUST come after the home
 *      deny or the workspace is unreachable and nothing runs.
 *   3. With home denied, `getcwd` fails from anywhere inside it. The child has
 *      to be placed in the workspace as part of spawning, not by a first
 *      command that has already lost its footing.
 *
 * Seatbelt constrains *subprocesses*. An agent CLI's own in-process tools
 * answer to its permission system, not to this file. Neither layer substitutes
 * for the other.
 */

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** macOS name resolution goes through this socket; `(deny network*)` closes it. */
export const MDNSRESPONDER_SOCKET = "/private/var/run/mDNSResponder";

export const EGRESS_POLICIES = ["loopback", "direct"] as const;
export type EgressPolicy = (typeof EGRESS_POLICIES)[number];

export const EGRESS_REQUIRED_MESSAGE =
  "Refusing to start: --egress is required and has no default.\n" +
  "  --egress loopback  Deny all egress, allow loopback only. Reaching the Anthropic\n" +
  "                     API requires a local allowlisting proxy. This is the posture\n" +
  "                     the containment spike validated.\n" +
  "  --egress direct    Additionally allow outbound 443 so the agent can reach\n" +
  "                     api.anthropic.com unmediated. Weaker: no proxy sees the\n" +
  "                     traffic and no allowlist constrains the destination.\n" +
  "There is no safe default here, so the choice is yours to make explicitly.";

export function parseEgressPolicy(value: string | undefined | null): EgressPolicy {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(EGRESS_REQUIRED_MESSAGE);
  if (!(EGRESS_POLICIES as readonly string[]).includes(trimmed)) {
    throw new Error(
      `Refusing to start: unknown egress policy "${trimmed}". Expected one of: ${EGRESS_POLICIES.join(", ")}.`,
    );
  }
  return trimmed as EgressPolicy;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single most important safety property here.
 *
 * A caller that silently drops confinement is worse than one that will not
 * start, because the operator believes the containment is there. There is
 * deliberately no fallback path, no `--no-sandbox`, and no "best effort" mode.
 */
export function assertSandboxSupported(
  opts: { platform?: NodeJS.Platform; isExecutable?: (path: string) => boolean } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      `Refusing to start: sandboxed execution requires macOS (darwin) and this host is "${platform}".\n` +
        "Containment relies on macOS Seatbelt (sandbox-exec). There is no unsandboxed\n" +
        "fallback: running agent-authored code without confinement is the failure this\n" +
        "exists to prevent.",
    );
  }
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  if (!isExecutable(SANDBOX_EXEC_PATH)) {
    throw new Error(
      `Refusing to start: ${SANDBOX_EXEC_PATH} is not executable on this host.\n` +
        "Without it nothing can be confined, and tasks will not be run unconfined.",
    );
  }
}

/** SBPL string literals have no escape syntax worth trusting. Reject, don't quote. */
function sbplLiteralPath(label: string, value: string): string {
  if (!value.startsWith("/")) {
    throw new Error(`Refusing to build a sandbox profile: ${label} must be an absolute path (got "${value}").`);
  }
  if (/["\\\n\r]/.test(value)) {
    throw new Error(
      `Refusing to build a sandbox profile: ${label} contains a character that cannot be represented ` +
        `safely in an SBPL string literal (got "${value}").`,
    );
  }
  return value;
}

/**
 * Refuse a re-opening that would swallow the home deny.
 *
 * Later rules win in SBPL, so `readWritePaths: ["/Users/yang"]` — or a
 * synthetic home pointed at the real one — emits a profile that parses,
 * loads, reports no error, and confines nothing. That is the worst failure
 * this file has: the operator believes the sandbox is on. The listed
 * re-openings are the operator-configured surface where a typo does it, so
 * they are checked. Throwing here is safe by construction, because there is
 * no path that catches it and proceeds unconfined.
 */
function assertNotAncestorOfHome(label: string, home: string, candidate: string): void {
  // Trailing slashes stripped on BOTH sides first. "/" would otherwise compare
  // as "//" and the single most catastrophic value sails through, and
  // "/Users/x/" would not equal "/Users/x".
  const trimmedHome = home.replace(/\/+$/, "");
  const trimmed = candidate.replace(/\/+$/, "");
  if (trimmed === trimmedHome || trimmedHome.startsWith(`${trimmed}/`)) {
    throw new Error(
      `Refusing to build a sandbox profile: ${label} ("${candidate}") is the home directory ` +
        `being denied ("${home}") or an ancestor of it. Re-opening it below the deny would ` +
        "silently disable the confinement while still reporting success. Name the specific " +
        "subdirectory the agent needs instead.",
    );
  }
}

export function buildSandboxProfile(opts: {
  homeDir: string;
  workspaceDir: string;
  egress: EgressPolicy;
  /**
   * Absolute paths of the agent binary, symlinks resolved.
   *
   * Without these the child cannot run at all on a standard install. Claude
   * Code puts its binary at `~/.local/bin/claude`, a symlink into
   * `~/.local/share/claude/versions/…` — both inside the home directory this
   * profile denies. The result is `execvp() of 'claude' failed: No such file or
   * directory` on every task, which reads like a PATH problem and is not one.
   *
   * Re-opening exactly the binary we were told to execute widens nothing: the
   * task was always going to run that program. What stays denied is everything
   * it might have read — documents, keys, repositories, the rest of home.
   */
  execPaths?: string[];
  /**
   * Extra absolute paths to re-open read-write below the home deny.
   *
   * The server path needs this and the bridge did not. An agent's runtime state
   * — its instructions bundle, its session files — lives outside the execution
   * workspace, and denying it makes every run fail on its first read. Each
   * entry is a deliberate hole, so callers pass the narrowest set they can and
   * the list is written into the profile where an operator can read it back.
   */
  readWritePaths?: string[];
  /**
   * Extra absolute paths re-opened READ-ONLY (and executable) below the home
   * deny — an agent's own runtime: its interpreter, its libraries, its entry
   * script.
   *
   * Separate from `readWritePaths` on purpose, and the distinction is the
   * whole point. The hermes wrapper at `~/.local/bin/hermes` execs a Python
   * venv under `~/.hermes/`, so confinement without this fails at exec with
   * code 126 — measured on uat, not predicted. The lazy fix is to add that
   * tree to `readWritePaths`; that would hand the agent WRITE access to the
   * interpreter it is about to run, so a compromised run could rewrite its
   * own runtime and every later run would execute the result. Read-only
   * closes the hole the agent needs without opening the one it does not.
   */
  readOnlyPaths?: string[];
  /**
   * A directory handed to the child as its `HOME`, re-opened read-write below
   * the home deny.
   *
   * The problem this solves is narrow and was measured, not imagined. Web
   * search runs through `mcporter`, and `mcporter` — like most CLIs — probes
   * `$HOME` for configuration on startup. Confined, it died on
   * `EPERM open '/Users/yang/.claude/settings.json'`: the sandbox correctly
   * refusing the OPERATOR's personal Claude Code config to an agent. The
   * tempting fix is to allow `~/.claude`, which hands every agent the
   * operator's config, their MCP server list and whatever credentials sit
   * beside it. That is a much larger hole than the one being closed.
   *
   * A synthetic home closes it from the other side. The child's `HOME` points
   * at a directory that contains only what a tool legitimately needs, so the
   * probe for `~/.claude` finds NOTHING rather than finding the operator's
   * file — no allow rule is added, and the real home stays denied. Anything
   * the agent genuinely needs is placed in there deliberately, by the
   * operator, one entry at a time.
   *
   * Symlinks inside it resolve to their targets, and SBPL matches the
   * RESOLVED path, so `agent-home/.hermes -> ~/.hermes` reaches the real
   * hermes state only because `~/.hermes` is separately re-opened above.
   * A link to something not on the allowlist stays denied — verified, not
   * assumed.
   */
  syntheticHomeDir?: string;
}): string {
  const home = sbplLiteralPath("homeDir", opts.homeDir);
  const workspace = sbplLiteralPath("workspaceDir", opts.workspaceDir);
  const execAllows = (opts.execPaths ?? [])
    .map((candidate, index) => sbplLiteralPath(`execPaths[${index}]`, candidate))
    .flatMap((literal) => [
      `(allow file-read* (literal "${literal}"))`,
      `(allow process-exec (literal "${literal}"))`,
    ]);
  const extraWriteAllows = (opts.readWritePaths ?? [])
    .map((candidate, index) => sbplLiteralPath(`readWritePaths[${index}]`, candidate))
    .map((literal, index) => {
      assertNotAncestorOfHome(`readWritePaths[${index}]`, home, literal);
      return `(allow file-read* file-write* (subpath "${literal}"))`;
    });
  const syntheticHome = opts.syntheticHomeDir
    ? sbplLiteralPath("syntheticHomeDir", opts.syntheticHomeDir)
    : null;
  if (syntheticHome) assertNotAncestorOfHome("syntheticHomeDir", home, syntheticHome);
  const syntheticHomeAllows = syntheticHome
    ? [`(allow file-read* file-write* (subpath "${syntheticHome}"))`]
    : [];
  const extraReadAllows = (opts.readOnlyPaths ?? [])
    .map((candidate, index) => sbplLiteralPath(`readOnlyPaths[${index}]`, candidate))
    .flatMap((literal, index) => {
      assertNotAncestorOfHome(`readOnlyPaths[${index}]`, home, literal);
      return [
        `(allow file-read* (subpath "${literal}"))`,
        `(allow process-exec (subpath "${literal}"))`,
      ];
    });

  /**
   * Every ancestor directory of every re-opened path, metadata only.
   *
   * `realpath()` resolves a path one component at a time, so allowing
   * `~/.local/bin/mcporter` is useless if `~` and `~/.local` cannot be
   * stat'ed — the call fails at the first denied component. Computed rather
   * than hand-listed so a new re-opened path cannot silently be unreachable.
   */
  const ancestorMetadataAllows = (() => {
    const roots = [
      opts.homeDir,
      ...(opts.readOnlyPaths ?? []),
      ...(opts.readWritePaths ?? []),
      ...(opts.execPaths ?? []),
      ...(opts.syntheticHomeDir ? [opts.syntheticHomeDir] : []),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const ancestors = new Set<string>();
    for (const entry of roots) {
      let current = entry;
      // Walk up to "/", recording each directory on the way.
      while (current && current !== "/" && current !== ".") {
        ancestors.add(current);
        const next = current.slice(0, current.lastIndexOf("/"));
        if (!next || next === current) break;
        current = next;
      }
    }
    return [...ancestors]
      .sort()
      .map((entry, index) => sbplLiteralPath(`ancestor[${index}]`, entry))
      .map((literal) => `(allow file-read-metadata (literal "${literal}"))`);
  })();

  const egressLines =
    opts.egress === "loopback"
      ? [
          ";; Deny all egress, then re-open loopback only. A local allowlisting proxy",
          ";; decides which domains are reachable; the sandbox guarantees nothing can",
          ";; route around that proxy — not by raw IP, not to a LAN peer.",
          "(deny network*)",
          '(allow network-outbound (remote ip "localhost:*"))',
          '(allow network-bind    (local  ip "localhost:*"))',
        ]
      : [
          ";; WEAKER POSTURE. Deny all egress, then re-open outbound 443 so the agent",
          ";; can reach a model provider with no proxy in front of it. Nothing",
          ";; inspects or allowlists that traffic, and any other 443 host is reachable",
          ";; too. Chosen explicitly.",
          "(deny network*)",
          '(allow network-outbound (remote ip "*:443"))',
          ";; Loopback, under THIS policy too. A server-side agent calls the local",
          ";; AgentDash API back on 127.0.0.1:<port> — without this it cannot report",
          ";; what it did, and the run fails in a way that looks like the model was",
          ";; unreachable. The bridge worker never needed it because its task talked",
          ";; only outward; the server path is the case that does.",
          ";; This widens nothing meaningful: the agent already holds a key for that",
          ";; endpoint, and reaching it is the entire point of running it.",
          '(allow network-outbound (remote ip "localhost:*"))',
          '(allow network-bind    (local  ip "localhost:*"))',
          ";; DNS. Do not remove: `(deny network*)` also closes the mDNSResponder",
          ";; socket, and without it every hostname fails to resolve — the 443 allow",
          ";; above is then useless and this mode silently does nothing. Verified:",
          ";; raw-IP 443 succeeds without it, api.anthropic.com does not.",
          ";; Unnecessary under loopback, where the proxy resolves on the task's behalf.",
          `(allow network-outbound (literal "${MDNSRESPONDER_SOCKET}"))`,
        ];

  return [
    "(version 1)",
    "(allow default)",
    "",
    ";; Deny the operator's home, then re-open only this task's workspace.",
    ";; ORDER IS LOAD-BEARING: later rules win in SBPL, so the workspace allow must",
    ";; stay below the home deny. The home deny is not a dial — it is present under",
    ";; every egress policy, always.",
    `(deny file-read* file-write* (subpath "${home}"))`,
    ";; Metadata-only on the ANCESTOR DIRECTORIES of every path re-opened",
    ";; below. Not a convenience — realpath() walks each component in turn, so",
    ";; a tool living at ~/.local/bin/x is unreachable unless ~ and ~/.local",
    ";; can be stat'ed, and Node dies with EPERM before running a line of user",
    ";; code (measured: mcporter, the MCP client agents use for web search).",
    ";; This grants stat on directory ENTRIES only — names, sizes and contents",
    ";; underneath stay denied by the rule above, so it opens nothing the",
    ";; allowlist has not already opened deliberately.",
    ...ancestorMetadataAllows,
    `(allow file-read* file-write* (subpath "${workspace}"))`,
    ...(extraWriteAllows.length
      ? [
          "",
          ";; Runtime state the agent needs outside its execution workspace. Each of",
          ";; these is a deliberate hole in the home deny above.",
          ...extraWriteAllows,
        ]
      : []),
    ...(syntheticHomeAllows.length
      ? [
          "",
          ";; The child's HOME. Not the operator's — that one stays denied above.",
          ";; A tool that probes $HOME for config (mcporter does, on every run)",
          ";; finds this directory's contents instead of the operator's, so the",
          ";; probe fails to find a file rather than succeeding at reading a",
          ";; private one. Write is allowed because tools cache and lock in here;",
          ";; what is IN it is the operator's decision, entry by entry.",
          ...syntheticHomeAllows,
        ]
      : []),
    ...(extraReadAllows.length
      ? [
          "",
          ";; The agent's own runtime — interpreter, libraries, entry script — read",
          ";; and execute but NEVER write. Deliberately not folded into the",
          ";; read-write list above: an agent that can rewrite the interpreter it is",
          ";; about to run has escaped, slowly.",
          ...extraReadAllows,
        ]
      : []),
    ...(execAllows.length
      ? [
          "",
          ";; The agent binary itself, symlinks resolved. It usually lives inside the",
          ";; home directory denied above, and denying the program we were asked to run",
          ";; makes every task fail before it starts.",
          ...execAllows,
        ]
      : []),
    "",
    ...egressLines,
    "",
  ].join("\n");
}
