#!/usr/bin/env node
// AgentDash: set up an internal AgentDash cloud box and move a company into it,
// in steps an agent can run, resume and verify. Runbook: doc/runbooks/internal-box.md.
//
//   preflight     credentials, operator surface, Railway CLI, release image
//   create        POST /internal/boxes with purpose internal, then wait until healthy
//   claim         the founder account (password into the Keychain FIRST), then
//                 wait for the control plane to close sign-up and redeploy (§7)
//   move-company  portability export -> import into the box, every agent on hermes_local,
//                 counts verified (a dry run unless --apply)
//   configure     the box's Hermes provider key, from the Keychain
//   status        box health, release, purpose, backups
//
// Reuse, not copies: the control-plane calls go through the operator CLI's own
// runAdmin (cloud/src/admin/run.ts, loaded with tsx), and the release checks
// through cloud/src/railway/image.ts and cloud/src/jobs/claim.ts, so this tool
// and `pnpm --filter @agentdash/cloud-control admin` cannot drift apart.
//
// Secret handling (same rules as scripts/hosted/lib.sh):
//   - secrets come only from the environment or the macOS Keychain, never argv;
//     flags that look like secrets are refused;
//   - nothing secret is passed on a child's command line: the Keychain write
//     goes through `security -i` on stdin, reads use `find-generic-password -w`;
//   - the Railway token never reaches this process (the `railway` CLI holds it);
//   - every line printed (text or --json) is scrubbed of every secret this run
//     has seen, and the password and claim code are never printed at all.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export const ADMIN_TOKEN_ITEM = "agentdash-cloud-admin-token";
export const SOURCE_TOKEN_ITEM = "agentdash-source-token";
export const founderItem = (slug) => `agentdash-box-${slug}-founder`;
export const providerItem = (name) => `agentdash-provider-${name}`;
/** The four API-key providers a hosted box supports (server/src/services/hermes-provider-setup.ts HERMES_PROVIDERS). */
export const HERMES_PROVIDERS = ["zai", "openrouter", "anthropic", "openai"];
export const HOSTED_ADAPTER = "hermes_local";
const BOX_PROJECT_PREFIX = "agentdash-box-";
// scripts/hosted/lib.sh PROTECTED_PROJECTS: never touched, even by name collision.
const PROTECTED_PROJECTS = ["agentdash", "agentdash-demo", "yarda-backend-v2", "perceptive-integrity"];
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const NEW_SLUG_MAX = 16; // lib.sh validate_new_slug: room for "<slug>-restore"
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// adapterConfig keys that pick what runs on the host (adapter-host-execution-policy.ts,
// minus the managed instructions *Path/*Dir keys, which the import rewrites itself).
const HOST_EXEC_KEY_RE = /^(command|args|env|cwd)$|(Command|Args|Env|Cwd)$/;
const DEFAULT_CONTROL_URL_HINT = "https://cloud-control-production.up.railway.app";
const INCLUDE_ALL = { company: true, agents: true, projects: true, issues: true, skills: true };

export const USAGE = `usage: node scripts/hosted/internal-box.mjs <command> [options]

  preflight [--release <tag>] [--provider <name>] [--from <url>]
        check credentials, the operator surface, the Railway CLI and the release image
  create <slug> --email <email> --release <tag> [--no-wait] [--timeout <min>]
        create an internal box (idempotent) and wait until it is healthy
  claim <slug> --name <name> --email <email> [--no-redeploy] [--no-wait] [--timeout <min>]
        create the founder account (password stored in the Keychain first), then
        wait for the control plane to close sign-up and redeploy the box
  move-company --from <url> --to <slug> --company <id|name> [--apply]
        export a company from an AgentDash instance and import it into the box,
        every agent on hermes_local, counts verified; a DRY RUN unless --apply
  configure <slug> --provider <zai|openrouter|anthropic|openai> [--model <id>] [--rotate]
        set the box's Hermes provider key from the Keychain item agentdash-provider-<name>
  status <slug>
        box health, release, purpose and backups

  global: --json (one JSON document on stdout), --dry-run (plan, change nothing),
          --box-url <https://...> (override the box address), --help

  secrets (never on the command line):
    CLOUD_ADMIN_TOKEN       env, else Keychain item ${ADMIN_TOKEN_ITEM}
    founder password        Keychain item agentdash-box-<slug>-founder (claim writes it)
    provider key            Keychain item agentdash-provider-<name>
    source board key        env AGENTDASH_SOURCE_TOKEN, else Keychain item ${SOURCE_TOKEN_ITEM}
                            (or --source-token-item <item>)
  env: CLOUD_CONTROL_URL (required), AGENTDASH_BOX_STATE_DIR (default ~/.agentdash-boxes)
  runbook: doc/runbooks/internal-box.md`;

// ---------------------------------------------------------------------------
// Errors and output
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(message, { fix = null, code = 1 } = {}) {
    super(message);
    this.fix = fix;
    this.code = code;
  }
}

