/**
 * `agentdash-connect watch` — keeping work moving between sessions.
 *
 * The inbox is otherwise read only when a session starts in its folder, so a
 * hand-off can sit for a day because nobody opened Claude. This is the opt-in
 * nudge: a per-user launchd agent on macOS runs `watch --once` on a schedule
 * (every 15 minutes unless the person picks another interval). Each run asks
 * the person's own AgentDash instance for `work/list`, and for each new item
 * shows one macOS notification ("Agent B finished a first pass on ACME-41;
 * your review is ready"). It talks to nothing else: no npm registry (it runs
 * a copy of this package kept in ~/.agentdash, not npx), no email, no other
 * service. The notification is local, through `osascript`.
 *
 * A notification carries the issue identifier and the agent's name only,
 * never a title or any other text an agent wrote: it shows on a lock screen,
 * and the review belongs in the session.
 *
 * Notify once per item: what was notified is kept in a small state file,
 * keyed by the issue and what it waits on, so the same hand-off never
 * notifies twice, and a new one on the same issue (a question after a
 * review, say) does. An item that leaves the list is forgotten, so if it
 * comes back it notifies again.
 *
 * Off by default, everywhere. The connect flow asks before installing it, on
 * a terminal only. Scheduled pre-review (pre-review.mjs) is a separate flag,
 * also off by default. Linux and Windows: a message, nothing installed.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { defaultInboxDir, oneLine, packagedCoworkerSkill, resolveBridgeToken, resolveInboxServer } from "./inbox.mjs";
import { findClaude, runPreReview } from "./pre-review.mjs";

export const WATCH_LABEL = "com.agentdash.connect.watch";

/** Off unless the person turns it on; the pre-review is a second, separate yes. */
export const WATCH_DEFAULTS = Object.freeze({
  enabled: false,
  preReview: false,
  intervalMinutes: 15,
  preReviewMaxPerRun: 2,
});

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/** More new items than this in one run become one summary notification. */
export const MAX_SINGLE_NOTIFICATIONS = 3;

const FETCH_TIMEOUT_MS = 15_000;
const LOG_CAP_BYTES = 1024 * 1024;

const agentdashDir = (home) => path.join(home, ".agentdash");

/** Every path the watcher reads or writes, from one home directory (tests pass a temp one). */
export function watchPaths(home = os.homedir()) {
  return {
    config: path.join(agentdashDir(home), "watch.json"),
    state: path.join(agentdashDir(home), "watch-state.json"),
    log: path.join(agentdashDir(home), "watch.log"),
    runtime: path.join(agentdashDir(home), "connect-runtime"),
    plist: path.join(home, "Library", "LaunchAgents", `${WATCH_LABEL}.plist`),
  };
}

/** A whole number of minutes in range, or null. */
export function parseIntervalMinutes(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) return null;
  return n;
}

/** The config on disk over the defaults; anything malformed falls back to the default (off). */
export function readWatchConfig(file) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  const config = { ...WATCH_DEFAULTS };
  if (!raw || typeof raw !== "object") return config;
  if (raw.enabled === true) config.enabled = true;
  if (raw.preReview === true) config.preReview = true;
  const interval = parseIntervalMinutes(raw.intervalMinutes);
  if (interval) config.intervalMinutes = interval;
  if (Number.isInteger(raw.preReviewMaxPerRun) && raw.preReviewMaxPerRun >= 1 && raw.preReviewMaxPerRun <= 10) {
    config.preReviewMaxPerRun = raw.preReviewMaxPerRun;
  }
  if (typeof raw.server === "string" && raw.server.trim()) config.server = raw.server.trim();
  if (typeof raw.claudePath === "string" && raw.claudePath.trim()) config.claudePath = raw.claudePath.trim();
  if (typeof raw.maxBudgetUsd === "number" && raw.maxBudgetUsd > 0) config.maxBudgetUsd = raw.maxBudgetUsd;
  return config;
}

function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
}

export function writeWatchConfig(file, config) {
  writePrivateJson(file, config);
}

/** `{ notified: { key: iso }, preReviewed: { key: { at, ok } } }`; empty when absent or unreadable. */
export function readWatchState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      notified: raw && typeof raw.notified === "object" && raw.notified ? raw.notified : {},
      preReviewed: raw && typeof raw.preReviewed === "object" && raw.preReviewed ? raw.preReviewed : {},
    };
  } catch {
    return { notified: {}, preReviewed: {} };
  }
}

