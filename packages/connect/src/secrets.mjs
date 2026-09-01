/**
 * Where the key lives.
 *
 * Codex references its bearer token through an environment variable and never
 * stores it, which is the better design and the one we build around: the secret
 * goes in the OS keychain, and the shell reads it back at login. That keeps it
 * out of dotfiles and out of shell history, and `--remove` can actually delete
 * it.
 *
 * One honest caveat: `security add-generic-password` takes the secret as an
 * argument, so it is briefly visible in `ps` to this same user during the write
 * -- macOS offers no stdin form. Reads do not have this problem. It is a
 * sub-second, same-user exposure at enrolment only, which beats the alternative
 * of leaving the key in a dotfile for its whole life, but it is not nothing and
 * should not be described as nothing.
 *
 * Claude Code stores the literal value in ~/.claude.json instead. We cannot
 * change that, so we do not pretend otherwise -- the CLI says so plainly and
 * tightens the file mode.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FALLBACK_DIR = path.join(os.homedir(), ".agentdash");

/**
 * The timeout is not paranoia. `security` blocks indefinitely when the keychain
 * is locked, absent, or wants a GUI confirmation -- which is exactly what
 * happens over SSH, on a fresh login, and in any headless or MDM-driven
 * install. Without a deadline the installer simply stops, with no output and
 * nothing on screen to explain it. A timeout turns that into a fallback.
 */
function runQuietly(command, args, input, timeoutMs = 10_000) {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  return {
    ok: !result.error && !timedOut && result.status === 0,
    stdout: result.stdout ?? "",
    timedOut,
  };
}

function fallbackPath(account) {
  return path.join(FALLBACK_DIR, `${account}.key`);
}

/**
 * Store a secret. Returns which backend took it, so the CLI can tell the truth
 * about where the key ended up rather than claiming a keychain it did not use.
 * @returns {"keychain"|"file"}
 */
export function storeSecret(account, secret) {
  if (process.platform === "darwin") {
    // -U updates in place instead of failing on an existing item. The secret
    // goes via -w because `security` has no stdin form; see the caveat above.
    const stored = runQuietly("security", [
      "add-generic-password",
      "-a", account,
      "-s", "agentdash-connect",
      "-U",
      "-w", secret,
    ]);
    if (stored.ok) return "keychain";
  }
  fs.mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fallbackPath(account), `${secret}\n`, { mode: 0o600 });
  return "file";
}

/** @returns {string|null} */
export function readSecret(account) {
  if (process.platform === "darwin") {
    const found = runQuietly("security", [
      "find-generic-password",
      "-a", account,
      "-s", "agentdash-connect",
      "-w",
    ]);
    if (found.ok && found.stdout.trim()) return found.stdout.trim();
  }
  try {
    return fs.readFileSync(fallbackPath(account), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** @returns {boolean} whether anything was actually deleted */
export function deleteSecret(account) {
  let removed = false;
  if (process.platform === "darwin") {
    removed = runQuietly("security", [
      "delete-generic-password",
      "-a", account,
      "-s", "agentdash-connect",
    ]).ok;
  }
  try {
    fs.unlinkSync(fallbackPath(account));
    removed = true;
  } catch {
    // Nothing on disk is the normal case when the keychain held it.
  }
  return removed;
}

/**
 * The one line a shell profile needs so Codex can resolve the env var it was
 * told to read. Kept to a single, greppable, self-describing line so that
 * removing it -- by hand or by `--remove` -- is unambiguous.
 */
export function shellProfileLine(envVar, account, backend) {
  const read = backend === "keychain"
    ? `$(security find-generic-password -a ${account} -s agentdash-connect -w 2>/dev/null)`
    : `$(cat "$HOME/.agentdash/${account}.key" 2>/dev/null)`;
  return `export ${envVar}="${read}"  # agentdash-connect:${account}`;
}

export function profileLineMarker(account) {
  return `# agentdash-connect:${account}`;
}

/** Add the line if absent; never duplicate it. Returns true when it wrote. */
export function ensureProfileLine(profilePath, line, marker) {
  let current = "";
  try {
    current = fs.readFileSync(profilePath, "utf8");
  } catch {
    // A profile that does not exist yet is fine; we are about to create it.
  }
  if (current.includes(marker)) {
    const rewritten = current
      .split("\n")
      .map((existing) => (existing.includes(marker) ? line : existing))
      .join("\n");
    if (rewritten === current) return false;
    fs.writeFileSync(profilePath, rewritten);
    return true;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(profilePath, `${prefix}${line}\n`);
  return true;
}

/** Strip our line back out. Returns true when something was removed. */
export function removeProfileLine(profilePath, marker) {
  let current;
  try {
    current = fs.readFileSync(profilePath, "utf8");
  } catch {
    return false;
  }
  if (!current.includes(marker)) return false;
  const kept = current.split("\n").filter((line) => !line.includes(marker));
  fs.writeFileSync(profilePath, kept.join("\n"));
  return true;
}