/** Every secret this run has handled, scrubbed from every line it prints. */
class Secrets {
  #values = new Set();
  add(value) {
    if (typeof value === "string" && value.trim().length >= 6) this.#values.add(value.trim());
    return value;
  }
  scrub(text) {
    let s = String(text);
    for (const v of [...this.#values].sort((a, b) => b.length - a.length)) s = s.split(v).join("[redacted]");
    // Shapes that must never print even if they slipped past registration.
    return s
      .replace(/pcp_board_[0-9a-f]{16,}/gi, "[redacted]")
      .replace(/\bAGD-[0-9A-F]{8,}\b/g, "[redacted]")
      .replace(/(session_token=)[^;\s"]+/gi, "$1[redacted]");
  }
}

class Report {
  constructor(ctx, command) {
    this.ctx = ctx;
    this.command = command;
    this.steps = [];
    this.result = {};
    this.warnings = [];
  }
  step(name, status, detail = "") {
    this.steps.push({ step: name, status, ...(detail ? { detail } : {}) });
    this.ctx.progress(`[${status}] ${name}${detail ? `: ${detail}` : ""}`);
  }
  warn(message) {
    this.warnings.push(message);
    this.ctx.progress(`[warn] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--email", "--release", "--name", "--provider", "--model", "--from", "--to", "--company", "--box-url", "--source-token-item", "--timeout", "--poll"]);
const BOOL_FLAGS = new Set(["--json", "--dry-run", "--apply", "--no-wait", "--no-redeploy", "--rotate", "--help", "-h"]);
const SECRET_FLAG_RE = /^--(password|pass|token|secret|key|api-key|apikey|code|invite-code|claim-code|admin-token)(=|$)/i;

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SECRET_FLAG_RE.test(a)) {
      throw new CliError(`refusing ${a.split("=")[0]}: secrets are never taken on the command line (argv is readable by every process)`, {
        fix: "put the secret in the environment or the Keychain item the runbook names (doc/runbooks/internal-box.md §1)",
        code: 64,
      });
    }
    if (a.startsWith("--") && a.includes("=")) {
      const [k, ...v] = a.split("=");
      if (!VALUE_FLAGS.has(k)) throw new CliError(`unknown option ${k}`, { code: 64 });
      flags[k.slice(2)] = v.join("=");
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new CliError(`${a} needs a value`, { code: 64 });
      flags[a.slice(2)] = v;
      i++;
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      flags[a === "-h" ? "help" : a.slice(2)] = true;
      continue;
    }
    if (a.startsWith("-")) throw new CliError(`unknown option ${a}`, { code: 64 });
    positional.push(a);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Context: the injectable world (tests replace fetch, exec, sleep and the clock)
// ---------------------------------------------------------------------------

/** Runs a program without a shell. `input` goes to stdin; secrets travel only that way. */
export function realExec(cmd, args, { input, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err?.message ?? err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: err?.code === "ENOENT" ? 127 : 1, stdout, stderr: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

let cloudModules = null;
/** cloud/src modules through tsx: the operator CLI's request code and the control plane's release checks. */
export async function loadCloud() {
  if (cloudModules) return cloudModules;
  const require = createRequire(import.meta.url);
  let tsImport;
  try {
    ({ tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href));
  } catch {
    throw new CliError("cannot load tsx to reuse the operator CLI", { fix: "run `pnpm install` in the repository checkout, then retry" });
  }
  const load = (rel) => tsImport(pathToFileURL(path.join(REPO_ROOT, rel)).href, import.meta.url);
  const [run, image, claim] = await Promise.all([load("cloud/src/admin/run.ts"), load("cloud/src/railway/image.ts"), load("cloud/src/jobs/claim.ts")]);
  cloudModules = {
    runAdmin: run.runAdmin,
    checkControlUrl: run.checkControlUrl,
    resolveImageDigest: image.resolveImageDigest,
    ImageNotFound: image.ImageNotFound,
    RELEASE_TAG_RE: image.RELEASE_TAG_RE,
    MIN_BOX_RELEASE: claim.MIN_BOX_RELEASE,
    releaseMeetsBoxFloor: claim.releaseMeetsBoxFloor,
  };
  return cloudModules;
}

export function makeContext(deps = {}) {
  const env = deps.env ?? process.env;
  const secrets = new Secrets();
  const ctx = {
    env,
    secrets,
    fetch: deps.fetch ?? globalThis.fetch,
    exec: deps.exec ?? realExec,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
    cloud: deps.cloud ?? null,
    stateRoot: deps.stateRoot ?? env.AGENTDASH_BOX_STATE_DIR ?? path.join(os.homedir(), ".agentdash-boxes"),
    json: false,
    rawOut: deps.out ?? ((l) => process.stdout.write(l + "\n")),
    rawErr: deps.err ?? ((l) => process.stderr.write(l + "\n")),
  };
  ctx.out = (line) => ctx.rawOut(secrets.scrub(line));
  ctx.progress = (line) => ctx.rawErr(secrets.scrub(`==> ${line}`));
  ctx.getCloud = async () => (ctx.cloud ??= await loadCloud());
  return ctx;
}

// ---------------------------------------------------------------------------
// Keychain (macOS `security`); values only on stdin or stdout, never argv
// ---------------------------------------------------------------------------

const KEYCHAIN_SAFE = /^[A-Za-z0-9._%+@-]+$/;

async function keychainExists(ctx, service) {
  const r = await ctx.exec("security", ["find-generic-password", "-s", service]);
  if (r.code === 127) throw new CliError("macOS `security` is not available", { fix: "run this tool on the founder's Mac (it keeps secrets in the login Keychain)" });
  return r.code === 0;
}

async function keychainRead(ctx, service) {
  const r = await ctx.exec("security", ["find-generic-password", "-s", service, "-w"]);
  if (r.code === 127) throw new CliError("macOS `security` is not available", { fix: "run this tool on the founder's Mac (it keeps secrets in the login Keychain)" });
  if (r.code !== 0) return null;
  const value = r.stdout.replace(/\r?\n$/, "");
  if (!value) return null;
  ctx.secrets.add(value);
  return value;
}

/**
 * Store a generated value: `security -i` reads the command from stdin, so the
 * value is on no process's argv. Read back and compared before it counts.
 */
async function keychainWrite(ctx, { service, account, label, value }) {
  for (const [what, v] of Object.entries({ service, account, label, value })) {
    if (!KEYCHAIN_SAFE.test(v) || v.startsWith("-")) throw new CliError(`refusing to write a Keychain ${what} with unexpected characters`);
  }
  ctx.secrets.add(value);
  const r = await ctx.exec("security", ["-i"], { input: `add-generic-password -U -a ${account} -s ${service} -l ${label} -w ${value}\n` });
  if (r.code === 127) throw new CliError("macOS `security` is not available", { fix: "run this tool on the founder's Mac (it keeps secrets in the login Keychain)" });
  const back = await keychainRead(ctx, service);
  if (back !== value) {
    throw new CliError(`could not store the password in the Keychain item ${service}; nothing was created on the box`, {
      fix: "unlock the login Keychain (Keychain Access, or `security unlock-keychain`) and re-run",
    });
  }
}

/** A password from [A-Za-z0-9] only (Keychain-line safe), 40 characters, about 238 bits. */
export function newPassword() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < 40) {
    for (const b of randomBytes(64)) {
      if (b < 248 && out.length < 40) out += alphabet[b % 62];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The control plane, through the operator CLI's runAdmin
// ---------------------------------------------------------------------------

export class AdminError extends CliError {
  constructor(message, { status = null, body = null, retryAfter = null, fix = null } = {}) {
    super(message, { fix });
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

function controlUrl(ctx) {
  const url = ctx.env.CLOUD_CONTROL_URL?.trim();
  if (!url) {
    throw new CliError("CLOUD_CONTROL_URL is not set", { fix: `export CLOUD_CONTROL_URL=${DEFAULT_CONTROL_URL_HINT}` });
  }
  return url;
}

/** CLOUD_ADMIN_TOKEN from the environment, else the Keychain; never from argv. */
async function adminToken(ctx) {
  let token = ctx.env.CLOUD_ADMIN_TOKEN?.trim() || null;
  let source = "env CLOUD_ADMIN_TOKEN";
  if (!token) {
    token = await keychainRead(ctx, ADMIN_TOKEN_ITEM);
    source = `Keychain item ${ADMIN_TOKEN_ITEM}`;
  }
  if (!token) {
    throw new CliError(`no admin token: CLOUD_ADMIN_TOKEN is unset and the Keychain item ${ADMIN_TOKEN_ITEM} is missing`, {
      fix: `security add-generic-password -s ${ADMIN_TOKEN_ITEM} -a "$USER" -w   (paste the cloud-control CLOUD_ADMIN_TOKEN at the prompt)`,
    });
  }
  ctx.secrets.add(token);
  return { token, source };
}

async function adminCreds(ctx) {
  const url = controlUrl(ctx);
  return { url, ...(await adminToken(ctx)) };
}

function explainAdminFailure(status, body, retryAfter) {
  const ip = body && typeof body === "object" ? body.ip ?? body.clientIp ?? body.yourIp ?? null : null;
  if (status === 403) {
    return {
      message: `this machine's IP is not on CLOUD_ADMIN_ALLOWED_IPS${ip ? ` (the control plane saw ${ip})` : " (the control plane does not say which address it saw)"}`,
      fix:
        `${ip ? `add ${ip}` : "find this machine's public address (`curl -s https://checkip.amazonaws.com`) and add it"} to ` +
        "CLOUD_ADMIN_ALLOWED_IPS on the cloud-control service (Railway project agentdash-cloud), redeploy cloud-control, then re-run preflight",
    };
  }
  if (status === 401) {
    return {
      message: "the control plane refused the admin token (401)",
      fix: `replace it with the current CLOUD_ADMIN_TOKEN of cloud-control: security add-generic-password -U -s ${ADMIN_TOKEN_ITEM} -a "$USER" -w`,
    };
  }
  if (status === 429) {
    return {
      message: `this address is locked out after repeated refused attempts${retryAfter ? ` (retry after ${retryAfter} s)` : ""}`,
      fix: "wait for the lockout to pass, fix the token or the allow-list first, then re-run preflight",
    };
  }
  return { message: `control plane answered HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`, fix: null };
}

/** Run one operator-CLI command in-process; returns its JSON, or throws AdminError. */
async function admin(ctx, args) {
  const cloud = await ctx.getCloud();
  const creds = ctx.creds ?? (ctx.creds = await adminCreds(ctx));
  const out = [];
  const err = [];
  let last = null;
  const fetchTap = async (url, init) => {
    const res = await ctx.fetch(url, init);
    last = { status: res.status, retryAfter: res.headers?.get?.("retry-after") ?? null };
    return res;
  };
  let code;
  try {
    code = await cloud.runAdmin(args, { CLOUD_CONTROL_URL: creds.url, CLOUD_ADMIN_TOKEN: creds.token }, { out: (l) => out.push(l), err: (l) => err.push(l), fetch: fetchTap });
  } catch (e) {
    throw new AdminError(`cannot reach the control plane at ${creds.url}: ${e?.cause?.code ?? e?.message ?? e}`, {
      fix: "check CLOUD_CONTROL_URL and this machine's network, then re-run preflight",
    });
  }
  if (code === 0) {
    const text = out.join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const text = err.join("\n");
  const m = /^error (\d+): ([\s\S]*)$/.exec(text);
  if (!m) throw new AdminError(text || `operator CLI exited ${code}`, { fix: code === 2 ? "check CLOUD_CONTROL_URL (https, or http to this machine only)" : null });
  let body = m[2];
  try {
    body = JSON.parse(m[2]);
  } catch {
    // keep text
  }
  const status = Number(m[1]);
  const { message, fix } = explainAdminFailure(status, body, last?.retryAfter);
  throw new AdminError(message, { status, body, retryAfter: last?.retryAfter, fix });
}

async function findBox(ctx, slug) {
  const r = await admin(ctx, ["boxes", "list"]);
  return (r?.boxes ?? []).find((b) => b.slug === slug) ?? null;
}

/** The box must exist and be ours (purpose internal): this tool never touches a customer box. */
async function requireInternalBox(ctx, slug) {
  const box = await findBox(ctx, slug);
  if (!box) throw new CliError(`no box ${slug} in the control plane`, { fix: `node scripts/hosted/internal-box.mjs create ${slug} --email <email> --release <tag>` });
  if (box.purpose !== "internal") {
    throw new CliError(`box ${slug} has purpose ${box.purpose}; this tool only works on internal boxes`, { fix: "pick another slug; never run this tool against a customer box" });
  }
  return box;
}

async function latestJob(ctx, slug, kind) {
  const r = await admin(ctx, ["jobs", "list"]);
  return (r?.jobs ?? []).filter((j) => j.slug === slug && j.kind === kind).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Railway, through the CLI (`railway login` holds the token; this process never sees it)
// ---------------------------------------------------------------------------

function assertBoxProjectName(name) {
  if (PROTECTED_PROJECTS.includes(name)) throw new CliError(`refusing to touch protected project ${name}`);
  if (!name.startsWith(BOX_PROJECT_PREFIX)) throw new CliError(`refusing to touch ${name}: box projects are named ${BOX_PROJECT_PREFIX}<slug>`);
}

async function railway(ctx, args, opts) {
  const r = await ctx.exec("railway", args, opts);
  if (r.code === 127) throw new CliError("the Railway CLI is not installed", { fix: "brew install railway, then railway login" });
  return r;
}

function findProjectId(listJson, name) {
  const stack = [listJson];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") {
      if (v.name === name && typeof v.id === "string") return v.id;
      stack.push(...Object.values(v));
    }
  }
  return null;
}

/** Link the box's state directory to its Railway project (as provision-box.sh does) and read the web service's variables. */
async function railwayBoxVariables(ctx, slug) {
  const name = `${BOX_PROJECT_PREFIX}${slug}`;
  assertBoxProjectName(name);
  const list = await railway(ctx, ["list", "--json"]);
  if (list.code !== 0) throw new CliError(`railway list failed: ${list.stderr.trim()}`, { fix: "railway login (as an account in the AgentDash Boxes workspace)" });
  let parsed;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    throw new CliError("railway list --json did not return JSON", { fix: "update the Railway CLI (brew upgrade railway)" });
  }
  const projectId = findProjectId(parsed, name);
  if (!projectId) throw new CliError(`Railway project ${name} is not visible to the logged-in Railway account`, { fix: "railway login as an account in the AgentDash Boxes workspace" });
  const dir = boxStateDir(ctx, slug);
  const link = await railway(ctx, ["link", "--project", projectId, "--environment", "production", "--service", "web"], { cwd: dir });
  if (link.code !== 0) throw new CliError(`railway link failed: ${link.stderr.trim()}`);
  const vars = await railway(ctx, ["variables", "--service", "web", "--environment", "production", "--json"], { cwd: dir });
  if (vars.code !== 0) throw new CliError(`could not read the box's Railway variables: ${vars.stderr.trim()}`);
  let obj;
  try {
    obj = JSON.parse(vars.stdout);
  } catch {
    throw new CliError("railway variables --json did not return JSON", { fix: "update the Railway CLI (brew upgrade railway)" });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/SECRET|KEY|TOKEN|CODES|PASSWORD|DATABASE_URL/i.test(k) && typeof v === "string") {
      for (const part of v.split(",")) ctx.secrets.add(part);
      ctx.secrets.add(v);
    }
  }
  return { projectId, dir, vars: obj };
}

// ---------------------------------------------------------------------------
// Local state (no secrets): ~/.agentdash-boxes/<slug>/internal-box.json
// ---------------------------------------------------------------------------

function boxStateDir(ctx, slug) {
  const dir = path.join(ctx.stateRoot, slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(ctx.stateRoot, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

export function readState(ctx, slug) {
  const file = path.join(ctx.stateRoot, slug, "internal-box.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`the local state file ${file} is not valid JSON`, { fix: "repair or remove it; it holds no secrets" });
  }
}

function writeState(ctx, slug, patch) {
  const dir = boxStateDir(ctx, slug);
  const file = path.join(dir, "internal-box.json");
  const next = { ...readState(ctx, slug), ...patch, slug, updatedAt: new Date(ctx.now()).toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

// ---------------------------------------------------------------------------
// HTTP to a box or a source instance
// ---------------------------------------------------------------------------

function checkInstanceUrl(raw, what) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`${what} is not a URL: ${raw}`, { code: 64 });
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new CliError(`${what} must be https (plain http only to this machine)`, { code: 64 });
  }
  if (url.username || url.password) throw new CliError(`${what} must not carry credentials`, { code: 64 });
  return url.origin;
}

async function http(ctx, method, url, { body, headers = {}, timeoutMs = 30_000 } = {}) {
  let res;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err?.cause?.code ?? err?.name ?? err), headers: null };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { ok: res.ok, status: res.status, json, text, headers: res.headers };
}

function describe(r) {
  if (r.status === 0) return `unreachable (${r.text})`;
  const msg = r.json && typeof r.json === "object" ? r.json.error ?? r.json.message ?? r.json.code ?? JSON.stringify(r.json) : r.text;
  return `HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`;
}

async function boxHealth(ctx, boxUrl) {
  return http(ctx, "GET", `${boxUrl}/api/health`, { timeoutMs: 10_000 });
}

/** A signed-in session on the box as its founder; mutations carry the box's own Origin (board-mutation-guard). */
async function boxSession(ctx, boxUrl, email, password, item = "agentdash-box-<slug>-founder") {
  const r = await http(ctx, "POST", `${boxUrl}/api/auth/sign-in/email`, { body: { email, password }, headers: { origin: boxUrl } });
  if (!r.ok) {
    throw new CliError(`could not sign in to the box as ${email}: ${describe(r)}`, {
      fix: `the Keychain item ${item} must hold the password claim stored; re-run claim if the account was never created`,
    });
  }
  const cookies = (r.headers?.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean);
  if (cookies.length === 0) throw new CliError("the box signed in but set no session cookie");
  for (const c of cookies) ctx.secrets.add(c.split("=").slice(1).join("="));
  const cookie = cookies.join("; ");
  const call = (method, p, body, timeoutMs) => http(ctx, method, `${boxUrl}${p}`, { body, headers: { cookie, origin: boxUrl }, timeoutMs });
  return { call, get: (p) => call("GET", p) };
}

async function getOk(api, p, what) {
  const r = await api.get(p);
  if (!r.ok) throw new CliError(`could not read ${what}: ${describe(r)}`);
  return r.json;
}

/** Live counts of what the portability bundle carries, plus goals (which it does not). */
async function companyCounts(api, companyId) {
  const agents = await getOk(api, `/api/companies/${companyId}/agents`, "agents");
  const projects = await getOk(api, `/api/companies/${companyId}/projects`, "projects");
  const goals = await getOk(api, `/api/companies/${companyId}/goals`, "goals");
  const issues = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getOk(api, `/api/companies/${companyId}/issues?limit=1000&offset=${offset}`, "issues");
    const rows = Array.isArray(page) ? page : page?.issues ?? [];
    issues.push(...rows);
    if (rows.length < 1000) break;
  }
  const liveAgents = (Array.isArray(agents) ? agents : []).filter((a) => a.status !== "terminated");
  return {
    counts: { agents: liveAgents.length, projects: (projects ?? []).length, issues: issues.length, goals: (goals ?? []).length },
    agents: liveAgents,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Box address: --box-url, then the slug host, then the recorded one, then the Railway host
// ---------------------------------------------------------------------------

async function resolveBoxUrl(ctx, slug, box, { flagUrl, railwayVars } = {}) {
  if (flagUrl) return checkInstanceUrl(flagUrl, "--box-url");
  const state = readState(ctx, slug);
  // The slug host first: once the edge router is live, the Railway host still answers
  // /api/health (edge-gate exempts it) but refuses everything else.
  const candidates = [box?.publicUrl, state.boxUrl].filter(Boolean);
  const allowed = String(railwayVars?.PAPERCLIP_ALLOWED_HOSTNAMES ?? "").split(",").map((h) => h.trim());
  const railwayHost = allowed.find((h) => h.endsWith(".up.railway.app"));
  // The Railway host serves only while the edge router is not enforcing its secret.
  if (railwayHost && !railwayVars?.AGENTDASH_EDGE_SECRET) candidates.push(`https://${railwayHost}`);
  for (const url of [...new Set(candidates)]) {
    const h = await boxHealth(ctx, url);
    if (h.ok && h.json?.status === "ok") return url;
  }
  throw new CliError(`box ${slug} does not answer /api/health at ${candidates.join(" or ") || "any known address"}`, {
    fix: `check \`node scripts/hosted/internal-box.mjs status ${slug}\`; pass --box-url https://<host> if it lives elsewhere`,
  });
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function cmdPreflight(ctx, { flags }, rep) {
  const checks = [];
  // Text mode prints the checklist once, on stdout; --json carries it in result.checks.
  const add = (name, level, detail, fix = null) => {
    checks.push({ name, level, detail, ...(fix ? { fix } : {}) });
    rep.steps.push({ step: name, status: level, detail });
  };
  const cloud = await ctx.getCloud();

  const url = ctx.env.CLOUD_CONTROL_URL?.trim();
  if (!url) add("control-url", "FAIL", "CLOUD_CONTROL_URL is not set", `export CLOUD_CONTROL_URL=${DEFAULT_CONTROL_URL_HINT}`);
  else {
    const bad = cloud.checkControlUrl(url);
    if (bad) add("control-url", "FAIL", bad, `export CLOUD_CONTROL_URL=${DEFAULT_CONTROL_URL_HINT}`);
    else add("control-url", "ok", url);
  }

  let token = null;
  try {
    token = await adminToken(ctx);
    add("admin-token", "ok", `from ${token.source}`);
  } catch (err) {
    add("admin-token", "FAIL", err.message, err.fix);
  }

  if (url && token && !checks.some((c) => c.name === "control-url" && c.level === "FAIL")) {
    ctx.creds = { url, ...token };
    try {
      const settings = await admin(ctx, ["settings", "get"]);
      add("operator-surface", "ok", "reachable and authorized (GET /internal/settings)");
      const s = settings && typeof settings === "object" ? settings : {};
      if (s.provisioning_enabled === false) add("provisioning", "warn", "provisioning_enabled is false: create will wait (kill switch)", "pnpm --filter @agentdash/cloud-control admin settings set provisioning_enabled true   (founder decision)");
      else if ("provisioning_enabled" in s) add("provisioning", "ok", "provisioning_enabled is true");
    } catch (err) {
      add("operator-surface", "FAIL", err.message, err.fix);
    }
  } else {
    add("operator-surface", "skip", "needs CLOUD_CONTROL_URL and the admin token");
  }

  const who = await ctx.exec("railway", ["whoami"]);
  if (who.code === 127) add("railway", "FAIL", "the Railway CLI is not installed", "brew install railway, then railway login");
  else if (who.code !== 0) add("railway", "FAIL", "`railway whoami` failed: not logged in", "railway login   (as an account in the AgentDash Boxes workspace)");
  else add("railway", "ok", (who.stdout.match(/Logged in as\s+(\S+)/)?.[1] ?? who.stdout.trim().split("\n")[0]) || "logged in");

  if (flags.release) {
    const tag = flags.release;
    const repo = (ctx.env.CLOUD_BOX_IMAGE_REPO ?? "ghcr.io/thetangstr/agentdash").trim();
    if (!cloud.RELEASE_TAG_RE.test(tag)) add("release", "FAIL", `${tag} is not a release tag`, "use a stable tag like v2026.1030.0 (git tag -l 'v*' --sort=-v:refname | head)");
    else if (!cloud.releaseMeetsBoxFloor(tag)) add("release", "FAIL", `${tag} is older than ${cloud.MIN_BOX_RELEASE}, which new boxes need (claim tracking)`, `pick a stable tag at or after ${cloud.MIN_BOX_RELEASE}`);
    else {
      try {
        const digest = await cloud.resolveImageDigest(repo, tag, { fetch: ctx.fetch });
        add("release", "ok", `${repo}:${tag} (${digest.slice(0, 19)}…)`);
      } catch (err) {
        if (err instanceof cloud.ImageNotFound || err?.name === "ImageNotFound") {
          add("release", "FAIL", `no image at ${repo}:${tag}`, `pick a tag with an image, or build one: gh workflow run docker.yml --ref main -f release_tag=${tag}`);
        } else add("release", "FAIL", `GHCR check failed: ${err.message}`, "retry; GHCR may be unavailable");
      }
    }
  }

  if (flags.provider) {
    if (!HERMES_PROVIDERS.includes(flags.provider)) add("provider", "FAIL", `unknown provider ${flags.provider}`, `use one of ${HERMES_PROVIDERS.join(", ")}`);
    else if (await keychainExists(ctx, providerItem(flags.provider))) add("provider", "ok", `Keychain item ${providerItem(flags.provider)} present`);
    else add("provider", "FAIL", `Keychain item ${providerItem(flags.provider)} is missing`, `security add-generic-password -s ${providerItem(flags.provider)} -a "$USER" -w   (paste the provider API key at the prompt)`);
  }

  if (flags.from) {
    try {
      const origin = checkInstanceUrl(flags.from, "--from");
      const item = flags["source-token-item"] ?? SOURCE_TOKEN_ITEM;
      if (ctx.env.AGENTDASH_SOURCE_TOKEN?.trim()) add("source-token", "ok", "from env AGENTDASH_SOURCE_TOKEN");
      else if (await keychainExists(ctx, item)) add("source-token", "ok", `Keychain item ${item} present`);
      else if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) add("source-token", "warn", "no board key; a local_trusted source needs none");
      else add("source-token", "FAIL", `no board key for ${origin}`, `mint one with \`pnpm paperclipai auth login\` against ${origin} (docs/api/api-keys.md), then: security add-generic-password -s ${item} -a "$USER" -w`);
    } catch (err) {
      add("source-token", "FAIL", err.message);
    }
  }

  rep.result = { checks };
  const failed = checks.filter((c) => c.level === "FAIL");
  if (!ctx.json) {
    for (const c of checks) {
      ctx.out(`[${c.level === "ok" ? "ok" : c.level}] ${c.name}: ${c.detail}`);
      if (c.fix && c.level !== "ok") ctx.out(`      fix: ${c.fix}`);
    }
  }
  if (failed.length) {
    throw new CliError(`preflight failed: ${failed.map((c) => c.name).join(", ")}`, {
      fix: ctx.json ? failed.map((c) => c.fix).filter(Boolean).join("\n") || null : "run each fix above, then re-run preflight",
    });
  }
  if (!ctx.json) ctx.out("preflight passed");
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

function validateSlug(slug, { isNew }) {
  if (!slug || !SLUG_RE.test(slug) || slug.length > 32) throw new CliError("slug must be 3-32 chars of a-z, 0-9 and '-', starting with a letter", { code: 64 });
  if (isNew && slug.length > NEW_SLUG_MAX) throw new CliError(`new box slugs are at most ${NEW_SLUG_MAX} chars (so '<slug>-restore' can always be created)`, { code: 64 });
}

function minutes(flags, name, dflt) {
  if (flags[name] === undefined) return dflt;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--${name} must be a positive number`, { code: 64 });
  return n;
}

const PROVISION_DONE = new Set(["awaiting_claim", "active"]);

async function waitForProvision(ctx, slug, rep, { timeoutMin, pollSec }) {
  const deadline = ctx.now() + timeoutMin * 60_000;
  let lastLine = "";
  for (;;) {
    const box = await findBox(ctx, slug);
    const job = await latestJob(ctx, slug, "provision");
    const line = `box ${box?.state ?? "missing"}${job ? `, job ${job.state}${job.step ? ` at ${job.step}` : ""}${job.attempt ? ` (attempt ${job.attempt})` : ""}` : ""}`;
    if (line !== lastLine) {
      rep.step("provisioning", "waiting", line);
      lastLine = line;
    }
    if (box && PROVISION_DONE.has(box.state)) return box;
    if (box?.state === "failed" || job?.state === "dead") {
      throw new CliError(`provisioning ${job?.state === "dead" ? "is dead" : "failed"}${job?.step ? ` at step ${job.step}` : ""}: ${job?.lastError ?? "see box events"}`, {
        fix:
          job?.state === "dead"
            ? `a safety rule refused it; fix the cause, then abandon: pnpm --filter @agentdash/cloud-control admin boxes abandon ${slug}`
            : `re-run create to resume at the failed step (it calls admin boxes retry ${slug}), or abandon the box`,
      });
    }
    if (box?.state === "waitlisted") {
      throw new CliError(`box ${slug} is waitlisted (kill switch, daily cap or approval)`, {
        fix: "pnpm --filter @agentdash/cloud-control admin settings get   (provisioning_enabled, daily_cap); the box starts once the gate opens",
      });
    }
    if (ctx.now() >= deadline) {
      throw new CliError(`box ${slug} is still provisioning after ${timeoutMin} min (${line})`, { fix: `re-run create ${slug} ... to keep waiting (it never creates a second box)` });
    }
    await ctx.sleep(pollSec * 1000);
  }
}

async function cmdCreate(ctx, { positional, flags }, rep) {
  const slug = positional[1];
  validateSlug(slug, { isNew: false });
  const email = flags.email;
  const release = flags.release;
  if (!email || !EMAIL_RE.test(email)) throw new CliError("--email <founder email> is required (the claim is bound to it)", { code: 64 });
  if (!release) throw new CliError("--release <tag> is required", { code: 64 });
  const cloud = await ctx.getCloud();
  if (!cloud.RELEASE_TAG_RE.test(release)) throw new CliError(`--release must look like v2026.1030.0 (got ${release})`, { code: 64 });
  if (!cloud.releaseMeetsBoxFloor(release)) throw new CliError(`release ${release} is older than ${cloud.MIN_BOX_RELEASE}, which new boxes need`, { code: 64 });
  const timeoutMin = minutes(flags, "timeout", 30);
  const pollSec = minutes(flags, "poll", 15);

  let box = await findBox(ctx, slug);
  if (box) {
    if (box.purpose !== "internal") {
      throw new CliError(`slug ${slug} is taken by a ${box.purpose} box; refusing to touch it`, { fix: "pick another slug" });
    }
    rep.step("box", "exists", `${slug} is ${box.state} (release ${box.releaseTag ?? "?"}); not recreated`);
    if (box.releaseTag && box.releaseTag !== release) rep.warn(`box runs ${box.releaseTag}, not ${release}; upgrades go through admin boxes upgrade ${slug} ${release}`);
    if (box.state === "failed") {
      if (flags["dry-run"]) {
        rep.step("retry", "planned", `admin boxes retry ${slug}`);
        return;
      }
      const r = await admin(ctx, ["boxes", "retry", slug]);
      rep.step("retry", "ok", `resumed the provision job at ${r?.step ?? "its failed step"}`);
    }
  } else {
    validateSlug(slug, { isNew: true });
    if (flags["dry-run"]) {
      rep.step("create", "planned", `POST /internal/boxes {slug:${slug}, email:${email}, releaseTag:${release}, purpose:internal}`);
      rep.result = { slug, planned: true };
      return;
    }
    const r = await admin(ctx, ["boxes", "create", slug, email, release, "--purpose", "internal"]);
    const outcome = r?.provisioning?.outcome;
    rep.step("create", "ok", `box ${slug} created (purpose internal); provisioning ${outcome}${r?.provisioning?.reason ? ` (${r.provisioning.reason})` : ""}`);
    if (outcome === "waitlisted") {
      throw new CliError(`box ${slug} was created but is waitlisted: ${r.provisioning.reason}`, {
        fix: "the kill switch or the daily cap holds it; a founder opens the gate (admin settings), then re-run create to wait",
      });
    }
  }
  box = await findBox(ctx, slug);
  if (!PROVISION_DONE.has(box?.state)) {
    if (flags["no-wait"]) {
      rep.step("wait", "skipped", `re-run create ${slug} to wait for it`);
      rep.result = { slug, state: box?.state };
      return;
    }
    box = await waitForProvision(ctx, slug, rep, { timeoutMin, pollSec });
  }
  let health = null;
  try {
    health = await admin(ctx, ["box", "health", slug]);
  } catch (err) {
    rep.warn(`box health unavailable: ${err.message}`);
  }
  rep.step("healthy", "ok", `${slug} is ${box.state} at ${box.publicUrl ?? "(no public URL yet)"}, release ${box.releaseTag}`);
  rep.result = { slug, state: box.state, publicUrl: box.publicUrl, releaseTag: box.releaseTag, purpose: box.purpose, lastHealth: health?.lastHealth ?? null };
  if (!ctx.json) ctx.out(`box ${slug}: ${box.state}, ${box.publicUrl}. Next: node scripts/hosted/internal-box.mjs claim ${slug} --name "<name>" --email ${email}`);
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

async function cmdClaim(ctx, { positional, flags }, rep) {
  const slug = positional[1];
  validateSlug(slug, { isNew: false });
  const name = flags.name?.trim();
  const email = flags.email?.trim();
  if (!name) throw new CliError("--name <founder name> is required", { code: 64 });
  if (!email || !EMAIL_RE.test(email)) throw new CliError("--email <founder email> is required", { code: 64 });
  const dry = Boolean(flags["dry-run"]);
  const timeoutMin = minutes(flags, "timeout", 15);
  const pollSec = minutes(flags, "poll", 15);
  const item = founderItem(slug);

  const box = await requireInternalBox(ctx, slug);
  if (!["awaiting_claim", "active"].includes(box.state)) {
    throw new CliError(`box ${slug} is ${box.state}; it can be claimed once it is awaiting_claim`, { fix: `node scripts/hosted/internal-box.mjs create ${slug} --email ${email} --release <tag>   (waits for it)` });
  }
  const rail = await railwayBoxVariables(ctx, slug);
  rep.step("railway", "ok", `read the box's variables (project ${BOX_PROJECT_PREFIX}${slug})`);
  const boxUrl = await resolveBoxUrl(ctx, slug, box, { flagUrl: flags["box-url"], railwayVars: rail.vars });
  const health = await boxHealth(ctx, boxUrl);
  const h = health.json ?? {};
  if (h.deploymentMode !== "authenticated" || h.hostedBox !== true) {
    throw new CliError(`box at ${boxUrl} is not an authenticated hosted box (deploymentMode ${h.deploymentMode}, hostedBox ${h.hostedBox}); refusing to claim it`);
  }
  rep.step("health", "ok", `${boxUrl} answers (release ${h.releaseTag ?? "?"}, claimed ${h.claimed})`);
  const claimCode = String(rail.vars.AGENTDASH_INVITE_CODES ?? "").split(",")[0].trim();
  // Set only when this run read the code BEFORE the account existed; on a resumed run the
  // variable may already hold the rotated value, so it proves nothing about rotation.
  let usedClaimCode = null;

  if (h.claimed === true) {
    const password = await keychainRead(ctx, item);
    if (!password) {
      throw new CliError(`box ${slug} is already claimed, and not by this tool (no Keychain item ${item}); nothing was done`, {
        fix: "find out who claimed it before going further; the founder's account is theirs",
      });
    }
    await boxSession(ctx, boxUrl, email, password, item);
    rep.step("founder", "exists", `already claimed; signed in as ${email} with the Keychain password`);
    if (!readState(ctx, slug).claimedAt) writeState(ctx, slug, { claimedAt: box.claimedAt ?? new Date(ctx.now()).toISOString() });
  } else {
    const bound = String(rail.vars.AGENTDASH_CLAIM_EMAIL ?? "").trim().toLowerCase();
    if (bound && bound !== email.toLowerCase()) {
      throw new CliError(`the box's claim is bound to ${bound}, not ${email}`, { fix: `re-run with --email ${bound} (the email given to create)` });
    }
    if (!claimCode) throw new CliError("the box has no claim code (AGENTDASH_INVITE_CODES is empty)", { fix: "check the box in Railway; the provisioner sets it" });
    ctx.secrets.add(claimCode);
    usedClaimCode = claimCode;
    if (dry) {
      rep.step("password", "planned", `generate a password and store it in the Keychain item ${item} (before the account exists)`);
      rep.step("founder", "planned", `POST ${boxUrl}/api/auth/sign-up/email for ${email} with the box's claim code`);
      rep.step("close-signup", "planned", "wait for the control plane's close_signup job, then railway redeploy until /api/health shows signUpDisabled");
      rep.result = { slug, boxUrl, planned: true };
      return;
    }
    let password = await keychainRead(ctx, item);
    if (password) rep.step("password", "exists", `reusing the password already in the Keychain item ${item}`);
    else {
      password = newPassword();
      await keychainWrite(ctx, { service: item, account: email, label: item, value: password });
      rep.step("password", "ok", `stored in the Keychain item ${item} (read back and verified)`);
    }
    writeState(ctx, slug, { boxUrl, founderEmail: email, founderName: name, keychainItem: item });
    const signup = await http(ctx, "POST", `${boxUrl}/api/auth/sign-up/email`, {
      body: { name, email, password, inviteCode: claimCode },
      headers: { origin: boxUrl },
    });
    if (!signup.ok) {
      const code = signup.json?.code ?? "";
      const why =
        code === "claim_email_mismatch" ? "the claim is bound to another email"
        : code === "claim_code_used" || signup.status === 409 ? "the box was claimed in the meantime"
        : signup.status === 429 ? "rate limited; wait 15 minutes and re-run"
        : describe(signup);
      throw new CliError(`the box refused the founder sign-up: ${why}`, { fix: `re-run claim ${slug} once the cause is fixed (the Keychain password is kept and reused)` });
    }
    await boxSession(ctx, boxUrl, email, password, item);
    rep.step("founder", "ok", `account ${email} created and signed in`);
    writeState(ctx, slug, { claimedAt: new Date(ctx.now()).toISOString() });
  }
  writeState(ctx, slug, { boxUrl, founderEmail: email, founderName: readState(ctx, slug).founderName ?? name, keychainItem: item });

  // Close sign-up the way hosted-box.md §7 does it: PAPERCLIP_AUTH_DISABLE_SIGN_UP=true and the
  // invite code rotated to an unrecorded value (the control plane's close_signup job, which the
  // claim sweep queues), then a redeploy so the closed door is live, not just configured.
  // The claim code itself died with the first account (server/src/lib/claim-code.ts).
  if (dry) {
    rep.step("close-signup", "planned", "wait for close_signup, then redeploy");
    rep.result = { slug, boxUrl, planned: true };
    return;
  }
  if (h.signUpDisabled === true) {
    rep.step("close-signup", "exists", "sign-up is already closed on the running box");
  } else {
    if (flags["no-wait"]) {
      rep.step("close-signup", "skipped", `re-run claim ${slug} to finish closing sign-up`);
      rep.result = { slug, boxUrl, signUpClosed: false };
      return;
    }
    const deadline = ctx.now() + timeoutMin * 60_000;
    let job = null;
    for (;;) {
      const now = await findBox(ctx, slug);
      job = await latestJob(ctx, slug, "close_signup");
      if (now?.claimedAt && job?.state === "succeeded") break;
      if (job?.state === "dead" || job?.state === "failed") throw new CliError(`the control plane's close_signup job ${job.state}: ${job.lastError ?? "see box events"}`, { fix: "investigate with admin jobs list failed; then re-run claim" });
      if (ctx.now() >= deadline) {
        throw new CliError(`the control plane has not closed sign-up yet (box ${now?.state}, close_signup ${job?.state ?? "not queued"}); its claim sweep runs every 10 minutes`, {
          fix: `re-run claim ${slug} to keep waiting; the claim code is already dead (the box has a user)`,
        });
      }
      rep.step("close-signup", "waiting", `box ${now?.state}${now?.claimedAt ? " (claim recorded)" : ""}, close_signup ${job?.state ?? "not queued yet"}`);
      await ctx.sleep(pollSec * 1000);
    }
    const after = await railwayBoxVariables(ctx, slug);
    // close-signup.ts writes all three in one upsert: sign-up off, a fresh unrecorded code, no claim email.
    if (after.vars.PAPERCLIP_AUTH_DISABLE_SIGN_UP !== "true") throw new CliError("close_signup succeeded but PAPERCLIP_AUTH_DISABLE_SIGN_UP is not true on the box");
    if (String(after.vars.AGENTDASH_CLAIM_EMAIL ?? "") !== "") throw new CliError("close_signup succeeded but AGENTDASH_CLAIM_EMAIL is still set on the box");
    if (usedClaimCode && String(after.vars.AGENTDASH_INVITE_CODES ?? "").split(",").includes(usedClaimCode)) throw new CliError("close_signup succeeded but the invite code was not rotated");
    rep.step("close-signup", "ok", "control plane set PAPERCLIP_AUTH_DISABLE_SIGN_UP=true and rotated the invite code");
    if (flags["no-redeploy"]) {
      rep.step("redeploy", "skipped", "the closed sign-up goes live at the box's next deploy");
    } else {
      const r = await railway(ctx, ["redeploy", "--service", "web", "--yes"], { cwd: after.dir });
      if (r.code !== 0) throw new CliError(`railway redeploy failed: ${r.stderr.trim()}`, { fix: `re-run claim ${slug}` });
      rep.step("redeploy", "ok", "requested; waiting for /api/health to show signUpDisabled");
      const until = ctx.now() + 15 * 60_000;
      for (;;) {
        const hh = await boxHealth(ctx, boxUrl);
        if (hh.ok && hh.json?.status === "ok" && hh.json?.signUpDisabled === true) break;
        if (ctx.now() >= until) throw new CliError("the box did not come back with sign-up disabled within 15 min", { fix: `check the deployment in Railway (project ${BOX_PROJECT_PREFIX}${slug}, service web), then re-run claim ${slug}` });
        await ctx.sleep(pollSec * 1000);
      }
      rep.step("redeploy", "ok", "box healthy with signUpDisabled true");
    }
  }
  const noCode = await http(ctx, "POST", `${boxUrl}/api/auth/sign-up/email`, {
    body: { name: "x", email: "stranger@example.com", password: "x-long-password-1" },
    headers: { origin: boxUrl },
  });
  if (noCode.ok) throw new CliError("SIGN-UP IS OPEN: a request without a code was accepted; take the box offline and investigate");
  rep.step("verify", "ok", `sign-up without a code is refused (HTTP ${noCode.status})`);
  writeState(ctx, slug, { signupClosedAt: new Date(ctx.now()).toISOString() });
  rep.result = { slug, boxUrl, founderEmail: email, keychainItem: item, signUpClosed: true };
  if (!ctx.json) ctx.out(`box ${slug} claimed by ${email} (password in Keychain item ${item}); sign-up closed. Next: move-company --to ${slug} ...`);
}

// ---------------------------------------------------------------------------
// move-company
// ---------------------------------------------------------------------------

function hostExecKeys(config) {
  return Object.keys(config && typeof config === "object" ? config : {}).filter((k) => HOST_EXEC_KEY_RE.test(k));
}

/** The hosted Hermes-only rule (doc/plans/2026-09-24-mvl-1.0.md D6) as import overrides and fix-ups. */
export function hermesPlan(manifest) {
  const agents = (manifest.agents ?? []).map((a) => ({
    slug: a.slug,
    name: a.name,
    from: a.adapterType,
    droppedConfigKeys: Object.keys(a.adapterConfig ?? {}),
    switches: a.adapterType !== HOSTED_ADAPTER,
  }));
  const adapterOverrides = Object.fromEntries(agents.map((a) => [a.slug, { adapterType: HOSTED_ADAPTER, adapterConfig: {} }]));
  const issueOverrides = (manifest.issues ?? [])
    .filter((i) => i.assigneeAdapterOverrides && Object.keys(i.assigneeAdapterOverrides.adapterConfig ?? {}).length > 0)
    .map((i) => ({ slug: i.slug, title: i.title }));
  return { agents, adapterOverrides, issueOverrides };
}

export function bundleCounts(manifest) {
  const issues = manifest.issues ?? [];
  return {
    agents: (manifest.agents ?? []).length,
    projects: (manifest.projects ?? []).length,
    issues: issues.filter((i) => !i.recurring).length,
    routines: issues.filter((i) => i.recurring).length,
    skills: (manifest.skills ?? []).length,
    goals: 0,
  };
}

export function verifyCounts(source, bundle, target) {
  const rows = ["agents", "projects", "issues"].map((k) => ({ entity: k, source: source[k], bundle: bundle[k], target: target[k], ok: target[k] === bundle[k] && bundle[k] === source[k] }));
  rows.push({ entity: "goals", source: source.goals, bundle: 0, target: target.goals, ok: target.goals >= source.goals, gap: source.goals > target.goals ? "the portability bundle does not carry goals" : null });
  return rows;
}

async function sourceClient(ctx, origin, flags) {
  let token = ctx.env.AGENTDASH_SOURCE_TOKEN?.trim() || null;
  let how = "env AGENTDASH_SOURCE_TOKEN";
  if (!token) {
    const item = flags["source-token-item"] ?? SOURCE_TOKEN_ITEM;
    token = await keychainRead(ctx, item);
    how = `Keychain item ${item}`;
  }
  if (token) ctx.secrets.add(token);
  else how = "no credential (local_trusted source)";
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const call = (method, p, body, timeoutMs) => http(ctx, method, `${origin}${p}`, { body, headers, timeoutMs });
  return { call, get: (p) => call("GET", p), how, hasToken: Boolean(token) };
}

async function cmdMoveCompany(ctx, { flags }, rep) {
  const slug = flags.to;
  validateSlug(slug, { isNew: false });
  if (!flags.from) throw new CliError("--from <source instance URL> is required", { code: 64 });
  if (!flags.company) throw new CliError("--company <id|name> is required", { code: 64 });
  const apply = Boolean(flags.apply) && !flags["dry-run"];
  const origin = checkInstanceUrl(flags.from, "--from");

  // Target first: refuse early if the box is not ours or not claimed by this tool.
  const box = await requireInternalBox(ctx, slug);
  const state = readState(ctx, slug);
  if (!state.founderEmail) throw new CliError(`box ${slug} has no founder recorded by this tool`, { fix: `node scripts/hosted/internal-box.mjs claim ${slug} --name "<name>" --email <email>` });
  const password = await keychainRead(ctx, founderItem(slug));
  if (!password) throw new CliError(`the Keychain item ${founderItem(slug)} is missing`, { fix: `re-run claim ${slug}` });
  const boxUrl = await resolveBoxUrl(ctx, slug, box, { flagUrl: flags["box-url"] });
  const target = await boxSession(ctx, boxUrl, state.founderEmail, password, founderItem(slug));
  rep.step("target", "ok", `${boxUrl} signed in as ${state.founderEmail}`);

  // Source: find the company, count it, export it.
  const src = await sourceClient(ctx, origin, flags);
  const list = await src.get("/api/companies");
  if (!list.ok) {
    throw new CliError(`could not list companies on ${origin}: ${describe(list)}`, {
      fix: list.status === 401 || list.status === 403 ? `mint a board key (pnpm paperclipai auth login) and store it: security add-generic-password -s ${flags["source-token-item"] ?? SOURCE_TOKEN_ITEM} -a "$USER" -w` : null,
    });
  }
  const wanted = flags.company.trim();
  const matches = (list.json ?? []).filter((c) => (UUID_RE.test(wanted) ? c.id === wanted : String(c.name).toLowerCase() === wanted.toLowerCase()));
  if (matches.length !== 1) {
    throw new CliError(matches.length ? `${matches.length} companies are named ${wanted}; pass its id` : `no company ${wanted} on ${origin}`, {
      fix: `companies there: ${(list.json ?? []).map((c) => `${c.name} (${c.id})`).join(", ") || "none visible to this credential"}`,
    });
  }
  const company = matches[0];
  rep.step("source", "ok", `${company.name} (${company.id}) on ${origin}, auth: ${src.how}`);
  const sourceCounts = (await companyCounts(src, company.id)).counts;
  const exp = await src.call("POST", `/api/companies/${company.id}/export`, { include: INCLUDE_ALL }, 180_000);
  if (!exp.ok || !exp.json?.manifest) throw new CliError(`export failed: ${describe(exp)}`);
  const bundle = exp.json;
  const counts = bundleCounts(bundle.manifest);
  const plan = hermesPlan(bundle.manifest);
  rep.step("export", "ok", `${counts.agents} agents, ${counts.projects} projects, ${counts.issues} issues, ${counts.routines} routines, ${counts.skills} skills`);
  for (const w of bundle.warnings ?? []) rep.warn(`export: ${w}`);
  const switching = plan.agents.filter((a) => a.switches);
  rep.step("hermes", "planned", `${plan.agents.length} agents to ${HOSTED_ADAPTER} with the box's defaults (${switching.length} switch adapter: ${switching.map((a) => `${a.slug} ${a.from}`).join(", ") || "none"}); ${plan.issueOverrides.length} issue adapter overrides cleared`);
  if (sourceCounts.goals > 0) rep.warn(`${sourceCounts.goals} goals will NOT move: the portability bundle does not carry goals; recreate them on the box`);

  // Target company: the one this tool created, an empty one, or a new one.
  const moveKey = `${origin}#${company.id}`;
  const record = state.moves?.[moveKey] ?? {};
  const boxCompanies = (await getOk(target, "/api/companies", "the box's companies")) ?? [];
  let targetCompany = boxCompanies.find((c) => c.id === record.targetCompanyId) ?? null;
  if (!targetCompany && boxCompanies.length > 1) throw new CliError(`the box holds ${boxCompanies.length} companies; a hosted box holds one`);
  if (!targetCompany && boxCompanies.length === 1) targetCompany = boxCompanies[0];
  const otherMove = targetCompany && Object.entries(state.moves ?? {}).find(([key, m]) => key !== moveKey && m.targetCompanyId === targetCompany.id);
  if (otherMove) {
    throw new CliError(`the box's company ${targetCompany.name} was moved here from ${otherMove[1].sourceName ?? otherMove[0]}; a hosted box holds one company`, {
      fix: "use a fresh internal box for this company",
    });
  }
  // Never import twice: a company with data and no recorded import (a run that died
  // between the import and the state write, or someone else's data) is adopted only
  // when it already matches the bundle exactly; anything else is refused.
  if (targetCompany && !record.imported) {
    const existing = (await companyCounts(target, targetCompany.id)).counts;
    const empty = existing.agents === 0 && existing.projects === 0 && existing.issues === 0;
    const matches = existing.agents === counts.agents && existing.projects === counts.projects && existing.issues === counts.issues;
    if (!empty && !matches) {
      throw new CliError(`the box already holds ${targetCompany.name} with data this tool did not record importing (${existing.agents} agents, ${existing.projects} projects, ${existing.issues} issues); refusing to import over it`, {
        fix: "move into a fresh internal box, or abandon this one (doc/runbooks/internal-box.md §6)",
      });
    }
    if (!empty) record.imported = "adopted (the box's company already matches the bundle)";
  }
  rep.step("box-company", targetCompany ? "exists" : "planned", targetCompany ? `${targetCompany.name} (${targetCompany.id})` : `create ${company.name} (its creator becomes instance admin)`);

  if (targetCompany && !record.imported) {
    const preview = await target.call("POST", "/api/companies/import/preview", {
      source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
      include: INCLUDE_ALL,
      target: { mode: "existing_company", companyId: targetCompany.id },
      collisionStrategy: "rename",
    }, 180_000);
    if (!preview.ok) throw new CliError(`import preview failed: ${describe(preview)}`);
    if (preview.json?.errors?.length) throw new CliError(`import preview has errors: ${preview.json.errors.join("; ")}`);
    rep.step("preview", "ok", `the box accepts the bundle (${preview.json?.warnings?.length ?? 0} warnings)`);
    for (const w of preview.json?.warnings ?? []) rep.warn(`preview: ${w}`);
  } else if (!targetCompany) {
    rep.step("preview", "skipped", "runs inside the import at --apply (the box has no company to preview against yet)");
  }

  if (!apply) {
    rep.result = { dryRun: true, source: { origin, companyId: company.id, name: company.name, counts: sourceCounts }, bundle: counts, hermes: plan.agents, issueOverrides: plan.issueOverrides, targetCompany: targetCompany ? { id: targetCompany.id, name: targetCompany.name } : null };
    if (!ctx.json) ctx.out(`dry run: nothing was written to the box. Re-run with --apply to move ${company.name} into ${slug}.`);
    return;
  }

  const saveRecord = () => writeState(ctx, slug, { moves: { ...(readState(ctx, slug).moves ?? {}), [moveKey]: { ...record, sourceName: company.name, bundle: counts, at: new Date(ctx.now()).toISOString() } } });
  if (!targetCompany) {
    const created = await target.call("POST", "/api/companies", { name: company.name, ...(company.description ? { description: company.description } : {}) });
    if (!created.ok) throw new CliError(`could not create the company on the box: ${describe(created)}`);
    targetCompany = created.json;
    rep.step("box-company", "ok", `created ${targetCompany.name} (${targetCompany.id})`);
  }
  record.targetCompanyId = targetCompany.id;
  saveRecord();

  if (record.imported) {
    rep.step("import", "exists", `already imported (${record.imported})`);
  } else {
    const imp = await target.call("POST", "/api/companies/import", {
      source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
      include: INCLUDE_ALL,
      target: { mode: "existing_company", companyId: targetCompany.id },
      collisionStrategy: "rename",
      adapterOverrides: plan.adapterOverrides,
    }, 300_000);
    if (!imp.ok) throw new CliError(`import failed: ${describe(imp)}`, { fix: "nothing is recorded as imported; fix the cause and re-run with --apply" });
    record.imported = new Date(ctx.now()).toISOString();
    saveRecord();
    rep.step("import", "ok", `${imp.json?.agents?.length ?? 0} agents, ${imp.json?.projects?.length ?? 0} projects into ${targetCompany.id}`);
    for (const w of imp.json?.warnings ?? []) rep.warn(`import: ${w}`);
  }

  // Hosted Hermes-only rule, enforced on what actually landed (a resumed run, or an import
  // that ignored an override, is fixed here): every agent on hermes_local with nothing that
  // picks a host binary, argv, env or cwd; no issue override carrying another adapter's config.
  let live = await companyCounts(target, targetCompany.id);
  let agentsFixed = 0;
  let issuesFixed = 0;
  for (const a of live.agents) {
    const stray = hostExecKeys(a.adapterConfig);
    if (a.adapterType === HOSTED_ADAPTER && stray.length === 0) continue;
    if (a.adapterType !== HOSTED_ADAPTER) {
      const r = await target.call("PATCH", `/api/agents/${a.id}`, { adapterType: HOSTED_ADAPTER, adapterConfig: {} });
      if (!r.ok) throw new CliError(`could not switch agent ${a.name} to ${HOSTED_ADAPTER}: ${describe(r)}`);
      a.adapterConfig = r.json?.adapterConfig ?? {};
    }
    const left = hostExecKeys(a.adapterConfig);
    if (left.length) {
      const kept = Object.fromEntries(Object.entries(a.adapterConfig).filter(([k]) => !HOST_EXEC_KEY_RE.test(k)));
      const r = await target.call("PATCH", `/api/agents/${a.id}`, { adapterConfig: kept, replaceAdapterConfig: true });
      if (!r.ok) throw new CliError(`could not clear ${left.join(", ")} on agent ${a.name}: ${describe(r)}`);
    }
    agentsFixed += 1;
  }
  for (const i of live.issues) {
    const o = i.assigneeAdapterOverrides;
    if (!o || !o.adapterConfig || Object.keys(o.adapterConfig).length === 0) continue;
    const { adapterConfig: _drop, ...rest } = o;
    const r = await target.call("PATCH", `/api/issues/${i.id}`, { assigneeAdapterOverrides: Object.keys(rest).length ? rest : null });
    if (!r.ok) throw new CliError(`could not clear the adapter override on issue ${i.identifier ?? i.id}: ${describe(r)}`);
    issuesFixed += 1;
  }
  record.hermes = new Date(ctx.now()).toISOString();
  saveRecord();
  rep.step("hermes", "ok", `every agent on ${HOSTED_ADAPTER}; ${agentsFixed} agents switched or stripped after import, ${issuesFixed} issue adapter overrides cleared`);

  live = await companyCounts(target, targetCompany.id);
  const notHermes = live.agents.filter((a) => a.adapterType !== HOSTED_ADAPTER || hostExecKeys(a.adapterConfig).length > 0);
  const rows = verifyCounts(sourceCounts, counts, live.counts);
  rep.result = { source: { origin, companyId: company.id, name: company.name }, targetCompanyId: targetCompany.id, verification: rows, gaps: rows.filter((r) => r.gap).map((r) => `${r.entity}: ${r.gap}`) };
  for (const r of rows) rep.step(`verify ${r.entity}`, r.ok ? "ok" : r.gap ? "gap" : "FAIL", `source ${r.source}, bundle ${r.bundle}, box ${r.target}${r.gap ? ` (${r.gap})` : ""}`);
  const bad = rows.filter((r) => !r.ok && !r.gap);
  if (bad.length || notHermes.length) {
    throw new CliError(`verification failed: ${[...bad.map((r) => `${r.entity} ${r.target}/${r.bundle}`), ...notHermes.map((a) => `agent ${a.name} on ${a.adapterType}`)].join(", ")}`, {
      fix: "inspect the box; the move is recorded as imported but not verified, so re-running --apply re-checks without importing twice",
    });
  }
  record.verified = new Date(ctx.now()).toISOString();
  saveRecord();
  if (!ctx.json) ctx.out(`moved ${company.name} into ${slug} (${targetCompany.id}); counts verified${rep.result.gaps.length ? `; gaps: ${rep.result.gaps.join("; ")}` : ""}. Next: configure ${slug} --provider <name>`);
}

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

async function cmdConfigure(ctx, { positional, flags }, rep) {
  const slug = positional[1];
  validateSlug(slug, { isNew: false });
  const provider = flags.provider;
  if (!HERMES_PROVIDERS.includes(provider)) throw new CliError(`--provider must be one of ${HERMES_PROVIDERS.join(", ")}`, { code: 64 });
  const dry = Boolean(flags["dry-run"]);
  const item = providerItem(provider);
  const box = await requireInternalBox(ctx, slug);
  const state = readState(ctx, slug);
  if (!state.founderEmail) throw new CliError(`box ${slug} has no founder recorded by this tool`, { fix: `run claim ${slug} first` });
  if (!(await keychainExists(ctx, item))) {
    throw new CliError(`the Keychain item ${item} is missing`, { fix: `security add-generic-password -s ${item} -a "$USER" -w   (paste the ${provider} API key at the prompt)` });
  }
  const password = await keychainRead(ctx, founderItem(slug));
  if (!password) throw new CliError(`the Keychain item ${founderItem(slug)} is missing`, { fix: `re-run claim ${slug}` });
  const boxUrl = await resolveBoxUrl(ctx, slug, box, { flagUrl: flags["box-url"] });
  const api = await boxSession(ctx, boxUrl, state.founderEmail, password, founderItem(slug));
  const companies = (await getOk(api, "/api/companies", "the box's companies")) ?? [];
  const company = flags.company ? companies.find((c) => c.id === flags.company) : companies.length === 1 ? companies[0] : null;
  if (!company) {
    throw new CliError(companies.length ? "pass --company <id>: the box holds more than one company" : "the box has no company yet; the key is stored per company", {
      fix: `node scripts/hosted/internal-box.mjs move-company --from <url> --to ${slug} --company <id|name> --apply`,
    });
  }
  const status = await getOk(api, "/api/onboarding/adapter-status", "the adapter status");
  const hp = status?.hermesProvider ?? {};
  if (hp.canConfigure === false) {
    throw new CliError(`${state.founderEmail} is not the box's instance admin, which setting the key needs`, { fix: "the first company's creator becomes instance admin: create it through move-company --apply" });
  }
  const sameModel = !flags.model || hp.model === flags.model;
  if (hp.configured && hp.provider === provider && sameModel && !flags.rotate) {
    rep.step("provider", "exists", `${provider} already configured (model ${hp.model}); pass --rotate to set the key again`);
    rep.result = { slug, provider, model: hp.model, changed: false };
    return;
  }
  if (dry) {
    rep.step("provider", "planned", `POST /api/onboarding/setup-adapter {preset: hermes, provider: ${provider}${flags.model ? `, model: ${flags.model}` : ""}} for ${company.name}, key from ${item}`);
    rep.result = { slug, provider, planned: true };
    return;
  }
  const apiKey = await keychainRead(ctx, item);
  if (!apiKey) throw new CliError(`the Keychain item ${item} is empty`);
  const r = await api.call("POST", "/api/onboarding/setup-adapter", { preset: "hermes", provider, apiKey, companyId: company.id, ...(flags.model ? { model: flags.model } : {}) }, 120_000);
  if (!r.ok) {
    throw new CliError(`the box refused the provider key: ${r.json?.code ?? ""} ${describe(r)}`.trim(), {
      fix: r.json?.code === "provider_key_rejected" ? `the provider rejected the key; update ${item} and re-run` : null,
    });
  }
  rep.step("provider", "ok", `${r.json?.hermesProvider?.label ?? provider}, model ${r.json?.hermesProvider?.model}, ${r.json?.profilesUpdated ?? 0} profiles updated`);
  const health = await boxHealth(ctx, boxUrl);
  if (health.json?.adapterReady !== true) rep.warn(`box reports adapterReady ${health.json?.adapterReady}`);
  writeState(ctx, slug, { provider: { name: provider, model: r.json?.hermesProvider?.model ?? null, at: new Date(ctx.now()).toISOString() } });
  rep.result = { slug, provider, model: r.json?.hermesProvider?.model ?? null, changed: true, adapterReady: health.json?.adapterReady ?? null };
  if (!ctx.json) ctx.out(`box ${slug}: Hermes provider ${provider} configured. Check with: node scripts/hosted/internal-box.mjs status ${slug}`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function ago(iso, now) {
  if (!iso) return "never";
  const h = (now - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(0, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
}

export function summarizeBackups(backups, now) {
  const list = backups ?? [];
  const good = list.filter((b) => b.state === "succeeded" && !b.prunedAt).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  const latest = [...list].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] ?? null;
  return {
    count: good.length,
    latestGood: good[0] ? { id: good[0].id, finishedAt: good[0].finishedAt, sizeBytes: good[0].sizeBytes, release: good[0].release, age: ago(good[0].finishedAt, now) } : null,
    latestAttempt: latest ? { state: latest.state, startedAt: latest.startedAt, error: latest.error ?? null } : null,
  };
}

export function formatStatus(s) {
  const lines = [];
  const b = s.box;
  lines.push(`box       ${b.slug}  purpose ${b.purpose}  state ${b.state}  release ${b.releaseTag ?? "?"}${b.holdUpgrades ? "  (upgrades held)" : ""}`);
  lines.push(`url       ${b.publicUrl ?? "(none yet)"}${s.local.boxUrl && s.local.boxUrl !== b.publicUrl ? `  (this tool uses ${s.local.boxUrl})` : ""}`);
  lines.push(`claimed   ${b.claimedAt ?? "no"}${s.local.founderEmail ? `  founder ${s.local.founderEmail}` : ""}`);
  const paths = (s.health?.paths ?? []).map((p) => `${p.path} ${p.status}${p.consecutiveFailures ? ` (${p.consecutiveFailures} failures)` : ""}`);
  lines.push(`health    ${paths.join(", ") || "no polls yet"}`);
  const alerts = s.health?.firingAlerts ?? [];
  lines.push(`alerts    ${alerts.length ? alerts.map((a) => a.subject).join("; ") : "none firing"}`);
  const k = s.backups;
  lines.push(`backups   ${k.count} kept; latest good ${k.latestGood ? `${k.latestGood.finishedAt} (${k.latestGood.age})` : "none"}; last attempt ${k.latestAttempt ? `${k.latestAttempt.state}${k.latestAttempt.error ? `: ${k.latestAttempt.error}` : ""}` : "none"}`);
  const moves = Object.entries(s.local.moves ?? {}).map(([key, m]) => `${m.sourceName ?? key} -> ${m.targetCompanyId ?? "?"} (${m.verified ? "verified" : m.imported ? "imported, not verified" : "started"})`);
  lines.push(`moves     ${moves.join("; ") || "none"}`);
  lines.push(`provider  ${s.local.provider ? `${s.local.provider.name} (${s.local.provider.model ?? "default model"})` : "not configured by this tool"}`);
  return lines;
}

async function cmdStatus(ctx, { positional }, rep) {
  const slug = positional[1];
  validateSlug(slug, { isNew: false });
  const box = await findBox(ctx, slug);
  if (!box) throw new CliError(`no box ${slug} in the control plane`);
  const health = await admin(ctx, ["box", "health", slug]).catch((err) => ({ error: err.message }));
  const backups = await admin(ctx, ["backups", "list", slug]).catch((err) => ({ error: err.message, backups: [] }));
  const local = readState(ctx, slug);
  const s = {
    box: { slug: box.slug, purpose: box.purpose, state: box.state, releaseTag: box.releaseTag, holdUpgrades: box.holdUpgrades, publicUrl: box.publicUrl, claimedAt: box.claimedAt, planTier: box.planTier },
    health: health.error ? { error: health.error } : { paths: health.paths ?? [], firingAlerts: health.firingAlerts ?? [], lastHealth: health.lastHealth ?? null, recentEvents: (health.recentEvents ?? []).slice(0, 5) },
    backups: { ...summarizeBackups(backups.backups, ctx.now()), ...(backups.error ? { error: backups.error } : {}) },
    local: { boxUrl: local.boxUrl ?? null, founderEmail: local.founderEmail ?? null, signupClosedAt: local.signupClosedAt ?? null, moves: local.moves ?? {}, provider: local.provider ?? null },
  };
  if (box.purpose !== "internal") rep.warn(`box ${slug} is a ${box.purpose} box, not internal`);
  rep.result = s;
  if (!ctx.json) for (const l of formatStatus(s)) ctx.out(l);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const COMMANDS = { preflight: cmdPreflight, create: cmdCreate, claim: cmdClaim, "move-company": cmdMoveCompany, configure: cmdConfigure, status: cmdStatus };

/** Runs one command; returns the exit code. Everything printed goes through the secret scrubber. */
export async function run(argv, deps = {}) {
  const ctx = makeContext(deps);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    ctx.rawErr(err.message);
    if (err.fix) ctx.rawErr(`fix: ${err.fix}`);
    return err.code ?? 64;
  }
  ctx.json = Boolean(parsed.flags.json);
  const command = parsed.positional[0];
  if (parsed.flags.help || !command) {
    ctx.rawOut(USAGE);
    return command || parsed.flags.help ? 0 : 64;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    ctx.rawErr(`unknown command ${command}\n\n${USAGE}`);
    return 64;
  }
  const rep = new Report(ctx, command);
  let code = 0;
  let error = null;
  try {
    await fn(ctx, parsed, rep);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError(err?.message ?? String(err));
    error = { message: e.message, fix: e.fix ?? null };
    code = e.code ?? 1;
    if (!ctx.json) {
      ctx.rawErr(ctx.secrets.scrub(`error: ${e.message}`));
      if (e.fix) ctx.rawErr(ctx.secrets.scrub(`fix: ${e.fix}`));
    }
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: code === 0, command, dryRun: Boolean(parsed.flags["dry-run"]) || (command === "move-company" && !parsed.flags.apply), steps: rep.steps, warnings: rep.warnings, result: rep.result, error }, null, 2));
  }
  return code;
}

// Realpaths on both sides (GH #666, scripts/entry-guard.test.mjs): a symlinked invocation must still run.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`internal-box: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