// ------------------------------------------------------------------- plist

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The per-user launchd agent. `StartInterval` is launchd's own schedule, so
 * nothing stays running between checks; `RunAtLoad` checks once right after
 * install so the person sees it work.
 */
export function launchdPlist({ programArguments, intervalMinutes, logPath, env = {} }) {
  const interval = parseIntervalMinutes(intervalMinutes);
  if (!interval) throw new Error(`The interval must be ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes`);
  const strings = (items, indent) => items.map((item) => `${indent}<string>${xmlEscape(item)}</string>`).join("\n");
  const envEntries = Object.entries(env)
    .map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${WATCH_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    strings(programArguments, "\t\t"),
    "\t</array>",
    "\t<key>StartInterval</key>",
    `\t<integer>${interval * 60}</integer>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>ProcessType</key>",
    "\t<string>Background</string>",
    "\t<key>LowPriorityIO</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xmlEscape(logPath)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xmlEscape(logPath)}</string>`,
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    envEntries,
    "\t</dict>",
    "</dict>",
    "</plist>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}

// ------------------------------------------------------------------ alerts

const ref = (identifier) => (identifier ? oneLine(String(identifier), 40) : "an issue");

/**
 * What in a `work/list` answer could be a notification: each hand-off, and
 * each delivered result of the person's own requests. `complete` says which
 * lists were whole (not cut by the limit), so state for an item past the
 * cut is kept rather than forgotten and re-notified.
 */
export function alertsFromWorkList(body) {
  const alerts = [];
  const handoffs = body?.handoffs ?? { items: [] };
  for (const item of handoffs.items ?? []) {
    if (!item || typeof item.issueId !== "string") continue;
    const waitingOn = Array.isArray(item.waitingOn) ? [...item.waitingOn].map(String).sort() : [];
    alerts.push({
      key: `handoff:${item.issueId}:${waitingOn.join("+") || "waiting"}`,
      kind: "handoff",
      issueId: item.issueId,
      identifier: typeof item.identifier === "string" ? item.identifier : null,
      agentName: typeof item.agentName === "string" ? item.agentName : null,
      waitingOn,
    });
  }
  const delivered = body?.requests?.delivered ?? { items: [] };
  for (const item of delivered.items ?? []) {
    if (!item || typeof item.issueId !== "string") continue;
    alerts.push({
      key: `request:${item.issueId}:${typeof item.waitingOn?.why === "string" ? item.waitingOn.why : "delivered"}`,
      kind: "request",
      issueId: item.issueId,
      identifier: typeof item.identifier === "string" ? item.identifier : null,
      requestedOf: typeof item.requestedOf === "string" ? item.requestedOf : null,
    });
  }
  return {
    alerts,
    complete: {
      handoff: handoffs.truncated !== true,
      // No `requests` at all (an older instance, or the section refused): nothing to forget.
      request: body?.requests ? delivered.truncated !== true && body.requests.scanTruncated !== true : false,
    },
  };
}

/**
 * Which alerts are new, and the state to keep. An alert is new when its key
 * was never notified. Keys of items that left a complete list are dropped, so
 * a later return notifies again; keys in a cut list are kept.
 */
export function diffAlerts(state, alerts, complete = { handoff: true, request: true }) {
  const notified = { ...(state?.notified ?? {}) };
  const preReviewed = { ...(state?.preReviewed ?? {}) };
  const current = new Set(alerts.map((alert) => alert.key));
  const family = (key) => key.split(":")[0];
  for (const store of [notified, preReviewed]) {
    for (const key of Object.keys(store)) {
      if (!current.has(key) && complete[family(key)] === true) delete store[key];
    }
  }
  const fresh = alerts.filter((alert) => !notified[alert.key]);
  return { fresh, next: { notified, preReviewed } };
}

/** The notification text for one alert. Identifier and agent name only. */
export function alertMessage(alert, { preReviewed = false } = {}) {
  const issue = ref(alert.identifier);
  if (alert.kind === "request") {
    const from = alert.requestedOf ? ` from ${oneLine(alert.requestedOf, 60)}` : "";
    return `Your request ${issue} is back${from}: accept it or ask for changes.`;
  }
  const agent = alert.agentName ? oneLine(alert.agentName, 60) : "Your agent";
  const on = new Set(alert.waitingOn ?? []);
  let text;
  if (on.has("approval")) text = `${agent} needs your decision on ${issue}`;
  else if (on.has("question")) text = `${agent} finished a first pass on ${issue} and asked you a question; your review is ready`;
  else if (on.has("blocked")) text = `${agent} is blocked on ${issue} and needs you`;
  else text = `${agent} finished a first pass on ${issue}; your review is ready`;
  return `${text}.${preReviewed ? " Claude prepared a first take in your inbox folder." : ""}`;
}

/**
 * The notifications for one run: one per new item, or a single summary when
 * there are more than MAX_SINGLE_NOTIFICATIONS (the first run after install
 * can find a backlog, and ten banners at once help nobody).
 */
export function planNotifications(fresh, { preReviewedKeys = new Set() } = {}) {
  if (fresh.length === 0) return [];
  if (fresh.length > MAX_SINGLE_NOTIFICATIONS) {
    const handoffs = fresh.filter((alert) => alert.kind === "handoff").length;
    const requests = fresh.length - handoffs;
    const parts = [
      handoffs ? `${handoffs} hand-off${handoffs === 1 ? "" : "s"} from your agents` : null,
      requests ? `${requests} result${requests === 1 ? "" : "s"} of your requests` : null,
    ].filter(Boolean);
    return [
      {
        keys: fresh.map((alert) => alert.key),
        title: "AgentDash",
        message: `${fresh.length} new items are waiting on you: ${parts.join(" and ")}. Open your inbox folder in Claude to review them.`,
      },
    ];
  }
  return fresh.map((alert) => ({
    keys: [alert.key],
    title: "AgentDash",
    message: alertMessage(alert, { preReviewed: preReviewedKeys.has(alert.key) }),
  }));
}

/**
 * `osascript` arguments for one notification. The text travels as script
 * arguments (`argv`), never inside the script source, so nothing in a name
 * can change what the script does. The constant title comes first, so no
 * argument that could start with a dash is the first one osascript sees.
 */
export function notificationArgs({ title, message }) {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e",
    "end run",
    String(title),
    String(message),
  ];
}

// --------------------------------------------------------------- one check

function stamp(now) {
  return now().toISOString();
}

/** Keep the launchd log small: it is truncated once it passes LOG_CAP_BYTES. */
function capLog(logPath) {
  try {
    if (statSync(logPath).size > LOG_CAP_BYTES) truncateSync(logPath, 0);
  } catch {
    // No log yet.
  }
}

/** How the pre-review starts this package's own `mcp`: this node, this copy's bin. */
export function selfLaunch() {
  return { command: process.execPath, args: [fileURLToPath(new URL("../bin/agentdash-connect.mjs", import.meta.url))] };
}

/**
 * One check: what launchd runs. Returns an exit code; every failure is logged
 * and returns 1, and none of them notifies.
 */
export async function runWatchOnce(opts = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const errorLog = deps.errorLog ?? ((line) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const run = deps.run ?? spawnSync;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const paths = deps.paths ?? watchPaths(deps.home);

  if (platform !== "darwin") {
    log(NOT_MAC_MESSAGE);
    return 0;
  }
  capLog(paths.log);

  const config = readWatchConfig(paths.config);
  if (!config.enabled) {
    log(`${stamp(now)} watch is not turned on; nothing checked. Turn it on with: npx agentdash-connect watch --install`);
    return 0;
  }

  let server;
  let token;
  try {
    server = resolveInboxServer({ server: opts.server ?? config.server, claudeConfigPath: deps.claudeConfigPath });
    token = resolveBridgeToken({ tokenFile: opts.tokenFile ?? deps.tokenFile });
  } catch (err) {
    errorLog(`${stamp(now)} ${err?.message ?? String(err)}`);
    return 1;
  }

  let body;
  try {
    const res = await fetchImpl(`${server}/api/bridge/work/list`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 50 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      errorLog(`${stamp(now)} AgentDash answered ${res.status}: ${text.slice(0, 200)}`);
      return 1;
    }
    body = await res.json();
  } catch (err) {
    errorLog(`${stamp(now)} AgentDash unreachable at ${server}: ${err?.message ?? String(err)}`);
    return 1;
  }
  if (body?.ok === false) {
    errorLog(`${stamp(now)} AgentDash did not list your work: ${oneLine(String(body.reason ?? body.code ?? "refused"), 300)}`);
    return 1;
  }

  const { alerts, complete } = alertsFromWorkList(body);
  const { fresh, next } = diffAlerts(readWatchState(paths.state), alerts, complete);

  // Pre-review first, so a notification can say the take is ready. Bounded
  // per run; an attempt is recorded either way, so a failing item is not
  // retried (and paid for) every interval.
  const preReviewedKeys = new Set();
  if (config.preReview) {
    const inboxDir = deps.inboxDir ?? defaultInboxDir();
    const queue = alerts.filter((alert) => alert.kind === "handoff" && !next.preReviewed[alert.key]);
    const ctx = {
      claudePath: findClaude({ configured: config.claudePath }),
      inboxDir,
      server,
      mcpLaunch: deps.mcpLaunch ?? selfLaunch(),
      maxBudgetUsd: config.maxBudgetUsd,
      readSkill: () => {
        const local = path.join(inboxDir, ".claude", "skills", "agentdash-coworker", "SKILL.md");
        return existsSync(local) ? readFileSync(local, "utf8") : packagedCoworkerSkill();
      },
      ...(deps.preReviewCtx ?? {}),
    };
    for (const alert of queue.slice(0, config.preReviewMaxPerRun)) {
      const result = (deps.runPreReview ?? runPreReview)(alert, ctx, { run, now });
      if (result.features) ctx.features = result.features;
      next.preReviewed[alert.key] = { at: stamp(now), ok: result.ok === true };
      if (result.ok) {
        preReviewedKeys.add(alert.key);
        log(`${stamp(now)} pre-review of ${ref(alert.identifier)} written to ${result.path}`);
      } else {
        errorLog(`${stamp(now)} no pre-review of ${ref(alert.identifier)}: ${result.reason}`);
        // Nothing else will work this run either.
        if (result.features?.missing?.length || !ctx.claudePath) break;
      }
    }
  }

  for (const notification of planNotifications(fresh, { preReviewedKeys })) {
    const shown = run("osascript", notificationArgs(notification), { encoding: "utf8", timeout: 15_000 });
    if (shown?.status === 0 && !shown.error) {
      for (const key of notification.keys) next.notified[key] = stamp(now);
      log(`${stamp(now)} notified: ${notification.message}`);
    } else {
      // Not marked, so the next check tries again.
      errorLog(`${stamp(now)} could not show a notification: ${shown?.error?.message ?? String(shown?.stderr ?? "").trim()}`);
    }
  }

  try {
    writePrivateJson(paths.state, next);
  } catch (err) {
    errorLog(`${stamp(now)} could not save what was notified (${err?.message ?? err}); the next check may repeat it`);
    return 1;
  }
  return 0;
}

// -------------------------------------------------------- install / remove

export const NOT_MAC_MESSAGE =
  "Scheduled checks and desktop notifications are macOS-only for now; nothing was installed or checked. " +
  "Your inbox is still read when you open a session in ~/agentdash-inbox.";

/** A `node` on the PATH survives a version upgrade; the running binary's own path may not. */
export function stableNodePath({ env = process.env, exists = existsSync, fallback = process.execPath } = {}) {
  for (const dir of String(env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = path.join(dir, "node");
    if (exists(candidate)) return candidate;
  }
  return fallback;
}

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Copy this package (zero dependencies: bin, src, skills, package.json) into
 * ~/.agentdash/connect-runtime, so launchd runs a fixed copy with node rather
 * than `npx @latest`, which would reach the npm registry on every check.
 * Re-running install refreshes it.
 */
export function installRuntimeCopy(dest, { from = PACKAGE_ROOT } = {}) {
  if (path.resolve(from) === path.resolve(dest)) return dest;
  const staging = `${dest}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const part of ["bin", "src", "skills", "package.json"]) {
    const source = path.join(from, part);
    if (!existsSync(source)) continue;
    cpSync(source, path.join(staging, part), {
      recursive: true,
      filter: (file) => !file.endsWith(".test.mjs") && !file.split(path.sep).includes("node_modules"),
    });
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return dest;
}

function launchctl(run, args) {
  const result = run("launchctl", args, { encoding: "utf8", timeout: 15_000 });
  return { ok: !result?.error && result?.status === 0, stderr: String(result?.stderr ?? "").trim() };
}

/** Load (or reload) the agent in the person's GUI session. */
function loadAgent(run, plistPath, uid) {
  launchctl(run, ["bootout", `gui/${uid}/${WATCH_LABEL}`]);
  const booted = launchctl(run, ["bootstrap", `gui/${uid}`, plistPath]);
  if (booted.ok) return booted;
  // Older macOS, or a session bootstrap refuses: the legacy verb still works.
  return launchctl(run, ["load", "-w", plistPath]);
}

/**
 * Turn the watcher on: config (enabled, interval, pre-review flag), the
 * runtime copy, the plist, and launchd. Returns what was written.
 */
export function installWatch(options = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { ok: false, notMac: true, message: NOT_MAC_MESSAGE };
  const run = deps.run ?? spawnSync;
  const paths = deps.paths ?? watchPaths(deps.home);
  const uid = deps.uid ?? process.getuid?.() ?? 0;

  const current = readWatchConfig(paths.config);
  const config = { ...current, enabled: true };
  if (options.intervalMinutes !== undefined) {
    const interval = parseIntervalMinutes(options.intervalMinutes);
    if (!interval) {
      return { ok: false, message: `--every takes whole minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.` };
    }
    config.intervalMinutes = interval;
  }
  if (options.preReview !== undefined) config.preReview = options.preReview === true;
  if (options.server) config.server = options.server;
  if (config.preReview && !config.claudePath) {
    const found = findClaude({ env: deps.env });
    if (found) config.claudePath = found;
  }

  const runtime = (deps.installRuntimeCopy ?? installRuntimeCopy)(paths.runtime);
  const node = deps.nodePath ?? stableNodePath({ env: deps.env });
  const pathDirs = [path.dirname(node), ...(config.claudePath ? [path.dirname(config.claudePath)] : []), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const plist = launchdPlist({
    programArguments: [node, path.join(runtime, "bin", "agentdash-connect.mjs"), "watch", "--once"],
    intervalMinutes: config.intervalMinutes,
    logPath: paths.log,
    env: { PATH: [...new Set(pathDirs)].join(":"), HOME: deps.home ?? os.homedir() },
  });

  writeWatchConfig(paths.config, config);
  mkdirSync(path.dirname(paths.plist), { recursive: true });
  writeFileSync(paths.plist, plist, { mode: 0o644 });
  const loaded = loadAgent(run, paths.plist, uid);
  return {
    ok: loaded.ok,
    config,
    written: [paths.config, paths.runtime, paths.plist],
    message: loaded.ok
      ? null
      : `launchd did not load ${paths.plist}${loaded.stderr ? ` (${loaded.stderr})` : ""}. It will load at your next login.`,
  };
}

/** Turn the watcher off and remove everything it wrote. Returns what was removed. */
export function uninstallWatch(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? spawnSync;
  const paths = deps.paths ?? watchPaths(deps.home);
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const removed = [];
  if (platform === "darwin" && existsSync(paths.plist)) {
    launchctl(run, ["bootout", `gui/${uid}/${WATCH_LABEL}`]);
  }
  for (const file of [paths.plist, paths.config, paths.state, paths.log, paths.runtime]) {
    if (!existsSync(file)) continue;
    rmSync(file, { recursive: true, force: true });
    removed.push(file);
  }
  return { removed };
}

// -------------------------------------------------------------------- CLI

export function parseWatchArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--install") args.install = true;
    else if (token === "--uninstall" || token === "--remove") args.uninstall = true;
    else if (token === "--once") args.once = true;
    else if (token === "--status") args.status = true;
    else if (token === "--every") args.every = argv[++i];
    else if (token.startsWith("--every=")) args.every = token.slice(8);
    else if (token === "--pre-review") args.preReview = argv[++i];
    else if (token.startsWith("--pre-review=")) args.preReview = token.slice(13);
    else if (token === "--server") args.server = argv[++i];
    else if (token.startsWith("--server=")) args.server = token.slice(9);
    else if (token === "--token-file") args.tokenFile = argv[++i];
    else if (token.startsWith("--token-file=")) args.tokenFile = token.slice(13);
    else (args.unknown ??= []).push(token);
  }
  return args;
}

export const WATCH_USAGE = `agentdash-connect watch — a desktop notification when an agent hands you work (macOS)

  npx agentdash-connect watch --install            turn it on (checks every 15 minutes)
  npx agentdash-connect watch --install --every 30 check every 30 minutes instead
  npx agentdash-connect watch --pre-review on      also let Claude Code prepare a first review,
                                                   read-only, into ~/agentdash-inbox/work/<ISSUE>/review.md
  npx agentdash-connect watch --pre-review off     stop doing that
  npx agentdash-connect watch --status             what is on, and when it last notified
  npx agentdash-connect watch --uninstall          turn it off and remove what it wrote
  npx agentdash-connect watch --once               one check now (what launchd runs)

It talks only to your own AgentDash instance. Nothing is sent anywhere: the
notification is shown on this Mac, and a pre-review only writes a file here.`;

function describeConfig(config, paths) {
  const lines = [
    `Watch       ${config.enabled ? `on, every ${config.intervalMinutes} minutes` : "off"}`,
    `Pre-review  ${config.preReview ? `on (at most ${config.preReviewMaxPerRun} per check)` : "off"}`,
    `Config      ${paths.config}`,
  ];
  if (!config.enabled) return lines;
  const times = Object.values(readWatchState(paths.state).notified).filter((value) => typeof value === "string").sort();
  lines.push(`Notified    ${times.length ? `${times.length} item(s) still waiting, last at ${times[times.length - 1]}` : "nothing yet"}`);
  lines.push(`Agent       ${paths.plist}`, `Log         ${paths.log}`);
  return lines;
}

const onOff = (value) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (["on", "yes", "true", "1"].includes(text)) return true;
  if (["off", "no", "false", "0"].includes(text)) return false;
  return null;
};

/** `agentdash-connect watch ...`. Returns an exit code. */
export async function runWatchCommand(argv, deps = {}) {
  const out = deps.log ?? ((line = "") => process.stdout.write(`${line}\n`));
  const bad = deps.errorLog ?? ((line = "") => process.stderr.write(`${line}\n`));
  const platform = deps.platform ?? process.platform;
  const paths = deps.paths ?? watchPaths(deps.home);
  const args = parseWatchArgs(argv);

  if (args.unknown?.length) {
    bad(`Unknown option: ${args.unknown[0]}`);
    out(WATCH_USAGE);
    return 1;
  }
  if (args.once) return runWatchOnce({ server: args.server, tokenFile: args.tokenFile }, deps);

  if (args.uninstall) {
    const { removed } = uninstallWatch(deps);
    if (removed.length === 0) out("Nothing to remove: the watcher was not installed.");
    else {
      out("Turned off and removed:");
      for (const file of removed) out(`  ${file}`);
    }
    return 0;
  }

  let preReview;
  if (args.preReview !== undefined) {
    preReview = onOff(args.preReview);
    if (preReview === null) {
      bad("--pre-review takes on or off.");
      return 1;
    }
  }

  const changing = args.install || args.every !== undefined || preReview !== undefined;
  if (!changing) {
    for (const line of describeConfig(readWatchConfig(paths.config), paths)) out(line);
    if (platform !== "darwin") out(NOT_MAC_MESSAGE);
    out("");
    out(WATCH_USAGE);
    return 0;
  }

  if (platform !== "darwin") {
    out(NOT_MAC_MESSAGE);
    return 0;
  }

  const current = readWatchConfig(paths.config);
  if (!args.install && !current.enabled) {
    // Changing a setting of a watcher that is off records the choice only.
    const next = { ...current };
    if (args.every !== undefined) {
      const interval = parseIntervalMinutes(args.every);
      if (!interval) {
        bad(`--every takes whole minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`);
        return 1;
      }
      next.intervalMinutes = interval;
    }
    if (preReview !== undefined) next.preReview = preReview;
    writeWatchConfig(paths.config, next);
    for (const line of describeConfig(next, paths)) out(line);
    out("The watcher is off, so this takes effect when you turn it on: npx agentdash-connect watch --install");
    return 0;
  }

  let server = args.server;
  if (!server && !current.server) {
    try {
      server = resolveInboxServer({ claudeConfigPath: deps.claudeConfigPath });
    } catch (err) {
      bad(err?.message ?? String(err));
      return 1;
    }
  }
  const result = installWatch({ intervalMinutes: args.every, preReview, server }, deps);
  if (result.notMac) {
    out(result.message);
    return 0;
  }
  if (!result.config) {
    bad(result.message);
    return 1;
  }
  for (const line of describeConfig(result.config, paths)) out(line);
  if (result.message) bad(result.message);
  out("");
  out("You get one notification per new hand-off. It talks only to your AgentDash instance.");
  if (result.config.preReview) {
    out("Pre-review runs Claude Code headless and read-only in ~/agentdash-inbox; it uses your Claude usage.");
    if (!result.config.claudePath) bad("Claude Code (claude) was not found; pre-reviews will be skipped until it is installed.");
  }
  out("Turn it off with: npx agentdash-connect watch --uninstall");
  return result.ok ? 0 : 1;
}
