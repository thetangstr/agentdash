// AgentDash: who may run a hermes_local agent over an SSH execution
// environment, and how AgentDash connects when it does.
//
// Off by default. Two instance-level settings, both plain environment
// variables so an operator changes them by editing config, never code:
//
//   AGENTDASH_HERMES_SSH_ENABLED=true
//   AGENTDASH_HERMES_SSH_ALLOWLIST={"ac-provider@127.0.0.1":{"companies":["<uuid>"],
//     "identityFile":"/abs/key","knownHostsFile":"/abs/known_hosts","port":22}}
//
// A hermes agent may be pinned to, and launched on, an SSH environment only
// when the environment names a user@host:port that is on the allowlist for the
// agent's company. The key file, known_hosts file and port come from the
// allowlist entry, never from the company's environment. With the flag off a
// Hermes agent on any SSH environment is refused (never run locally instead).
// Provisioning the OS user on the far side is the operator's job
// (doc/HERMES-SSH-ENVIRONMENTS.md).
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { forbidden, unprocessable } from "../errors.js";

export const HERMES_SSH_ENABLED_ENV = "AGENTDASH_HERMES_SSH_ENABLED";
export const HERMES_SSH_ALLOWLIST_ENV = "AGENTDASH_HERMES_SSH_ALLOWLIST";

const SSH_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hermesSshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERMES_SSH_ENABLED_ENV] === "true";
}

/** POSIX-portable login name: lowercase, digits, `_`, `-`; never starts with `-`. */
export function isValidSshUsername(value: string): boolean {
  return SSH_USERNAME_RE.test(value);
}

/** IPv4 literal or DNS hostname (lowercase). No ports, brackets, or leading `-`. */
export function isValidSshHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return IPV4_RE.test(value) || HOSTNAME_RE.test(value);
}

export interface HermesSshAllowlistEntry {
  username: string;
  host: string;
  /** Operator-chosen; the environment's port must match. Defaults to 22. */
  port: number;
  /** `username@host`, as written in config. */
  target: string;
  companyIds: string[];
  /** Operator-chosen absolute path of the dedicated ed25519 key on this server. */
  identityFile: string;
  /** Operator-chosen absolute path of the pinned known_hosts file on this server. */
  knownHostsFile: string;
}

export interface HermesSshAllowlist {
  entries: HermesSshAllowlistEntry[];
  /** Entries that were skipped, in operator words. Never fatal: a bad entry allows nothing. */
  problems: string[];
}

function parseTarget(target: string): { username: string; host: string } | null {
  const at = target.indexOf("@");
  if (at <= 0 || at !== target.lastIndexOf("@")) return null;
  const username = target.slice(0, at);
  const host = target.slice(at + 1).toLowerCase();
  if (!isValidSshUsername(username) || !isValidSshHost(host)) return null;
  return { username, host };
}

function readAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0") || trimmed.includes("\n")) return null;
  return path.normalize(trimmed);
}

/**
 * The allowlist is operator config, never tenant data. Shape:
 *   {"user@host": {"companies": ["<uuid>"], "identityFile": "/abs", "knownHostsFile": "/abs", "port": 22}}
 * The key file, known_hosts file, user, host and port all come from here; a
 * company's SSH environment can only NAME an allowlisted user@host:port.
 */
export function readHermesSshAllowlist(env: NodeJS.ProcessEnv = process.env): HermesSshAllowlist {
  const raw = env[HERMES_SSH_ALLOWLIST_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return { entries: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      problems: [`${HERMES_SSH_ALLOWLIST_ENV} is not valid JSON; no SSH targets are allowed.`],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      entries: [],
      problems: [`${HERMES_SSH_ALLOWLIST_ENV} must be a JSON object keyed by "user@host".`],
    };
  }
  const entries: HermesSshAllowlistEntry[] = [];
  const problems: string[] = [];
  for (const [target, value] of Object.entries(parsed as Record<string, unknown>)) {
    const skip = (why: string) => problems.push(`Skipped allowlist entry ${JSON.stringify(target)}: ${why}`);
    const parsedTarget = parseTarget(target.trim());
    if (!parsedTarget) {
      skip("expected user@host.");
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skip("expected an object with companies, identityFile and knownHostsFile.");
      continue;
    }
    const record = value as Record<string, unknown>;
    const companyIds = Array.isArray(record.companies) ? record.companies : null;
    if (!companyIds || companyIds.length === 0 || !companyIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      skip("expected companies to be a list of company ids.");
      continue;
    }
    const identityFile = readAbsolutePath(record.identityFile);
    const knownHostsFile = readAbsolutePath(record.knownHostsFile);
    if (!identityFile || !knownHostsFile) {
      skip("expected identityFile and knownHostsFile as absolute paths.");
      continue;
    }
    const port = record.port === undefined ? 22 : record.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      skip("expected port to be a whole number from 1 to 65535.");
      continue;
    }
    entries.push({
      ...parsedTarget,
      port,
      target: `${parsedTarget.username}@${parsedTarget.host}`,
      companyIds: (companyIds as string[]).map((id) => id.toLowerCase()),
      identityFile,
      knownHostsFile,
    });
  }
  return { entries, problems };
}

export type HermesSshDecision =
  | { ok: true; target: string; entry: HermesSshAllowlistEntry }
  | { ok: false; status: 403 | 422; message: string };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const HERMES_SSH_DISABLED_MESSAGE =
  "Hermes over SSH is turned off on this server, so this agent's SSH environment can't be used. Nothing was run.";

/**
 * Decide whether a hermes agent in `companyId` may use an SSH environment that
 * names this user@host:port. Pure: reads only the given env (defaults to
 * process.env). The environment supplies the target NAME only; everything
 * used to connect comes from the matching allowlist entry.
 */
export function evaluateHermesSshEnvironment(
  input: { companyId: string; config: Record<string, unknown> | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): HermesSshDecision {
  if (!hermesSshEnabled(env)) {
    return { ok: false, status: 422, message: HERMES_SSH_DISABLED_MESSAGE };
  }
  const config = input.config ?? {};
  const username = readString(config.username) ?? "";
  const host = (readString(config.host) ?? "").toLowerCase();
  if (!isValidSshUsername(username) || !isValidSshHost(host)) {
    return {
      ok: false,
      status: 422,
      message:
        "This SSH environment's user or host isn't in a form AgentDash accepts for Hermes agents " +
        "(expected something like ac-provider@127.0.0.1).",
    };
  }
  const target = `${username}@${host}`;
  const entry = readHermesSshAllowlist(env).entries.find(
    (candidate) => candidate.username === username && candidate.host === host,
  );
  if (!entry) {
    return {
      ok: false,
      status: 403,
      message:
        `Hermes agents can't run as ${target} on this server: that SSH account isn't on the server's allowed list. ` +
        "Ask whoever runs this server to add it.",
    };
  }
  if (!entry.companyIds.includes(input.companyId.toLowerCase())) {
    return {
      ok: false,
      status: 403,
      message:
        `This company's Hermes agents aren't allowed to run as ${target}. ` +
        "Ask whoever runs this server to allow it for this company.",
    };
  }
  const rawPort = config.port === undefined || config.port === null || config.port === "" ? 22 : Number(config.port);
  if (rawPort !== entry.port) {
    return {
      ok: false,
      status: 403,
      message: `Hermes agents may run as ${target} only on SSH port ${entry.port}; this environment uses port ${String(config.port)}.`,
    };
  }
  return { ok: true, target, entry };
}

/**
 * The connection AgentDash uses for an approved target: every credential and
 * pinning input from operator config, nothing from the company's environment.
 */
export function hermesSshConnectionFor(entry: HermesSshAllowlistEntry) {
  return {
    host: entry.host,
    port: entry.port,
    username: entry.username,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true as const,
    identityFile: entry.identityFile,
    knownHostsFile: entry.knownHostsFile,
  };
}

/** Route guard: throws the decision as an HTTP error. Returns the `user@host` it allowed. */
export function assertHermesSshEnvironmentPermitted(input: {
  companyId: string;
  config: Record<string, unknown> | null | undefined;
}): { target: string } {
  const decision = evaluateHermesSshEnvironment(input);
  if (decision.ok) return { target: decision.target };
  throw decision.status === 403 ? forbidden(decision.message) : unprocessable(decision.message);
}

/**
 * Launch-time check of the files the hardened ssh argv points at. Reads only
 * public material (the `.pub` next to the key, and known_hosts); the private
 * key is checked for existence, never read.
 */
export async function assertHermesSshLaunchReady(input: {
  identityFile: string;
  knownHostsFile: string;
}): Promise<void> {
  try {
    const keyStat = await fs.stat(input.identityFile);
    if (!keyStat.isFile()) throw new Error("not a file");
  } catch {
    throw new Error("The SSH key file the server's allowlist names for this target isn't there.");
  }
  let publicKey: string;
  try {
    publicKey = await fs.readFile(`${input.identityFile}.pub`, "utf8");
  } catch {
    throw new Error(
      "Hermes over SSH needs the public half of the key (the .pub file) next to the key file to confirm it is ed25519.",
    );
  }
  if (!publicKey.trimStart().startsWith("ssh-ed25519 ")) {
    throw new Error("Hermes over SSH needs a dedicated ed25519 key; this environment's key is a different type.");
  }
  let knownHosts: string;
  try {
    await fs.access(input.knownHostsFile, fsConstants.R_OK);
    knownHosts = await fs.readFile(input.knownHostsFile, "utf8");
  } catch {
    throw new Error("The pinned known_hosts file the server's allowlist names for this target can't be read.");
  }
  const pinned = knownHosts
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
  if (!pinned) {
    throw new Error("The known_hosts file the server's allowlist names for this target doesn't pin any host key.");
  }
}
